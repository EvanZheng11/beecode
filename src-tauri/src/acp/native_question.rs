//! 原生 ACP 提问的等待策略；权限审批不经过这里。

use super::question::{
    QuestionAnswer, QuestionAnswerItem, QuestionConfig, QuestionDeadline, QuestionOutcome,
    QuestionSpec, RegisteredQuestion, SessionQuestionAccess,
};
use std::{future::Future, sync::Arc, time::Duration};

pub(super) struct NativeQuestion {
    access: Arc<dyn SessionQuestionAccess>,
    connection_id: String,
    specs: Vec<QuestionSpec>,
    config: QuestionConfig,
    registered: RegisteredQuestion,
    current_id: Arc<std::sync::Mutex<String>>,
}

/// 等原生 responder 确认写出后再释放回执；不能在 wait() 返回时过早确认。
pub(super) struct NativeQuestionDelivery {
    access: Arc<dyn SessionQuestionAccess>,
    connection_id: String,
    current_id: Arc<std::sync::Mutex<String>>,
}

impl NativeQuestionDelivery {
    pub(super) async fn complete(self, delivered: bool) {
        let id = self.current_id.lock().unwrap().clone();
        if delivered {
            self.access.confirm_question_answer(&self.connection_id, &id).await;
        } else {
            self.access.mark_question_host_abandoned(&self.connection_id, &id).await;
        }
    }
}

impl NativeQuestion {
    pub(super) async fn register(
        access: Arc<dyn SessionQuestionAccess>,
        connection_id: &str,
        specs: Vec<QuestionSpec>,
        config: QuestionConfig,
    ) -> Option<Self> {
        let registered = access
            .register_native_question_with_timeout(
                connection_id,
                specs.clone(),
                Duration::from_secs(u64::from(config.wait_timeout_minutes) * 60),
            )
            .await?;
        let current_id = Arc::new(std::sync::Mutex::new(registered.question_id.clone()));
        Some(Self {
            access,
            connection_id: connection_id.to_owned(),
            specs,
            config,
            registered,
            current_id,
        })
    }

    pub(super) fn delivery(&self) -> NativeQuestionDelivery {
        NativeQuestionDelivery {
            access: self.access.clone(),
            connection_id: self.connection_id.clone(),
            current_id: self.current_id.clone(),
        }
    }

    pub(super) async fn wait(
        self,
        cancellation: impl Future<Output = ()>,
    ) -> Option<QuestionOutcome> {
        self.wait_with_local_abort(cancellation, std::future::pending())
            .await
    }

    pub(super) async fn wait_with_local_abort(
        mut self,
        cancellation: impl Future<Output = ()>,
        local_abort: impl Future<Output = ()>,
    ) -> Option<QuestionOutcome> {
        tokio::pin!(cancellation, local_abort);
        let started = tokio::time::Instant::now();
        for round in 0..=self.config.retry_count {
            // 测试桩可不提供期限，生产注册入口始终提供共享句柄。
            let deadline = self.registered.deadline.clone().unwrap_or_else(|| {
                QuestionDeadline::from_now(Duration::from_secs(
                    u64::from(self.config.wait_timeout_minutes) * 60,
                ))
            });
            let mut changes = deadline.subscribe();
            loop {
                let at = deadline.current().map(|point| point.at);
                tokio::select! {
                    biased;
                    () = &mut local_abort => {
                        // 本地清理只撤本题，不把 Stop/替换消息误记为耗尽。
                        if !self.registered.upstream_closed.load(std::sync::atomic::Ordering::Acquire) {
                            self.access.cancel_question(&self.connection_id, &self.registered.question_id).await;
                        }
                        return None;
                    }
                    () = &mut cancellation => {
                        if self.specs.iter().any(|question| question.is_secret) {
                            self.access.cancel_question(&self.connection_id, &self.registered.question_id).await;
                            return None;
                        }
                        self.registered.upstream_closed.store(true, std::sync::atomic::Ordering::Release);
                        // 上游撤回：宿主已经不要这个答案了（RPC 期限、会话关闭或宿主
                        // 自己取消）。保留卡片与注册表条目，用户作答后由
                        // `answer_question` 以用户消息补送 —— 否则卡片会凭空消失。
                        // Stop/断连走 `local_abort`，那时条目已被收走，这里会返回 false。
                        let kept = self
                            .access
                            .mark_question_host_abandoned(
                                &self.connection_id,
                                &self.registered.question_id,
                            )
                            .await;
                        tracing::warn!(
                            connection_id = %self.connection_id,
                            question_id = %self.registered.question_id,
                            elapsed_ms = started.elapsed().as_millis() as u64,
                            configured_wait_minutes = self.config.wait_timeout_minutes,
                            configured_deadline = ?deadline.expires_at(),
                            round,
                            retry_count = self.config.retry_count,
                            kept_pending = kept,
                            "原生提问上游撤回（宿主放弃这次询问）；保留卡片，答案改以用户消息投递"
                        );
                        return None;
                    }
                    answer = &mut self.registered.answer_rx => {
                        if answer.is_err() {
                            tracing::debug!(connection_id = %self.connection_id, question_id = %self.registered.question_id, "原生提问注册表已取消（Stop/回合结束/断连）");
                        }
                        if answer.is_ok() {
                            // 同时就绪的上游撤回优先于将答案视为已送达。
                            tokio::select! {
                                biased;
                                () = &mut cancellation => {
                                    self.registered.upstream_closed.store(true, std::sync::atomic::Ordering::Release);
                                    self.access.mark_question_host_abandoned(&self.connection_id, &self.registered.question_id).await;
                                    return None;
                                }
                                () = std::future::ready(()) => {}
                            }
                        }
                        return answer.ok();
                    }
                    _ = changes.changed() => {
                        if self.registered.upstream_closed.load(std::sync::atomic::Ordering::Acquire) {
                            return None;
                        }
                        continue;
                    },
                    () = async {
                        match at {
                            Some(at) => tokio::time::sleep_until(at).await,
                            None => std::future::pending().await,
                        }
                    } => {
                        if deadline.is_expired() { break; }
                    }
                }
            }
            tracing::info!(
                connection_id = %self.connection_id,
                question_id = %self.registered.question_id,
                round,
                retry_count = self.config.retry_count,
                "原生提问已到配置期限"
            );
            if round < self.config.retry_count {
                let next = self
                    .access
                    .retry_native_question_with_timeout(
                        &self.connection_id,
                        &self.registered.question_id,
                        self.specs.clone(),
                        Duration::from_secs(u64::from(self.config.wait_timeout_minutes) * 60),
                    )
                    .await;
                match next {
                    Some(next) => {
                        *self.current_id.lock().unwrap() = next.question_id.clone();
                        self.registered = next;
                    },
                    None => return self.registered.answer_rx.try_recv().ok(),
                }
                continue;
            }
            // 和回答/Stop 争夺同一注册表锁：只有我们移除的到期题可以默认。
            let can_default = self.config.auto_select_first_on_timeout
                && self
                    .specs
                    .iter()
                    .all(|question| !question.options.is_empty());
            let removed = if can_default {
                self.access
                    .cancel_question(&self.connection_id, &self.registered.question_id)
                    .await
            } else {
                self.access
                    .stop_timed_out_question(&self.connection_id, &self.registered.question_id)
                    .await
            };
            if !removed {
                return self.registered.answer_rx.try_recv().ok();
            }
            // cancel_question 的广播可能等待锁；期间到达的撤回仍优先于默认答案。
            tokio::select! {
                biased;
                () = &mut local_abort => return None,
                () = &mut cancellation => return None,
                () = std::future::ready(()) => {}
            }
            if can_default {
                let answer = QuestionAnswer {
                    answers: self
                        .specs
                        .iter()
                        .map(|q| QuestionAnswerItem {
                            question_id: q.id.clone(),
                            labels: q
                                .options
                                .first()
                                .map(|o| vec![o.label.clone()])
                                .unwrap_or_default(),
                        })
                        .collect(),
                    declined: false,
                };
                return Some(super::question::build_outcome(&self.specs, &answer));
            }
            return None;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::question::{parse_questions, QuestionDeadline, QuestionOutcome};
    use std::sync::Mutex;
    use tokio::sync::oneshot;

    #[derive(Default)]
    struct Access {
        pending: Mutex<Option<(String, oneshot::Sender<QuestionOutcome>, QuestionDeadline)>>,
        rounds: Mutex<u32>,
        stops: Mutex<u32>,
        abandoned: Mutex<u32>,
    }

    #[async_trait::async_trait]
    impl SessionQuestionAccess for Access {
        async fn register_question(
            &self,
            _: &str,
            _: Vec<QuestionSpec>,
        ) -> Option<RegisteredQuestion> {
            panic!("原生桥必须使用带期限入口")
        }

        async fn register_native_question_with_timeout(
            &self,
            _: &str,
            _: Vec<QuestionSpec>,
            timeout: std::time::Duration,
        ) -> Option<RegisteredQuestion> {
            let mut rounds = self.rounds.lock().unwrap();
            *rounds += 1;
            let id = rounds.to_string();
            let deadline = QuestionDeadline::from_now(timeout);
            let (tx, rx) = oneshot::channel();
            assert!(self
                .pending
                .lock()
                .unwrap()
                .replace((id.clone(), tx, deadline.clone()))
                .is_none());
            Some(RegisteredQuestion {
                question_id: id,
                answer_rx: rx,
                upstream_closed: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                deadline: Some(deadline),
            })
        }

        async fn cancel_question(&self, _: &str, id: &str) -> bool {
            let mut pending = self.pending.lock().unwrap();
            if pending
                .as_ref()
                .is_some_and(|(current, _, _)| current == id)
            {
                pending.take();
                true
            } else {
                false
            }
        }

        async fn cancel_questions_by_parent(&self, _: &str) {
            self.pending.lock().unwrap().take();
        }

        async fn stop_question_task(&self, _: &str) {
            *self.stops.lock().unwrap() += 1;
        }

        async fn mark_question_host_abandoned(&self, _: &str, id: &str) -> bool {
            let pending = self.pending.lock().unwrap();
            if pending
                .as_ref()
                .is_some_and(|(current, _, _)| current == id)
            {
                drop(pending);
                *self.abandoned.lock().unwrap() += 1;
                true
            } else {
                false
            }
        }
    }

    async fn question(access: &Arc<Access>, auto: bool) -> NativeQuestion {
        let specs = parse_questions(&serde_json::json!({"questions": [{
            "question": "选哪个？", "header": "选择", "options": [{"label": "甲"}, {"label": "乙"}]
        }]}))
        .unwrap();
        NativeQuestion::register(
            access.clone(),
            "parent",
            specs,
            QuestionConfig {
                enabled: true,
                wait_timeout_minutes: 10,
                retry_count: 2,
                auto_select_first_on_timeout: auto,
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn retries_full_rounds_then_selects_or_stops() {
        for auto in [true, false] {
            let access = Arc::new(Access::default());
            let ask = question(&access, auto).await;
            let start = tokio::time::Instant::now();
            let outcome = ask.wait(std::future::pending()).await;
            assert_eq!(start.elapsed(), std::time::Duration::from_secs(1800));
            assert_eq!(*access.rounds.lock().unwrap(), 3);
            assert_eq!(*access.stops.lock().unwrap(), u32::from(!auto));
            assert!(access.pending.lock().unwrap().is_none());
            if auto {
                let outcome = outcome.unwrap();
                assert!(!outcome.declined);
                assert_eq!(outcome.answers[0].selected, ["甲"]);
            } else {
                assert!(outcome.is_none());
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn zero_retries_stops_after_one_configured_wait() {
        let access = Arc::new(Access::default());
        let mut ask = question(&access, false).await;
        ask.config.retry_count = 0;
        let start = tokio::time::Instant::now();
        assert!(ask.wait(std::future::pending()).await.is_none());
        assert_eq!(start.elapsed(), Duration::from_secs(600));
        assert_eq!(*access.rounds.lock().unwrap(), 1);
        assert_eq!(*access.stops.lock().unwrap(), 1);
        assert!(access.pending.lock().unwrap().is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn withdrawal_keeps_the_question_and_never_default_or_retry() {
        for (peer_withdrawal, auto) in [(true, true), (true, false), (false, true), (false, false)] {
            let access = Arc::new(Access::default());
            let ask = question(&access, auto).await;
            let question_id = ask.registered.question_id.clone();
            let (tx, rx) = oneshot::channel();
            if peer_withdrawal {
                tx.send(()).unwrap();
            } else {
                access.cancel_questions_by_parent("parent").await;
            }
            assert!(ask
                .wait(async {
                    let _ = rx.await;
                })
                .await
                .is_none());
            assert_eq!(*access.rounds.lock().unwrap(), 1, "撤回不重提");
            assert_eq!(*access.stops.lock().unwrap(), 0, "撤回不停止宿主任务");
            if peer_withdrawal {
                // 宿主放弃这次询问：条目与卡片保留，等用户作答后再补送。
                assert_eq!(*access.abandoned.lock().unwrap(), 1);
                assert_eq!(
                    access.pending.lock().unwrap().as_ref().unwrap().0,
                    question_id,
                    "宿主放弃后不得撤题，否则用户就没有可作答的入口"
                );
            } else {
                assert_eq!(*access.abandoned.lock().unwrap(), 0);
                assert!(access.pending.lock().unwrap().is_none(), "本地取消照旧撤题");
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn local_abort_wins_over_upstream_and_cannot_stop_a_new_generation() {
        for auto in [false, true] {
            let access = Arc::new(Access::default());
            let ask = question(&access, auto).await;
            // 上游撤回与本地清理同时就绪：本地来源优先，不重提或默认回答。
            assert!(ask
                .wait_with_local_abort(std::future::ready(()), std::future::ready(()))
                .await
                .is_none());
            assert_eq!(*access.stops.lock().unwrap(), 0);
            assert_eq!(*access.rounds.lock().unwrap(), 1);
            assert!(access.pending.lock().unwrap().is_none());
            let old = question(&access, auto).await;
            access.cancel_questions_by_parent("parent").await;
            let next = question(&access, auto).await;
            assert!(old
                .wait_with_local_abort(std::future::ready(()), std::future::ready(()))
                .await
                .is_none());
            assert_eq!(*access.stops.lock().unwrap(), 0);
            assert_eq!(
                access.pending.lock().unwrap().as_ref().unwrap().0,
                next.registered.question_id
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn late_withdrawal_must_not_stop_a_new_question_generation() {
        let access = Arc::new(Access::default());
        let old = question(&access, false).await;
        access.cancel_questions_by_parent("parent").await;
        let next = question(&access, false).await;
        assert!(old.wait(std::future::ready(())).await.is_none());
        assert_eq!(*access.stops.lock().unwrap(), 0);
        assert_eq!(access.pending.lock().unwrap().as_ref().unwrap().0, next.registered.question_id);
    }

    #[tokio::test(start_paused = true)]
    async fn extension_moves_the_actual_wait_and_answer_unblocks() {
        let access = Arc::new(Access::default());
        let ask = question(&access, true).await;
        let waiting = tokio::spawn(ask.wait(std::future::pending()));
        tokio::task::yield_now().await;
        let deadline = access.pending.lock().unwrap().as_ref().unwrap().2.clone();
        deadline
            .try_extend(std::time::Duration::from_secs(600))
            .unwrap();
        tokio::time::advance(std::time::Duration::from_secs(601)).await;
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        assert_eq!(*access.rounds.lock().unwrap(), 1);
        let (_, tx, _) = access.pending.lock().unwrap().take().unwrap();
        tx.send(QuestionOutcome {
            answers: vec![],
            declined: true,
        })
        .unwrap();
        assert!(waiting.await.unwrap().unwrap().declined);
        assert_eq!(*access.stops.lock().unwrap(), 0);
    }
}
