#!/usr/bin/env bash
# macOS 自签名代码签名证书导入 / 清理脚本（在 GitHub Actions job 内执行）
#
# 用法：
#   bash scripts/import-macos-self-signed-certificate.sh            # 导入（构建前执行）
#   bash scripts/import-macos-self-signed-certificate.sh cleanup    # 构建结束后清理（if: always()）
#
# 导入模式读取的环境变量：
#   CODEG_MACOS_SIGNING_P12        base64 编码的 .p12（自签名证书 + 私钥）
#   CODEG_MACOS_SIGNING_PASSWORD   .p12 密码
#   GITHUB_ENV                     GitHub Actions 环境文件（追加导出变量）
#   RUNNER_TEMP                    GitHub Actions job 临时目录
#
# 导入模式追加到 GITHUB_ENV 的变量（不含私钥 / 密码 / p12）：
#   APPLE_SIGNING_IDENTITY          证书 SHA-1（40 位十六进制），可直接用于 codesign -s
#   CODEG_MACOS_KEYCHAIN            本 job 专用临时 keychain 绝对路径
#   CODEG_COMPUTER_CERT_SHA1        证书 SHA-1（构建脚本用它生成自签名验签条件）
#   CODEG_MACOS_KEYCHAIN_LIST_FILE  导入前 user keychain 搜索列表的快照（诊断用）
#
# 约定与限制：
#   - 自签名证书没有 TeamIdentifier，identity 直接使用证书 SHA-1。
#   - 只操作本 job 的临时 keychain；不修改系统信任设置、不改变 SIP、不删除用户 keychain。
#   - user 域 keychain 搜索列表是**用户全局**的：本脚本对它只做「加入本 job 的
#     keychain」「移除本 job 的 keychain」，其余条目（login / openvpn / 其它 job 的）
#     一律原样保留 —— 绝不按导入前的快照整表覆盖（那会删掉之后别人加进来的条目）。
#     整段读改写用 $HOME 下的一把 mkdir 锁串行化：RUNNER_TEMP 每个 job 都不同，
#     放在那里不是全局锁。锁只在读改写列表（以及必要的 create / delete）期间持有，
#     不在整个构建期间持有。
#   - cleanup 的归属校验基于**物理路径**：临时目录必须是 canonical RUNNER_TEMP 的
#     直接子目录、basename 正好是 ${tmp_prefix}.<6 位>，keychain 与备份必须正好是
#     该目录里的预期文件名；含 `..`、多层目录或符号链接的路径一律拒绝（此时不动
#     列表、不删除任何东西）。
#   - 写入 GITHUB_ENV 的内容不含私钥 / 密码 / p12；不使用 set -x，security 与 openssl
#     输出全部重定向。
#   - 导入失败时 EXIT trap 回滚：把本 job 的 keychain 从当前列表里移除、删除临时
#     keychain 与临时文件；每一步都先过归属校验，不合格就什么都不删。
set -euo pipefail

tmp_prefix="codeg-selfsigned-cert"
keychain_name="codeg-selfsigned.keychain-db"
backup_name="original-user-keychains.txt"
lock_name=".codeg-selfsigned-keychain-list.lock"
mode="${1:-import}"

# 由 import_mode 设置、on_import_exit 回滚时读取
work_dir=""
keychain=""
list_backup=""
imported=0

# 全局锁（见文件头）：lock_dir / lock_held 由 acquire_keychain_lock 设置
lock_dir=""
lock_held=0

log() { printf '[codeg] %s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 全局锁 ----

# 锁的位置：$HOME 下 —— user keychain 搜索列表是用户全局的，各 job 的 RUNNER_TEMP
# 都不一样，放在那里就不是同一把锁。HOME 为空时返回非零（宁可不改列表）。
lock_path() {
  if [ -z "${HOME:-}" ]; then
    return 1
  fi
  printf '%s/%s' "${HOME%/}" "$lock_name"
  return 0
}

# macOS 没有 flock(1)：用 mkdir 的原子性做一把短持锁。拿不到锁就返回非零，
# 由调用方决定是失败退出（拒绝无锁改写用户全局列表）还是放弃这一步。
acquire_keychain_lock() {
  local dir waited=0
  if ! dir="$(lock_path)"; then
    log "无法确定 keychain 列表锁的位置：HOME 是空的。"
    return 1
  fi
  while ! mkdir "$dir" 2>/dev/null; do
    if [ "$waited" -ge 60 ]; then
      log "另一个本脚本实例持有 keychain 列表锁超过 60 秒：${dir}（确认没有别的实例在跑时，可删除该目录）"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  lock_dir="$dir"
  lock_held=1
  printf '%s\n' "$$" > "$dir/pid" 2>/dev/null || true
  return 0
}

# 只删自己建的那把锁：pid 文件不是本进程写的就一律不碰。
release_keychain_lock() {
  local mine
  [ "$lock_held" -eq 1 ] || return 0
  lock_held=0
  [ -n "$lock_dir" ] || return 0
  if [ -f "$lock_dir/pid" ]; then
    mine="$(cat "$lock_dir/pid" 2>/dev/null || true)"
    if [ "$mine" != "$$" ]; then
      return 0
    fi
  fi
  rm -f "$lock_dir/pid" 2>/dev/null || true
  rmdir "$lock_dir" 2>/dev/null || true
  return 0
}

# ------------------------------------------------------- 路径归属校验 ----

# 只接受绝对路径、且不含 `.` / `..` 组件与尾随斜杠：任何一层路径穿越都拒绝。
plain_path() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    */../*|*/..|*/./*|*/.|*/) return 1 ;;
  esac
  return 0
}

# 目录的物理规范路径（解析符号链接，/tmp 与 /private/tmp 因此是同一个）。
physical_dir() {
  if [ ! -d "$1" ]; then
    return 1
  fi
  (cd "$1" 2>/dev/null && pwd -P)
}

# 严格判断目录是否由本脚本创建：
#   物理路径必须是 canonical RUNNER_TEMP 的**直接子目录**，basename 正好是
#   ${tmp_prefix}.<6 位 mktemp 后缀>，且自身不是符号链接。
is_owned_work_dir() {
  local raw="$1" base suffix temp parent
  plain_path "$raw" || return 1
  if [ -z "${RUNNER_TEMP:-}" ]; then
    return 1
  fi
  plain_path "${RUNNER_TEMP%/}" || return 1
  base="$(basename "$raw")"
  case "$base" in
    "${tmp_prefix}."*) ;;
    *) return 1 ;;
  esac
  suffix="${base#"${tmp_prefix}."}"
  case "$suffix" in
    ??????) ;;
    *) return 1 ;;
  esac
  case "$suffix" in
    *[!A-Za-z0-9]*) return 1 ;;
  esac
  if [ ! -d "$raw" ]; then
    return 1
  fi
  if [ -L "$raw" ]; then
    return 1
  fi
  if ! temp="$(physical_dir "${RUNNER_TEMP%/}")"; then
    return 1
  fi
  if ! parent="$(physical_dir "$(dirname "$raw")")"; then
    return 1
  fi
  if [ "$parent" != "$temp" ]; then
    return 1
  fi
  return 0
}

# 严格判断 keychain 是否由本脚本创建：
#   ${RUNNER_TEMP}/codeg-selfsigned-cert.<6 位>/codeg-selfsigned.keychain-db（其它路径一律不认）
is_owned_keychain() {
  local file="$1"
  plain_path "$file" || return 1
  if [ "$(basename "$file")" != "$keychain_name" ]; then
    return 1
  fi
  if [ -L "$file" ]; then
    return 1
  fi
  is_owned_work_dir "$(dirname "$file")"
}

# 严格判断搜索列表快照是否是本脚本写的：同一个临时目录里的预期文件名。
is_owned_backup() {
  local file="$1"
  plain_path "$file" || return 1
  if [ "$(basename "$file")" != "$backup_name" ]; then
    return 1
  fi
  if [ -L "$file" ]; then
    return 1
  fi
  is_owned_work_dir "$(dirname "$file")"
}

# --------------------------------------------- user 域 keychain 搜索列表 ----

# 当前 user 域 keychain 搜索列表：每行一个路径，去掉缩进与引号
current_user_keychains() {
  security list-keychains -d user | sed -e 's/^[[:space:]]*//' -e 's/^"//' -e 's/"$//'
}

# 一项 keychain 路径的规范形式：物理解析父目录（于是 /tmp/x 与 /private/tmp/x 是
# 同一项），文件名原样。父目录不存在时退化为原文本，只用于比较。
canonical_keychain() {
  local path="$1" parent base physical
  case "$path" in
    */*) parent="${path%/*}"; base="${path##*/}" ;;
    *) parent="."; base="$path" ;;
  esac
  if [ -z "$parent" ]; then
    parent="/"
  fi
  if physical="$(cd "$parent" 2>/dev/null && pwd -P)"; then
    printf '%s/%s\n' "${physical%/}" "$base"
    return 0
  fi
  printf '%s\n' "$path"
}

# 以**当前列表**为基础增删本 job 的 keychain，绝不整表还原导入前的快照：
#   add    —— 当前列表（去掉重复项后原样保留）+ 本 job keychain（已经在内就不动）
#   remove —— 当前列表去掉规范化后等于本 job keychain 的那一项
# 其它条目（其它 job 的、login.keychain-db、openvpn.keychain-db 等）一律原样保留。
update_user_keychain_list() {
  local action="$1" own="$2"
  local line own_key item present
  local -a entries
  entries=()
  own_key="$(canonical_keychain "$own")"
  while IFS= read -r line; do
    if [ -z "$line" ]; then
      continue
    fi
    item="$(canonical_keychain "$line")"
    if [ "$action" = remove ] && [ "$item" = "$own_key" ]; then
      continue
    fi
    entries+=("$line")
  done < <(current_user_keychains)

  if [ "$action" = add ]; then
    present=0
    for item in "${entries[@]:-}"; do
      if [ -z "$item" ]; then
        continue
      fi
      if [ "$(canonical_keychain "$item")" = "$own_key" ]; then
        present=1
      fi
    done
    if [ "$present" -eq 0 ]; then
      entries+=("$own")
    fi
  fi

  if [ "${#entries[@]}" -eq 0 ]; then
    log "user keychain 搜索列表为空，未改写（security 不接受空列表）。"
    return 0
  fi
  security list-keychains -d user -s "${entries[@]}" >/dev/null 2>&1
}

# 导入失败（EXIT trap）时回滚：把本 job 的 keychain 从当前列表里移除（其余条目
# 保留），再删除本 job 的 keychain 与临时目录 —— 每一步都先过归属校验。
on_import_exit() {
  local status=$?
  release_keychain_lock
  if [ "$imported" -eq 0 ]; then
    log "导入未完成，正在回滚临时 keychain 与 keychain 搜索列表。"
    if [ -n "$keychain" ] && is_owned_keychain "$keychain"; then
      if acquire_keychain_lock; then
        update_user_keychain_list remove "$keychain" \
          || log "回滚：从 user keychain 搜索列表里移除本 job 的 keychain 失败。"
        release_keychain_lock
      else
        log "回滚：拿不到 keychain 列表锁，未改写搜索列表。"
      fi
      if [ -e "$keychain" ]; then
        security delete-keychain "$keychain" >/dev/null 2>&1 || true
      fi
    fi
    if [ -n "$work_dir" ] && is_owned_work_dir "$work_dir"; then
      rm -rf "$work_dir" || true
    fi
  fi
  exit "$status"
}

import_mode() {
  local line sig_sha1
  local keychain_password cert_subject cert_issuer cert_text sha1
  local p12_file cert_pem tool_log self_test_bin

  [ "$(uname -s)" = "Darwin" ] || die "本脚本只能在 macOS 上运行。"
  [ -n "${CODEG_MACOS_SIGNING_P12:-}" ] || die "缺少环境变量 CODEG_MACOS_SIGNING_P12（base64 编码的 p12）。"
  [ -n "${CODEG_MACOS_SIGNING_PASSWORD:-}" ] || die "缺少环境变量 CODEG_MACOS_SIGNING_PASSWORD。"
  [ -n "${GITHUB_ENV:-}" ] || die "缺少环境变量 GITHUB_ENV（GitHub Actions 环境文件路径）。"
  [ -n "${RUNNER_TEMP:-}" ] || die "缺少环境变量 RUNNER_TEMP（GitHub Actions job 临时目录）。"
  [ -d "${RUNNER_TEMP}" ] || die "RUNNER_TEMP 不是目录：${RUNNER_TEMP}"

  trap 'on_import_exit' EXIT

  # 本 job 专属临时目录（mktemp 保证唯一，cleanup 只删除该目录）
  work_dir="$(mktemp -d "${RUNNER_TEMP%/}/${tmp_prefix}.XXXXXX")"
  chmod 700 "$work_dir"
  keychain="$work_dir/$keychain_name"
  p12_file="$work_dir/cert.p12"
  cert_pem="$work_dir/cert.pem"
  tool_log="$work_dir/tools.log"
  list_backup="$work_dir/$backup_name"

  # 1) 记录导入前的 user 搜索列表（诊断与审计用；清理时按当前列表精确移除本
  #    job 的项，绝不整表还原这份快照）
  current_user_keychains > "$list_backup"
  chmod 600 "$list_backup"

  # 2) base64 解码为 p12（忽略 secret 中可能出现的换行/空白），权限 600
  printf '%s' "$CODEG_MACOS_SIGNING_P12" | tr -d '[:space:]' | openssl base64 -d -A -out "$p12_file" \
    || die "base64 解码失败：请确认 CODEG_MACOS_SIGNING_P12 是 base64 编码的 .p12。"
  chmod 600 "$p12_file"
  [ -s "$p12_file" ] || die "解码后的 p12 为空，请检查 secret 内容。"

  # 3) 提取公有叶子证书（密码用 env: 传入，不出现在命令行与日志中）
  openssl pkcs12 -in "$p12_file" -clcerts -nokeys -out "$cert_pem" \
    -passin env:CODEG_MACOS_SIGNING_PASSWORD >>"$tool_log" 2>&1 \
    || die "从 p12 提取证书失败：请确认密码正确、p12 未损坏且内含证书。"
  [ -s "$cert_pem" ] || die "p12 中没有可用的叶子证书，请检查 secret 内容。"

  # 4) 严格校验：必须是自签名证书、用途为代码签名、指纹为 40 位十六进制 SHA-1
  cert_subject="$(openssl x509 -in "$cert_pem" -noout -subject | sed -e 's/^subject=[[:space:]]*//' -e 's/[[:space:]]*$//')"
  cert_issuer="$(openssl x509 -in "$cert_pem" -noout -issuer | sed -e 's/^issuer=[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ "$cert_subject" = "$cert_issuer" ] || die "证书不是自签名证书（issuer 与 subject 不一致），拒绝导入。"
  cert_text="$(openssl x509 -in "$cert_pem" -noout -text)"
  if printf '%s\n' "$cert_text" | grep -q "Extended Key Usage"; then
    printf '%s\n' "$cert_text" | grep -A1 "Extended Key Usage" | grep -q "Code Signing" \
      || die "证书用途不是代码签名（Extended Key Usage 中没有 Code Signing），拒绝导入。"
  fi
  sha1="$(openssl x509 -in "$cert_pem" -noout -fingerprint -sha1 | sed 's/.*=//' | tr -d ':' | tr '[:lower:]' '[:upper:]')"
  printf '%s' "$sha1" | grep -Eq '^[0-9A-F]{40}$' || die "证书 SHA-1 指纹格式异常（期望 40 位十六进制），拒绝导入。"

  # 5) 创建本 job 专用临时 keychain 并导入 p12
  keychain_password="$(openssl rand -hex 24)"
  security create-keychain -p "$keychain_password" "$keychain" >>"$tool_log" 2>&1 \
    || die "创建临时 keychain 失败。"
  security set-keychain-settings -lut 21600 "$keychain" >>"$tool_log" 2>&1 \
    || die "设置临时 keychain 锁定超时失败。"
  security unlock-keychain -p "$keychain_password" "$keychain" >>"$tool_log" 2>&1 \
    || die "解锁临时 keychain 失败。"
  security import "$p12_file" -k "$keychain" -P "$CODEG_MACOS_SIGNING_PASSWORD" -T /usr/bin/codesign >>"$tool_log" 2>&1 \
    || die "导入 p12 失败：请确认 CODEG_MACOS_SIGNING_PASSWORD 与 p12 匹配。"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >>"$tool_log" 2>&1 \
    || die "设置 keychain 分区列表失败，codesign 可能无法访问私钥。"

  # 6) 把临时 keychain 加入 user 搜索列表（codesign 按 SHA-1 查找 identity 必需）：
  #    以当前列表为基础追加，整段读改写由全局锁串行化，只在这一段持锁。
  acquire_keychain_lock \
    || die "拿不到 keychain 列表锁（另一个实例在改写或残留锁目录），拒绝无锁改写用户 keychain 搜索列表。"
  if ! update_user_keychain_list add "$keychain" >>"$tool_log" 2>&1; then
    release_keychain_lock
    die "更新 user keychain 搜索列表失败。"
  fi
  release_keychain_lock

  # 7) 真实验证私钥可用且与证书匹配：用导入的证书 SHA-1 签一个自建的最小可执行文件并验签
  #    （find-certificate 只能证明证书存在，无法证明私钥可用，不能替代这一步）
  self_test_bin="$work_dir/codesign-selftest"
  printf '#!/bin/sh\nexit 0\n' > "$self_test_bin"
  chmod 700 "$self_test_bin"
  codesign --force --sign "$sha1" --keychain "$keychain" "$self_test_bin" >>"$tool_log" 2>&1 \
    || die "导入的证书无法签名：p12 缺少私钥或私钥不可用，拒绝继续。"
  codesign --verify --strict=all "$self_test_bin" >>"$tool_log" 2>&1 \
    || die "自检签名验签失败：证书与私钥不匹配，拒绝继续。"
  codesign -d --extract-certificates="$work_dir/selftest-cert" "$self_test_bin" >/dev/null 2>&1 \
    || die "无法读取自检签名中的证书，拒绝继续。"
  sig_sha1="$(openssl x509 -inform DER -in "$work_dir/selftest-cert0" -noout -fingerprint -sha1 2>/dev/null \
    | sed 's/.*=//' | tr -d ':' | tr '[:lower:]' '[:upper:]')"
  [ "$sig_sha1" = "$sha1" ] || die "自检签名所用证书与本 job 证书不一致，拒绝继续。"

  # 8) 导出给后续步骤使用（不含私钥 / 密码 / p12）
  {
    printf 'APPLE_SIGNING_IDENTITY=%s\n' "$sha1"
    printf 'CODEG_MACOS_KEYCHAIN=%s\n' "$keychain"
    printf 'CODEG_COMPUTER_CERT_SHA1=%s\n' "$sha1"
    printf 'CODEG_MACOS_KEYCHAIN_LIST_FILE=%s\n' "$list_backup"
  } >> "$GITHUB_ENV" || die "写入 GITHUB_ENV 失败：${GITHUB_ENV}"

  imported=1
  log "已导入自签名代码签名证书，指纹（SHA-1）：$sha1"
  log "临时 keychain：$keychain"
  log "已写入 GITHUB_ENV（不含私钥与密码）；构建结束后请执行本脚本的 cleanup。"
}

cleanup_mode() {
  local own="${CODEG_MACOS_KEYCHAIN:-}"
  local backup="${CODEG_MACOS_KEYCHAIN_LIST_FILE:-}"
  local work="" backup_dir=""

  [ "$(uname -s)" = "Darwin" ] || die "本脚本只能在 macOS 上运行。"

  if [ -z "$own" ] && [ -z "$backup" ]; then
    log "未发现本 job 的导入记录（CODEG_MACOS_KEYCHAIN / CODEG_MACOS_KEYCHAIN_LIST_FILE 为空），无需清理。"
    return 0
  fi

  trap 'release_keychain_lock' EXIT

  # 归属校验（动列表 / 删除之前必须全部通过）：物理路径必须是 canonical
  # RUNNER_TEMP 的直接子目录、basename 精确匹配，keychain 与备份必须是该目录里
  # 的预期文件名；不合格一律拒绝，且不碰列表、不删除任何东西。
  if [ -n "$own" ]; then
    is_owned_keychain "$own" || die "拒绝清理非本脚本创建的 keychain：${own}"
    work="$(dirname "$own")"
  fi
  if [ -n "$backup" ]; then
    is_owned_backup "$backup" || die "拒绝使用非本脚本临时目录里预期文件名的搜索列表快照：${backup}"
    backup_dir="$(dirname "$backup")"
    if [ -n "$work" ]; then
      if [ "$(physical_dir "$backup_dir")" != "$(physical_dir "$work")" ]; then
        die "拒绝：搜索列表快照不在 keychain 所在的临时目录里：${backup}"
      fi
    else
      work="$backup_dir"
    fi
  fi

  # 1) 从**当前**列表里精确移除本 job 的 keychain（其余条目一律保留；加锁）
  if [ -n "$own" ]; then
    acquire_keychain_lock \
      || die "拿不到 keychain 列表锁，拒绝无锁改写用户 keychain 搜索列表。"
    if ! update_user_keychain_list remove "$own"; then
      release_keychain_lock
      die "从 user keychain 搜索列表里移除本 job 的临时 keychain 失败。"
    fi
    release_keychain_lock
    log "已从当前 user keychain 搜索列表中移除本 job 的临时 keychain（其它条目未改动）。"
  else
    log "没有 keychain 路径可移除；只清理本 job 的临时目录。"
  fi

  # 2) 删除本 job 的临时 keychain（路径已通过归属校验）
  if [ -n "$own" ] && [ -e "$own" ]; then
    security delete-keychain "$own" >/dev/null 2>&1 || die "删除临时 keychain 失败：${own}"
    log "已删除临时 keychain：$own"
  else
    log "临时 keychain 不存在，跳过删除。"
  fi

  # 3) 删除本脚本创建的临时文件（p12 / 证书 / 自检文件 / 日志 / 列表快照）
  if [ -n "$work" ] && [ -d "$work" ]; then
    rm -rf "$work"
    log "已删除临时目录：$work"
  fi
}

case "$mode" in
  import) import_mode ;;
  cleanup) cleanup_mode ;;
  *) die "未知参数：${mode}（用法：$0 [cleanup]）" ;;
esac
