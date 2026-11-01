#!/bin/sh
# ./scripts/stop.sh: 서비스와 감독 프로세스를 멈춤 (banker init-dir)
# 종료 코드: 0 성공, 1 실패, 2 설정 없음, 3 Node 18 이상 없음
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
node_bin=${NODE:-node}
if ! "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1; then
  echo "Node 18 이상 필요: $node_bin" >&2
  exit 3
fi
exec "$node_bin" "$dir/lib/service.mjs" stop "$@"
