#!/bin/bash
# market-realdevice.sh — task-41 的真机取证编排：装隔离环境 → 起实例（自有号段端口）→ 跑浏览器取证 → 自清。
#
# 为什么需要它：本仓库的单元测试跑 dist 产物，但"安装到底能不能过官方 inspect""索引不可用时页面写什么"
# 这两件事只有真机（真实例 + 真官方 inspect + 真浏览器）能证明。编排必须与验证在同一次调用内完成，
# 否则进程会随调用被回收（这是 tools/e2e-visual.sh 已经踩过的教训，流程照它，未复制代码）。
#
# 与 tools/e2e-visual.sh 的差别：本脚本**不碰 ~/.dsh**——自己造一个临时 DSH_HOME（Link 到本仓库），
# 装任何东西只装进那个临时环境；跑完连临时 HOME 一起删。
#
# 用法（默认端口 3531，落在 task-41 约定的 3530–3539 号段内）：
#   bash tests/market-realdevice.sh                 # 三段取证：正常 / 索引不可用 / 过期缓存
#   bash tests/market-realdevice.sh --port 3532
# 产物：/tmp/pmc-evidence/*.png + *.json（断网态用死代理 HTTPS_PROXY=http://127.0.0.1:9 模拟）
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
PORT=3531
OUT=/tmp/pmc-evidence
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) shift 1 ;;
  esac
done
HOME_DIR=/tmp/pmc-realdevice-$PORT
SRC_PROFILE=${SRC_PROFILE:-/home/sixiao/.dsh/profiles/pm-test}
LOG_PREFIX=/tmp/pmc-realdevice-$PORT
mkdir -p "$OUT"

boot() {  # $1=日志名，$2..=额外环境变量
  local log="$1"; shift
  rm -f "$log"
  ( cd /tmp && env "$@" DSH_HOME="$HOME_DIR" setsid nohup dsh --profile web --port "$PORT" --no-open > "$log" 2>&1 < /dev/null & )
  for i in $(seq 1 90); do
    R=$(curl -s -m 2 -X POST -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$PORT/api2/companion/capabilities" 2>/dev/null)
    case "$R" in *'"ok"'*) echo "  route ready after ${i}s"; return 0;; esac
    sleep 1
  done
  echo "  实例没起来（看 $log）"; return 1
}
# 停止实例：**按端口占用者杀**，不是杀 $!。
# 为什么：dsh 经由 setsid 起在独立会话里，$!（env/setsid 那层）死掉不代表 dsh 死掉——实测残留的旧实例
# 会继续占着端口，后续段落于是"以为起来了"，其实连的是上一段没有代理的环境（这个坑花了半轮才定位）。
stop() {
  local pid
  pid=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1)
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; fi
  for i in $(seq 1 20); do
    ss -ltn 2>/dev/null | grep -q ":$PORT " || break
    sleep 0.5
  done
  rm -f "$LOG_PREFIX.pid"
}
token_of() { grep -oP 'token=\K[\w-]+' "$1" | head -1; }

cleanup() {
  stop
  rm -rf "$HOME_DIR"
  rm -f "$LOG_PREFIX"*.log
}
trap cleanup EXIT

echo "== 准备隔离环境 $HOME_DIR（profile 从 $SRC_PROFILE 复制，插件 link 到 $REPO）=="
rm -rf "$HOME_DIR"; mkdir -p "$HOME_DIR/profiles/web"
for f in package.json cordis.yml cordis.patch.yml pnpm-workspace.yaml pnpm-lock.yaml; do
  cp "$SRC_PROFILE/$f" "$HOME_DIR/profiles/web/$f" 2>/dev/null || true
done
node -e '
const fs = require("node:fs")
const p = process.argv[1] + "/profiles/web/package.json"
const json = JSON.parse(fs.readFileSync(p, "utf8"))
json.name = "dsh-profile-realdevice"
json.dependencies = Object.assign({}, json.dependencies, { "dsh-plugin-manager-companion": "link:" + process.argv[2] })
fs.writeFileSync(p, JSON.stringify(json, null, 2) + "\n")
' "$HOME_DIR" "$REPO"
( cd "$HOME_DIR/profiles/web" && pnpm install --prefer-offline >/dev/null 2>&1 ) || { echo "环境问题: 临时 profile 安装失败"; exit 2; }
# pnpm 会把 link: 依赖写成**相对**软链（相对临时 profile 的深度），在我们这个 /tmp 临时 HOME 里指向不存在的路径
# ——实测 "cannot resolve profile bundle"。这里改成绝对目标（只动临时环境里的那个软链）。
ln -sfn "$REPO" "$HOME_DIR/profiles/web/node_modules/dsh-plugin-manager-companion"

echo "== 段 1/3：正常索引（市场页 + 中文搜索）=="
boot "$LOG_PREFIX-normal.log" || exit 2
TOKEN=$(token_of "$LOG_PREFIX-normal.log")
node "$REPO/tests/market-browser-evidence.mjs" --port "$PORT" --token "$TOKEN" --phase normal --out "$OUT" | tail -20
echo "-- 徽标/筛选/详情 取证（task-46）--"
POLICY_DUP_QUERY="${POLICY_DUP_QUERY:-vision}" POLICY_DUP_VALUE="${POLICY_DUP_VALUE:-vision}" \
  node "$REPO/tests/market-policy-evidence.mjs" --port "$PORT" --token "$TOKEN" --out "$OUT" | tail -45
stop

echo "== 段 2/3：索引不可用（死代理 + 无缓存）=="
rm -f "$HOME_DIR/plugin-manager-companion/registry-index.json"
boot "$LOG_PREFIX-dead.log" HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 || exit 2
TOKEN=$(token_of "$LOG_PREFIX-dead.log")
node "$REPO/tests/market-browser-evidence.mjs" --port "$PORT" --token "$TOKEN" --phase dead --out "$OUT" | tail -15
stop

echo "== 段 3/3：过期缓存（死代理 + 5 天前的缓存文件）=="
mkdir -p "$HOME_DIR/plugin-manager-companion"
node -e '
const fs = require("node:fs")
const dir = process.argv[1] + "/plugin-manager-companion"
fs.writeFileSync(dir + "/registry-index.json", JSON.stringify({
  savedAt: Date.now(),
  generatedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
  repos: [{ repo: "demo/one", name: "one", description: "缓存里的条目", stars: 3, updatedAt: null, topics: [], category: "tool" }],
}) + "\n")
' "$HOME_DIR"
boot "$LOG_PREFIX-stale.log" HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 || exit 2
TOKEN=$(token_of "$LOG_PREFIX-stale.log")
node "$REPO/tests/market-browser-evidence.mjs" --port "$PORT" --token "$TOKEN" --phase dead --out "$OUT" | tail -15
stop

echo "== 完成：截图与读取结果在 $OUT，临时环境已删 =="
