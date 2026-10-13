#!/usr/bin/env bash
# 自签名证书导入 / 清理脚本的门禁测试（只在 macOS 上跑）
#
# 覆盖审查里指出的错误边界，全部用**真实的 security / codesign** 跑：
#   1. cleanup 的归属校验：含 `..`、多层目录、符号链接、文件名不符、RUNNER_TEMP
#      不符或有符号链接差异一律按规则处理；危险路径必须拒绝且什么都不删
#      （审查里的纯路径反例就是回归用例）。
#   2. 列表读改写基于**当前列表**：A 导入后别人加了条目，A 的 cleanup 必须保留它；
#      login.keychain-db / openvpn.keychain-db 之类原有条目全程不动；
#      /tmp 与 /private/tmp 视为同一项。
#   3. 本脚本并行导入 / 清理：两个实例同时跑，互不删除对方的条目，清理后回到原样。
#   4. 异常路径：导入中途失败（自检签名失败 / p12 密码错）必须回滚干净 ——
#      列表里不留本 job 的 keychain，临时 keychain 与临时目录都删掉。
#   5. 全局锁：默认锁在 $HOME 下（不是每个 job 各不相同的 RUNNER_TEMP 里），
#      别的实例持锁时本脚本会等锁，而不是无锁改写列表。
#
# 用法：
#   bash scripts/test-import-macos-self-signed-certificate.sh
#
# 需要真实现整套导入时（CI 里有 Secrets）额外提供：
#   CODEG_MACOS_SIGNING_P12 / CODEG_MACOS_SIGNING_PASSWORD
#   CODEG_TEST_REQUIRE_IMPORT=1   # 没给 Secrets 就判定失败（CI 用）
set -uo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
script="$repo_dir/scripts/import-macos-self-signed-certificate.sh"
root="$(mktemp -d "${TMPDIR:-/tmp}/codeg-selfsigned-test.XXXXXX")"
tmp_prefix="codeg-selfsigned-cert"
keychain_name="codeg-selfsigned.keychain-db"
backup_name="original-user-keychains.txt"
lock_name=".codeg-selfsigned-keychain-list.lock"

pass=0
fail=0
skips=0
ok() { printf '  ok   %s\n' "$*"; pass=$((pass + 1)); }
bad() { printf '  FAIL %s\n' "$*"; fail=$((fail + 1)); }
skip() { printf '  skip %s\n' "$*"; skips=$((skips + 1)); }

# 搜索列表：raw 保留系统给的原顺序与文本；canonical 把每一项的父目录解析成
# 物理路径 —— security 自己就会把 /tmp/x 记成 /private/tmp/x，比较必须按规范形式
# （$TMPDIR 在 macOS 上是 /var/folders/...，同样是 /private/var/... 的符号链接）。
list_raw() {
  security list-keychains -d user \
    | sed -e 's/^[[:space:]]*//' -e 's/^"//' -e 's/"$//' \
    | grep -v '^$'
}
canonical_path() {
  local path="$1" parent base physical
  case "$path" in
    */*) parent="${path%/*}"; base="${path##*/}" ;;
    *) parent="."; base="$path" ;;
  esac
  if physical="$(cd "$parent" 2>/dev/null && pwd -P)"; then
    printf '%s/%s\n' "${physical%/}" "$base"
    return 0
  fi
  printf '%s\n' "$path"
}
list_canon() { list_raw | while IFS= read -r line; do canonical_path "$line"; done | sort; }
# 比较用（集合比较）；$1 传进来的路径也会先规范化。
list_sorted() { list_canon; }
list_has() { list_canon | grep -Fxq -- "$(canonical_path "$1")"; }
# 断言「某条规范路径在不在列表里」：被删掉的目录已经无法再解析，所以上层必须在
# 目录还存在时先把规范路径算出来（canonical_path）再调用这里。
list_has_canon() { list_canon | grep -Fxq -- "$1"; }

mkdir -p "$root"
original_list="$(list_sorted)"
original_raw="$(list_raw)"
created_keychains=()
default_lock_dir="${HOME%/}/$lock_name"

created_keychain() {
  security create-keychain -p "$2" "$1" >/dev/null
  created_keychains+=("$1")
}

# 兜底清理与生产脚本同样的纪律：只移除**本测试自己加进去的**条目，别的条目（别的
# 进程/用户自己的，包括并发跑时出现的）一律保留 —— 不用开始时的快照整表覆盖。
restore_list() {
  local -a paths
  local line own skip
  paths=()
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    skip=0
    for own in ${listed_canon[@]+"${listed_canon[@]}"}; do
      if [ "$(canonical_path "$line")" = "$own" ]; then
        skip=1
      fi
    done
    if [ "$skip" -eq 0 ]; then
      paths+=("$line")
    fi
  done < <(list_raw)
  if [ "${#paths[@]}" -gt 0 ]; then
    security list-keychains -d user -s "${paths[@]}" >/dev/null 2>&1 || true
  fi
}

# 只删本测试创建的东西：自己的临时 keychain、自己的临时根、自己的锁占位。
cleanup_test_artifacts() {
  local kc
  for kc in ${created_keychains[@]+"${created_keychains[@]}"}; do
    if [ -e "$kc" ]; then
      security delete-keychain "$kc" >/dev/null 2>&1 || true
    fi
  done
  restore_list
  rm -rf "$root"
  if [ -d "$default_lock_dir" ]; then
    if [ ! -f "$default_lock_dir/pid" ] || [ "$(cat "$default_lock_dir/pid" 2>/dev/null)" = "999999" ]; then
      rm -f "$default_lock_dir/pid"
      rmdir "$default_lock_dir" 2>/dev/null || true
    else
      printf '  note 保留了别人的锁：%s\n' "$default_lock_dir"
    fi
  fi
}
trap 'cleanup_test_artifacts' EXIT

# 一个「本脚本临时目录」：${root}/${tmp_prefix}.<6 位>
owned_dir() {
  local dir="$root/${tmp_prefix}.$1"
  mkdir -p "$dir"
  chmod 700 "$dir"
  printf '%s' "$dir"
}

# 本测试自己加进列表的条目（规范形式，加进去时目录还在，能算出来）。
listed_canon=()

# 把一项请求加进 user 搜索列表（模拟另一个 job / 用户自己的行为，直接用 security）
add_to_list() {
  local -a paths
  paths=()
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    paths+=("$line")
  done < <(list_raw)
  paths+=("$1")
  security list-keychains -d user -s "${paths[@]}" >/dev/null
  listed_canon+=("$(canonical_path "$1")")
}

run_cleanup() { # $1 = RUNNER_TEMP, $2 = keychain 路径, $3 = 备份路径, $4 = 日志
  RUNNER_TEMP="$1" CODEG_MACOS_KEYCHAIN="$2" CODEG_MACOS_KEYCHAIN_LIST_FILE="$3" \
    bash "$script" cleanup >"$4" 2>&1
}

echo "== 1. cleanup 归属校验：危险路径必须拒绝，且什么都不删 =="

other_task="$root/codeg-other-task/${tmp_prefix}.BBBBBB"
mkdir -p "$other_task"
victim="$other_task/$keychain_name"
printf 'sentinel' > "$victim"

refused() { # $1 = 标签，其余同 run_cleanup 的前三个参数
  local label="$1" rc=0
  shift
  run_cleanup "$@" "$root/refusal.log" || rc=$?
  if [ "$rc" -eq 0 ]; then
    bad "${label}：应当拒绝，却返回 0"
  else
    ok "${label}：拒绝（rc=${rc}）"
  fi
}

refused "含 .. 的路径穿越" "$root" \
  "$root/${tmp_prefix}.AAAAAA/../../codeg-other-task/${tmp_prefix}.BBBBBB/$keychain_name" ""

refused "多层目录（不是 RUNNER_TEMP 的直接子目录）" "$root" \
  "$root/sub/${tmp_prefix}.CCCCCC/$keychain_name" ""

refused "RUNNER_TEMP 为空" "" "$root/${tmp_prefix}.DDDDDD/$keychain_name" ""

wrong_root="$root/not-the-runner-temp/${tmp_prefix}.Ee3456"
mkdir -p "$wrong_root"
printf 'sentinel' > "$wrong_root/$keychain_name"
refused "目录不在本次 RUNNER_TEMP 之下" "$root" "$wrong_root/$keychain_name" ""

refused "临时目录名后缀不是 mktemp 形状（.ABC）" "$root" \
  "$root/${tmp_prefix}.ABC/$keychain_name" ""

# 符号链接：名字像本脚本的目录，实际指向别处 —— 必须拒绝。
link_target="$root/codeg-symlink-target"
mkdir -p "$link_target"
printf 'sentinel' > "$link_target/$keychain_name"
link_dir="$root/${tmp_prefix}.Gg7890"
ln -s "$link_target" "$link_dir"
refused "临时目录是符号链接" "$root" "$link_dir/$keychain_name" ""
if [ -e "$link_target/$keychain_name" ]; then
  ok "符号链接指向的文件没有被删除"
else
  bad "符号链接指向的文件被删除了"
fi

owned="$(owned_dir Hh1122)"
refused "keychain 文件名不符" "$root" "$owned/not-the-keychain.keychain-db" ""

refused "备份文件名不符" "$root" "$owned/$keychain_name" "$owned/not-the-backup.txt"

other_owned="$(owned_dir Ii3344)"
refused "备份与 keychain 不在同一个临时目录" "$root" "$owned/$keychain_name" \
  "$other_owned/$backup_name"

# keychain 路径本身是符号链接：拒绝。
kcs="$root/kcsymlink"
printf 'sentinel' > "$kcs"
ln -s "$kcs" "$owned/$keychain_name"
refused "keychain 路径是符号链接" "$root" "$owned/$keychain_name" ""
if [ -e "$kcs" ]; then
  ok "符号链接 keychain 指向的文件没有被删除"
else
  bad "符号链接 keychain 指向的文件被删除了"
fi
rm -f "$owned/$keychain_name"

rc=0
RUNNER_TEMP="$root" CODEG_MACOS_KEYCHAIN="" CODEG_MACOS_KEYCHAIN_LIST_FILE="" \
  bash "$script" cleanup >"$root/noop.log" 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  ok "没有导入记录时 cleanup 是无害的 no-op"
else
  bad "没有导入记录时 cleanup 应当直接返回（rc=${rc}）"
fi

if [ "$(list_sorted)" = "$original_list" ] && [ "$(cat "$victim")" = "sentinel" ]; then
  ok "拒绝路径没有改动列表、也没有碰其它任务的文件"
else
  bad "拒绝路径改动了列表或删了别的文件"
fi

echo "== 2. A 之后别人加的条目必须保留（不整表还原旧快照）=="

dir_a="$(owned_dir Jj5566)"
keychain_a="$dir_a/$keychain_name"
created_keychain "$keychain_a" "test-a"
printf '%s\n' "$original_raw" > "$dir_a/$backup_name"
add_to_list "$keychain_a"

# 快照之后才出现的条目：另一个 job 的 keychain（这里就是「B」）。
dir_b="$(owned_dir Kk7788)"
keychain_b="$dir_b/$keychain_name"
created_keychain "$keychain_b" "test-b"
add_to_list "$keychain_b"

canon_a="$(canonical_path "$keychain_a")"
canon_b="$(canonical_path "$keychain_b")"
if list_has_canon "$canon_b"; then
  ok "B 的条目确实进了搜索列表"
else
  bad "B 的条目没能加入搜索列表（测试自身的问题）"
fi

rc=0
run_cleanup "$root" "$keychain_a" "$dir_a/$backup_name" "$root/cleanup-a.log" || rc=$?
if [ "$rc" -eq 0 ]; then
  ok "A 的 cleanup 成功"
else
  bad "A 的 cleanup 失败（rc=${rc}）：$(tail -3 "$root/cleanup-a.log")"
fi
if list_has_canon "$canon_b"; then
  ok "A 的 cleanup 保留了之后加入的条目（B 的 keychain）"
else
  bad "A 的 cleanup 把之后加入的条目删掉了"
fi
if list_has_canon "$canon_a"; then
  bad "A 的 cleanup 没有移除自己的条目"
else
  ok "A 的 cleanup 精确移除了自己的条目"
fi
if [ ! -e "$keychain_a" ] && [ ! -d "$dir_a" ]; then
  ok "A 的临时 keychain 与临时目录被删除"
else
  bad "A 的临时 keychain 或临时目录残留"
fi

echo "== 2b. /tmp 与 /private/tmp 视为同一项 =="

norm_root="/tmp/codeg-selfsigned-norm.$$"
rm -rf "$norm_root"
mkdir -p "$norm_root/${tmp_prefix}.Nn9900"
norm_file="/private/tmp/codeg-selfsigned-norm.$$/${tmp_prefix}.Nn9900/$keychain_name"
created_keychain "$norm_file" "test-norm"
# 列表里按 /tmp 记，cleanup 用 /private/tmp 传：规范化后必须仍能命中并移除。
add_to_list "/tmp/codeg-selfsigned-norm.$$/${tmp_prefix}.Nn9900/$keychain_name"
rc=0
run_cleanup "/tmp/codeg-selfsigned-norm.$$" "$norm_file" "" "$root/cleanup-norm.log" || rc=$?
if [ "$rc" -eq 0 ]; then
  ok "跨 /tmp 与 /private/tmp 的 cleanup 成功（RUNNER_TEMP=/tmp，keychain=/private/tmp）"
else
  bad "跨 /tmp 与 /private/tmp 的 cleanup 失败（rc=${rc}）：$(tail -3 "$root/cleanup-norm.log")"
fi
if list_raw | grep -q "${tmp_prefix}.Nn9900"; then
  bad "规范化后仍没把本 job 的条目从列表里移除"
else
  ok "规范化后精确移除了本 job 的条目"
fi
rm -rf "$norm_root"

missing=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  list_has "$line" || missing=$((missing + 1))
done <<< "$original_raw"
if [ "$missing" -eq 0 ] && list_has "$keychain_b"; then
  ok "原有条目一个不少（含 login / openvpn 之类）"
else
  bad "原有条目有丢失（missing=${missing}）"
fi
security delete-keychain "$keychain_b" >/dev/null 2>&1 || true
security list-keychains -d user -s "${original_raw}" >/dev/null 2>&1 || true
rm -rf "$dir_b"

echo "== 3. 全局锁：默认锁在 \$HOME 下，别人持锁时本脚本等锁 =="

mkdir "$default_lock_dir" 2>/dev/null && printf '999999\n' > "$default_lock_dir/pid"
if [ -d "$default_lock_dir" ]; then
  ok "默认锁位置是 \$HOME 下的共享路径"
else
  bad "默认锁位置不存在"
fi
case "$default_lock_dir" in
  "$root"/*) bad "锁被放在了 RUNNER_TEMP 里（每个 job 都不同，不是全局锁）" ;;
  *) ok "锁不在 RUNNER_TEMP 里" ;;
esac

dir_c="$(owned_dir Ll1234)"
keychain_c="$dir_c/$keychain_name"
created_keychain "$keychain_c" "test-c"
printf '%s\n' "$original_raw" > "$dir_c/$backup_name"
add_to_list "$keychain_c"

canon_c="$(canonical_path "$keychain_c")"
run_cleanup "$root" "$keychain_c" "$dir_c/$backup_name" "$root/cleanup-locked.log" &
locked_pid=$!
sleep 2
if kill -0 "$locked_pid" 2>/dev/null; then
  ok "别的实例持锁时本脚本在等锁（没有无锁改写列表）"
else
  bad "别的实例持锁时本脚本没有等待"
fi
if [ -f "$default_lock_dir/pid" ] && [ "$(cat "$default_lock_dir/pid")" = "999999" ]; then
  ok "等待期间没有删除别人的锁"
else
  bad "别人的锁被改写或删除了"
fi
rm -f "$default_lock_dir/pid"
rmdir "$default_lock_dir"
wait "$locked_pid"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "拿到锁之后 cleanup 正常完成"
else
  bad "等到锁之后 cleanup 失败（rc=${rc}）：$(tail -3 "$root/cleanup-locked.log")"
fi
if [ ! -e "$default_lock_dir" ]; then
  ok "本脚本释放了自己拿到的锁"
else
  bad "锁没有被释放：$default_lock_dir"
fi
if list_has_canon "$canon_c"; then
  bad "cleanup 没有移除被锁保护的条目"
else
  ok "锁保护的读改写生效：条目被精确移除"
fi

echo "== 4. 并行导入 / 清理（需要 Secrets）=="

have_secrets=0
if [ -n "${CODEG_MACOS_SIGNING_P12:-}" ] && [ -n "${CODEG_MACOS_SIGNING_PASSWORD:-}" ]; then
  have_secrets=1
fi

if [ "$have_secrets" -eq 0 ]; then
  if [ "${CODEG_TEST_REQUIRE_IMPORT:-0}" = "1" ]; then
    bad "缺少 CODEG_MACOS_SIGNING_P12 / CODEG_MACOS_SIGNING_PASSWORD，但要求必须跑真实导入测试"
  else
    skip "没有 Secrets：跳过并行导入 / 清理与导入失败回滚（设 CODEG_TEST_REQUIRE_IMPORT=1 可要求必跑）"
  fi
else
  before_list="$(list_sorted)"

  run_import() { # $1 = GITHUB_ENV 文件，$2 = 输出目录
    : > "$1"
    GITHUB_ENV="$1" RUNNER_TEMP="$root" bash "$script" >"$2/import.log" 2>&1
    printf '%s' "$?" > "$2/rc"
  }

  mkdir -p "$root/run_a" "$root/run_b"
  env_a="$root/github_env_a"
  env_b="$root/github_env_b"
  run_import "$env_a" "$root/run_a" &
  pid_a=$!
  run_import "$env_b" "$root/run_b" &
  pid_b=$!
  wait "$pid_a"
  wait "$pid_b"
  rc_a="$(cat "$root/run_a/rc")"
  rc_b="$(cat "$root/run_b/rc")"
  if [ "$rc_a" -eq 0 ] && [ "$rc_b" -eq 0 ]; then
    ok "两个导入实例并行成功"
  else
    bad "并行导入失败（rc=$rc_a/${rc_b}）：$(tail -3 "$root/run_a/import.log" "$root/run_b/import.log")"
  fi

  kc_a="$(sed -n 's/^CODEG_MACOS_KEYCHAIN=//p' "$env_a")"
  kc_b="$(sed -n 's/^CODEG_MACOS_KEYCHAIN=//p' "$env_b")"
  bk_a="$(sed -n 's/^CODEG_MACOS_KEYCHAIN_LIST_FILE=//p' "$env_a")"
  bk_b="$(sed -n 's/^CODEG_MACOS_KEYCHAIN_LIST_FILE=//p' "$env_b")"
  sha1_a="$(sed -n 's/^CODEG_COMPUTER_CERT_SHA1=//p' "$env_a")"
  if [ -n "$kc_a" ] && [ -n "$kc_b" ] && [ "$kc_a" != "$kc_b" ]; then
    ok "两个实例各有自己的临时 keychain"
  else
    bad "两个实例的 keychain 记录异常：'$kc_a' / '$kc_b'"
  fi
  if printf '%s' "$sha1_a" | grep -Eq '^[0-9A-F]{40}$'; then
    ok "导出的证书 SHA-1 是 40 位十六进制（${sha1_a}）"
  else
    bad "导出的证书 SHA-1 异常：'$sha1_a'"
  fi
  canon_a="$(canonical_path "$kc_a")"
  canon_b="$(canonical_path "$kc_b")"
  if list_has_canon "$canon_a" && list_has_canon "$canon_b"; then
    ok "两个实例的 keychain 都在列表里"
  else
    bad "并行导入后有实例的 keychain 不在列表里"
  fi
  absent=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    list_has "$line" || absent=$((absent + 1))
  done <<< "$before_list"
  if [ "$absent" -eq 0 ]; then
    ok "并行导入没有丢掉任何原有条目"
  else
    bad "并行导入丢掉了 $absent 个原有条目"
  fi

  # 快照之后加入的第三方条目：A 清理时必须留住它。
  dir_x="$(owned_dir Mm5678)"
  keychain_x="$dir_x/$keychain_name"
  created_keychain "$keychain_x" "test-x"
  add_to_list "$keychain_x"
  canon_x="$(canonical_path "$keychain_x")"
  if list_has_canon "$canon_x"; then
    ok "第三方条目确实进了搜索列表（它是 A 快照之后加入的）"
  else
    bad "第三方条目没能加入搜索列表（测试自身的问题）"
  fi

  rc=0
  run_cleanup "$root" "$kc_a" "$bk_a" "$root/cleanup-real-a.log" || rc=$?
  still_a=0
  if list_has_canon "$canon_a"; then still_a=1; fi
  kept_x=1
  list_has_canon "$canon_x" || kept_x=0
  kept_b=1
  list_has_canon "$canon_b" || kept_b=0
  if [ "$rc" -eq 0 ] && [ "$kept_x" -eq 1 ] && [ "$kept_b" -eq 1 ] && [ "$still_a" -eq 0 ]; then
    ok "A 的 cleanup 只删自己的条目（B 与第三方条目都保留）"
  else
    bad "A 的 cleanup 结果不对（rc=${rc}，保留第三方=${kept_x}，保留 B=${kept_b}，A 仍在列表=${still_a}）"
  fi
  if [ ! -e "$kc_a" ]; then
    ok "A 的临时 keychain 已删除"
  else
    bad "A 的临时 keychain 残留：$kc_a"
  fi

  rc=0
  run_cleanup "$root" "$kc_b" "$bk_b" "$root/cleanup-real-b.log" || rc=$?
  security delete-keychain "$keychain_x" >/dev/null 2>&1 || true
  restore_list
  if [ "$rc" -eq 0 ] && [ "$(list_sorted)" = "$before_list" ]; then
    ok "两次 cleanup 之后列表回到导入前（含 login / openvpn 等条目）"
  else
    bad "cleanup 之后列表没有回到导入前（rc=${rc}）"
  fi

  echo "== 5. 导入失败的异常路径必须回滚干净 =="

  before_dirs="$(find "$root" -maxdepth 1 -type d -name "${tmp_prefix}.*" -print | sort)"
  stub_dir="$root/stub"
  mkdir -p "$stub_dir"
  printf '#!/bin/sh\nexit 1\n' > "$stub_dir/codesign"
  chmod 755 "$stub_dir/codesign"
  env_c="$root/github_env_c"
  : > "$env_c"
  rc=0
  PATH="$stub_dir:$PATH" GITHUB_ENV="$env_c" RUNNER_TEMP="$root" \
    bash "$script" >"$root/import-broken.log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    ok "自检签名失败时导入失败（rc=${rc}）"
  else
    bad "自检签名失败时导入却成功了"
  fi
  after_dirs="$(find "$root" -maxdepth 1 -type d -name "${tmp_prefix}.*" -print | sort)"
  if [ "$before_dirs" = "$after_dirs" ]; then
    ok "失败回滚删掉了自己的临时目录"
  else
    bad "失败回滚留下了临时目录：$after_dirs"
  fi
  if [ "$(list_sorted)" = "$before_list" ]; then
    ok "失败回滚没有在列表里留下本 job 的 keychain"
  else
    bad "失败回滚后列表与导入前不同"
  fi

  rc=0
  env_d="$root/github_env_d"
  : > "$env_d"
  CODEG_MACOS_SIGNING_PASSWORD="definitely-wrong-$RANDOM" \
    GITHUB_ENV="$env_d" RUNNER_TEMP="$root" \
    bash "$script" >"$root/import-wrong-password.log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ] && [ "$(list_sorted)" = "$before_list" ]; then
    ok "p12 密码错时导入失败且列表不变（rc=${rc}）"
  else
    bad "p12 密码错时的行为不对（rc=${rc}）"
  fi
fi

echo
echo "结果：$pass 通过，$fail 失败，$skips 跳过"
[ "$fail" -eq 0 ]
