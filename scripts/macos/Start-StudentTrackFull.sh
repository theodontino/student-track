#!/bin/bash
set -euo pipefail

open_browser=1
if [ "${1:-}" = "--no-browser" ]; then
  open_browser=0
  shift
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "$script_dir/StudentTrack-Full.Common.sh"
student_track_require_macos
student_track_initialize_full_environment

runtime_root="$(student_track_runtime_root)"
app_root="$runtime_root/app"
node_root="$runtime_root/node"
student_track_assert_portable_node "$node_root"
export PATH="$node_root/bin:$PATH"
export NODE_ENV="production"
export NPM_CONFIG_OFFLINE="true"

required_server_files="$app_root/.next/required-server-files.json"
if [ ! -f "$app_root/.next/BUILD_ID" ] || [ ! -f "$required_server_files" ]; then
  echo "尚未安装完整的 Student Track Full 生产构建。" >&2
  exit 1
fi
"$node_root/bin/node" -e '
  const metadata = require(process.argv[1]);
  if (metadata.config?.env?.NEXT_PUBLIC_STUDENT_TRACK_EDITION !== "full") {
    throw new Error("当前生产构建不是 Student Track Full");
  }
' "$required_server_files"

port="${STUDENT_TRACK_PORT:-3000}"
cd "$app_root"
"$node_root/bin/npm" run start -- --hostname 127.0.0.1 --port "$port" &
server_pid=$!
cleanup() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for attempt in $(seq 1 60); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid"
    exit $?
  fi
  if /usr/bin/curl --fail --silent --show-error "http://127.0.0.1:$port/api/semesters" >/dev/null; then
    if [ "$open_browser" -eq 1 ] && [ "${CI:-}" != "true" ]; then
      /usr/bin/open "http://127.0.0.1:$port"
    fi
    wait "$server_pid"
    exit $?
  fi
  sleep 1
done

echo "Student Track Full 未在 60 秒内启动。" >&2
exit 1
