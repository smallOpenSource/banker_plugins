#!/bin/sh
# ./tests/run.sh: tests/tests.conf 의 스위트를 돌리고 스위트마다 한 줄로 결과를 보고 (banker init-dir)
# 종료 코드: 0 모두 통과, 1 실패 있음, 2 설정 없음, 3 Node 18 이상 없음
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
node_bin=${NODE:-node}
if ! "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1; then
  echo "Node 18 이상 필요: $node_bin" >&2
  exit 3
fi
exec "$node_bin" "$dir/run.mjs" "$@"
