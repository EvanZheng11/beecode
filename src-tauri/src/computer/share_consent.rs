//! 一次只接受一个桌面授权请求。答复只能选中请求中的窗口，不能改变权限级别。

use crate::computer::types::GrantLevel;
use serde::Serialize;
use std::sync::Mutex;
use tokio::sync::oneshot;
use tokio::time::Instant;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareRequest {
    pub(crate) request_id: String,
    pub(crate) requested_level: GrantLevel,
    pub(crate) windows: Vec<ShareWindow>,
    pub(crate) expires_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareWindow {
    pub(crate) target_id: String,
    pub(crate) app_name: String,
    pub(crate) title: String,
    pub(crate) level: GrantLevel,
}

struct Pending {
    request: ShareRequest,
    expires: Instant,
    answer: Option<oneshot::Sender<Vec<String>>>,
}

#[derive(Default)]
pub(crate) struct WindowShareConsent(Mutex<Option<Pending>>);

impl WindowShareConsent {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Pending>> {
        self.0.lock().unwrap_or_else(|err| err.into_inner())
    }

    pub(crate) fn arm(
        &self,
        request: ShareRequest,
        expires: Instant,
    ) -> Option<oneshot::Receiver<Vec<String>>> {
        let mut slot = self.lock();
        if slot.is_some() {
            return None;
        }
        let (answer, receiver) = oneshot::channel();
        *slot = Some(Pending {
            request,
            expires,
            answer: Some(answer),
        });
        Some(receiver)
    }

    pub(crate) fn decide(&self, id: &str, selected: Vec<String>) -> bool {
        let mut slot = self.lock();
        let Some(pending) = slot
            .as_mut()
            .filter(|pending| pending.request.request_id == id)
        else {
            return false;
        };
        if Instant::now() >= pending.expires
            || selected.len() > pending.request.windows.len()
            || selected.iter().enumerate().any(|(i, target)| {
                !pending
                    .request
                    .windows
                    .iter()
                    .any(|window| window.target_id == *target)
                    || selected[..i].contains(target)
            })
        {
            return false;
        }
        pending
            .answer
            .take()
            .is_some_and(|answer| answer.send(selected).is_ok())
    }

    #[cfg(feature = "tauri-runtime")]
    pub(crate) fn current(&self, id: &str) -> Option<ShareRequest> {
        self.lock()
            .as_ref()
            .filter(|pending| {
                pending.request.request_id == id
                    && pending.answer.is_some()
                    && Instant::now() < pending.expires
            })
            .map(|pending| pending.request.clone())
    }

    // 已回答的请求也占用此槽，直到授权写入或被 Stop 取消。
    pub(crate) fn is_current(&self, id: &str) -> bool {
        self.lock()
            .as_ref()
            .is_some_and(|pending| pending.request.request_id == id)
    }

    pub(crate) fn remove(&self, id: &str) {
        let mut slot = self.lock();
        if slot
            .as_ref()
            .is_some_and(|pending| pending.request.request_id == id)
        {
            *slot = None;
        }
    }

    pub(crate) fn cancel(&self) {
        *self.lock() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn request(id: &str, window_ids: &[&str]) -> ShareRequest {
        ShareRequest {
            request_id: id.into(),
            requested_level: GrantLevel::Read,
            windows: window_ids
                .iter()
                .map(|id| ShareWindow {
                    target_id: (*id).into(),
                    app_name: "Editor".into(),
                    title: "Document".into(),
                    level: GrantLevel::None,
                })
                .collect(),
            expires_at: 0,
        }
    }

    #[tokio::test]
    async fn accepts_only_an_explicit_subset_and_only_once() {
        let consent = WindowShareConsent::default();
        let expires = Instant::now() + Duration::from_secs(30);
        let answer = consent
            .arm(request("first", &["w1", "w2"]), expires)
            .unwrap();
        assert!(consent.arm(request("second", &["w3"]), expires).is_none());
        assert!(!consent.decide("wrong", vec!["w1".into()]));
        assert!(!consent.decide("first", vec!["w3".into()]));
        assert!(!consent.decide("first", vec!["w1".into(), "w1".into()]));
        assert!(consent.decide("first", vec!["w2".into()]));
        assert!(!consent.decide("first", vec!["w1".into()]));
        assert_eq!(answer.await.unwrap(), ["w2"]);
        assert!(consent.is_current("first"));
        consent.cancel();
        assert!(!consent.is_current("first"));
    }

    #[tokio::test]
    async fn expired_cancelled_or_dropped_requests_never_accept_an_answer() {
        let consent = WindowShareConsent::default();
        let answer = consent
            .arm(request("expired", &["w1"]), Instant::now())
            .unwrap();
        assert!(!consent.decide("expired", vec!["w1".into()]));
        consent.remove("expired");
        assert!(answer.await.is_err());

        let expires = Instant::now() + Duration::from_secs(30);
        let answer = consent.arm(request("new", &["w2"]), expires).unwrap();
        consent.remove("expired");
        assert!(consent.is_current("new"));
        consent.cancel();
        assert!(!consent.decide("new", vec!["w2".into()]));
        assert!(answer.await.is_err());

        let answer = consent.arm(request("dropped", &["w2"]), expires).unwrap();
        drop(answer);
        assert!(!consent.decide("dropped", vec!["w2".into()]));
    }

    #[tokio::test]
    async fn an_empty_answer_is_an_explicit_refusal() {
        let consent = WindowShareConsent::default();
        let expires = Instant::now() + Duration::from_secs(30);
        let answer = consent.arm(request("decline", &["w1"]), expires).unwrap();
        assert!(consent.decide("decline", Vec::new()));
        assert!(answer.await.unwrap().is_empty());
    }
}
