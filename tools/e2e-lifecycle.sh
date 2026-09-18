#!/bin/bash
# e2e-lifecycle.sh — 真机跑完「建环境 → 启动 → 可达 → 停止」全链路并断言。
#
# 存在的理由：单测与 tools/e2e-visual.sh 都跑在**别人造好的** profile 上（复制 pm-test
# 的文件 + pnpm install），因此从没调用过我们自己的 createEnvironment / startEnvironment。
# 后果就是 docs/CODE-POLICY.md §7.5 记的两处：默认建出的环境必然起不来、就绪判据把
# 「TCP 可连接」当成「实例可用」。本脚本把这条路径变成每次都跑的断言。
#
# 引导块与 tools/e2e-visual.sh 同构（同一套「复制 pm-test + pnpm install + dsh --profile
# --port --no-open」），未抽公共文件：两个脚本的清理对象不同，抽出来反而要把 profile
# 生命周期参数化。重复的就是这 15 行，已在此显式记明。
#
# 用法：bash tools/e2e-lifecycle.sh
# 退出码：0 全通过；1 有断言失败；2 环境问题（起不来等）。
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
SRC=$HOME/.dsh/profiles/pm-test
HOST_PROFILE=pm-life-$$
HOST_PORT=$(( (RANDOM % 200) + 3500 ))
ENV_A=pm-life-a-$$
ENV_B=pm-life-b-$$
LOG=/tmp/e2e-lifecycle-host.log
FAILED=0
PASSED=0

cleanup() {
  [ -n "${HPID:-}" ] && kill "$HPID" 2>/dev/null
  for env in "$ENV_A" "$ENV_B"; do
    pkill -f -- "--profile $env" 2>/dev/null
  done
  sleep 1
  rm -rf "$HOME/.dsh/profiles/$HOST_PROFILE" "$HOME/.dsh/profiles/$ENV_A" "$HOME/.dsh/profiles/$ENV_B"
}
trap cleanup EXIT

[ -d "$SRC" ] || { echo "环境问题: 找不到 $SRC"; exit 2; }
rm -rf "$HOME/.dsh/profiles/$HOST_PROFILE" "$HOME/.dsh/profiles/$ENV_A" "$HOME/.dsh/profiles/$ENV_B"
mkdir -p "$HOME/.dsh/profiles/$HOST_PROFILE"
for f in package.json cordis.yml cordis.patch.yml pnpm-workspace.yaml pnpm-lock.yaml; do
  cp "$SRC/$f" "$HOME/.dsh/profiles/$HOST_PROFILE/$f" 2>/dev/null || true
done
( cd "$HOME/.dsh/profiles/$HOST_PROFILE" && pnpm install --prefer-offline >/dev/null 2>&1 ) \
  || { echo "环境问题: 临时宿主 profile 安装失败"; exit 2; }

( cd "$REPO" && pnpm run build ) 2>&1 | tail -2

cd /tmp
rm -f "$LOG"
setsid nohup dsh --profile "$HOST_PROFILE" --port "$HOST_PORT" --no-open > "$LOG" 2>&1 < /dev/null &
HPID=$!
for i in $(seq 1 120); do grep -q 'token=' "$LOG" 2>/dev/null && break; sleep 0.5; done
TOKEN=$(grep -oP 'token=\K[\w-]+' "$LOG" | head -1)
[ -z "$TOKEN" ] && { echo "环境问题: 宿主实例没起来"; tail -20 "$LOG"; exit 2; }
echo "== 宿主实例: profile=$HOST_PROFILE port=$HOST_PORT =="

# 调一个 op：$1=op $2=body(JSON) → 打印一行 "http_code<TAB>响应体"
op() {
  curl -s -m 180 -w '\n%{http_code}' -X POST "http://127.0.0.1:$HOST_PORT/api2/companion/$1" \
    -H "authorization: Bearer $TOKEN" -H "origin: http://127.0.0.1:$HOST_PORT" \
    -H 'content-type: application/json' -d "$2"
}
# 取 JSON 字段：$1=JSON $2=表达式（形如 value.code）
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=$2;process.stdout.write(v===undefined?'':String(v))}catch(e){process.stdout.write('')}})" <<< "$1"; }

check() { # $1=名称 $2=实际 $3=期望
  if [ "$2" = "$3" ]; then echo "  PASS $1 — $2"; PASSED=$((PASSED+1))
  else echo "  FAIL $1 — 实际=$2 期望=$3"; FAILED=1; fi
}
# curl 连不上时自己就打印 000；再 || echo "000" 会得到 000000（本行原本就是这样一个 bug）。
probe() { curl -s -o /dev/null -m 8 -w '%{http_code}' "http://127.0.0.1:$1/" 2>/dev/null; }

echo "== 1. environmentTemplates 逐字来自官方 PROFILE_TEMPLATES =="
R=$(op environmentTemplates '{}' | head -1)
check "默认模板是 web" "$(field "$R" 'j.value.default')" "web"
check "模板数量" "$(field "$R" 'j.value.templates.length')" "5"
check "web 模板层栈" "$(field "$R" "JSON.stringify(j.value.templates.find(t=>t.name==='web').bundles)")" '["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]'

echo "== 2. 省略模板建环境：必须是官方 web 层栈（旧代码这里是 base-only）=="
R=$(op createEnvironment "{\"name\":\"$ENV_A\"}" | head -1)
check "createEnvironment ok" "$(field "$R" 'j.value.ok')" "true"
BUNDLES=$(node -e "const m=require('$HOME/.dsh/profiles/$ENV_A/package.json');process.stdout.write(JSON.stringify(m.dsh.profile.bundles))")
check "落盘层栈" "$BUNDLES" '["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]'

echo "== 3. 启动（后台）并按官方语义判定就绪 =="
R=$(op startEnvironment "{\"name\":\"$ENV_A\",\"background\":true}" | head -1)
check "startEnvironment ok" "$(field "$R" 'j.value.ok')" "true"
A_PORT=$(field "$R" "j.value.output.match(/127\\.0\\.0\\.1:(\\d+)/)?.[1]")
echo "  端口=$A_PORT"
if [ -n "$A_PORT" ]; then
  IMM=$(probe "$A_PORT")
  # 旧判据（只看 TCP 可连接）会在这里交出一个 404 的地址：实测 628ms 首个应答 404、838ms 才 401。
  check "返回那一刻就已经可用（不是 404）" "$IMM" "401"
  TOKURL=$(field "$R" "j.value.output.match(/http:\\/\\/127\\.0\\.0\\.1:\\d+\\/?\\?token=[\\w-]+/)?.[0]")
  if [ -n "$TOKURL" ]; then
    REDIR=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$TOKURL" 2>/dev/null || echo "000")
    check "带 token 的可用地址真的能用" "$REDIR" "303"
  else
    echo "  FAIL 结果里没有带 token 的可用地址"; FAILED=1
  fi
fi

echo "== 4. 停止后端口必须释放 =="
R=$(op stopEnvironment "{\"name\":\"$ENV_A\"}" | head -1)
check "stopEnvironment ok" "$(field "$R" 'j.value.ok')" "true"
sleep 1
if [ -n "$A_PORT" ]; then
  check "停止后不可达" "$(probe "$A_PORT")" "000"
fi

echo "== 5. 没有 web 层的环境：必须即时给出可操作的拒绝，而不是干等 30 秒 =="
op createEnvironment "{\"name\":\"$ENV_B\",\"template\":\"headless\"}" >/dev/null
T0=$(date +%s%N)
R=$(op startEnvironment "{\"name\":\"$ENV_B\"}" | head -1)
T1=$(date +%s%N)
ELAPSED=$(( (T1 - T0) / 1000000 ))
check "如实拒绝" "$(field "$R" 'j.value.code')" "no-web-layer"
if [ "$ELAPSED" -lt 5000 ]; then echo "  PASS 拒绝耗时 <5s — ${ELAPSED}ms"; PASSED=$((PASSED+1))
else echo "  FAIL 拒绝耗时 ${ELAPSED}ms（应远小于 30s 超时）"; FAILED=1; fi
if grep -q '@deepseek-ai/dsh-web-app' <<< "$(field "$R" 'j.value.output')"; then
  echo "  PASS 拒绝文案给出了可操作的下一步"; PASSED=$((PASSED+1))
else echo "  FAIL 拒绝文案没有说明该怎么办"; FAILED=1; fi

echo "== 6. 收尾：端口与进程无残留 =="
R=$(op listEnvironments '{}' | head -1)
LEFTOVER=$(field "$R" "JSON.stringify(j.value.filter(e=>e.name==='$ENV_A'||e.name==='$ENV_B').map(e=>e.runs.length))")
check "两个环境都没有运行中的实例" "$LEFTOVER" "[0,0]"

echo ""
echo "结果: $PASSED 项通过"
[ "$FAILED" = "0" ] || { echo "存在失败断言 —— 生命周期门禁未通过"; exit 1; }
echo "生命周期门禁通过"
