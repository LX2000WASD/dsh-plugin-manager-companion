#!/bin/bash
# e2e-visual.sh — 一条命令跑完：build → 起隔离实例 → 跑 e2e-visual.mjs → 停实例并清理。
#
# 归属：A 类·重写（审计期的临时编排脚本没有保留价值）。旧实现参考：/tmp/vis-audit/run*.sh
#   （只取流程意图：同一次调用内完成 build → 起 → 验 → 停；未复制代码）。
# 官方复用：dsh CLI 的 --profile / --port / --no-open；浏览器侧由 tools/e2e-visual.mjs 负责。
# 前提检查：进程会随 bash 调用结束被回收，所以起停与验证必须在同一次调用内；
#   pm-test 会被其他同学反复起停，因此默认给自己造一个临时 profile 跑在随机端口，
#   只有 --profile pm-test --port 3099 时才用真实 profile（需自己保证没人在动它）。
#
# 用法：
#   bash tools/e2e-visual.sh                     # 临时 profile + 随机端口（默认，推荐）
#   bash tools/e2e-visual.sh --profile pm-test --port 3099   # 用指定的已有 profile
# 退出码：e2e-visual.mjs 的退出码原样透出（0/1/2）。
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
PROFILE="pm-e2e-$$"
PORT=""
PASSTHRU=()
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) PASSTHRU+=("$1"); shift 1 ;;   # 其余参数原样转给 e2e-visual.mjs（--min-content 等）
  esac
done
TEMP_PROFILE=0
SRC_PROFILE=~/.dsh/profiles/pm-test
[ -d "$SRC_PROFILE" ] || { echo "环境问题: 找不到 $SRC_PROFILE"; exit 2; }
if [ ! -d ~/.dsh/profiles/"$PROFILE" ]; then
  TEMP_PROFILE=1
  if [ -z "$PORT" ]; then PORT=$(( (RANDOM % 200) + 3300 )); fi
  mkdir -p ~/.dsh/profiles/"$PROFILE"
  for f in package.json cordis.yml cordis.patch.yml pnpm-workspace.yaml pnpm-lock.yaml; do
    cp "$SRC_PROFILE/$f" ~/.dsh/profiles/"$PROFILE/$f" 2>/dev/null || true
  done
  ( cd ~/.dsh/profiles/"$PROFILE" && pnpm install --prefer-offline >/dev/null 2>&1 ) || { echo "环境问题: 临时 profile 安装失败"; rm -rf ~/.dsh/profiles/"$PROFILE"; exit 2; }
fi
[ -z "$PORT" ] && PORT=3099
LOG=/tmp/e2e-visual-server.log
OUT=${E2E_OUT:-/tmp/vis-e2e}
ENVFILE=/tmp/e2e-visual.env

cleanup() {
  [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null
  sleep 1
  if [ "$TEMP_PROFILE" = "1" ]; then rm -rf ~/.dsh/profiles/"$PROFILE"; fi
  rm -f "$ENVFILE"
}
trap cleanup EXIT

echo "== build =="
( cd "$REPO" && pnpm run build ) 2>&1 | tail -3
echo "== 起实例: profile=$PROFILE port=$PORT (临时=$TEMP_PROFILE) =="
cd /tmp
rm -f "$LOG"
setsid nohup dsh --profile "$PROFILE" --port "$PORT" --no-open > "$LOG" 2>&1 < /dev/null &
PID=$!
for i in $(seq 1 100); do grep -q 'token=' "$LOG" 2>/dev/null && break; sleep 0.5; done
TOKEN=$(grep -oP 'token=\K[\w-]+' "$LOG" | head -1)
LISTEN=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -z "$TOKEN" ] || [ "$LISTEN" != "$PID" ]; then
  echo "环境问题: 实例没起来（token=${TOKEN:-none} listen=${LISTEN:-none} pid=$PID）"; tail -20 "$LOG"; exit 2
fi
{
  echo "PORT=$PORT"
  echo "TOKEN=$TOKEN"
  echo "OUT=$OUT"
  echo "LOG=$LOG"
} > "$ENVFILE"
echo "== e2e =="
node "$REPO/tools/e2e-visual.mjs" --env-file "$ENVFILE" "${PASSTHRU[@]+"${PASSTHRU[@]}"}"
CODE=$?
echo "== e2e 退出码: $CODE =="
echo "== 服务端日志里的错误 =="
grep -iE '\berror\b|exception|failed' "$LOG" | head -10 || true
exit $CODE
