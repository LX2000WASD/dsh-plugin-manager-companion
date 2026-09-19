#!/bin/sh
# 兼容壳：真实现已 Node 化（零 bash），见 tools/e2e-lifecycle.mjs。
# 保留它只为不破坏既有用法（bash tools/e2e-lifecycle.sh）与引用它的文档；
# 平台审计 W-24 的 Node 化落地后，真机证据由 .mjs 产出，本壳零逻辑。
# Windows 上直接跑：node tools/e2e-lifecycle.mjs
exec node "$(dirname "$0")/e2e-lifecycle.mjs" "$@"
