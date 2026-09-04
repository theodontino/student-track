#!/bin/bash
set -euo pipefail

archive_path=""
scratch_root=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive)
      archive_path="$2"
      shift 2
      ;;
    --scratch)
      scratch_root="$2"
      shift 2
      ;;
    *)
      echo "未知参数：$1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$archive_path" ] || [ -z "$scratch_root" ]; then
  echo "必须提供 --archive 和 --scratch。" >&2
  exit 1
fi
archive_path="$(cd "$(dirname "$archive_path")" && pwd)/$(basename "$archive_path")"
if [ -e "$scratch_root" ]; then
  if [ ! -d "$scratch_root" ] || [ -n "$(find "$scratch_root" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "离线包验收目录必须为空：$scratch_root" >&2
    exit 1
  fi
else
  mkdir -p "$scratch_root"
fi

expanded_root="$scratch_root/expanded"
mkdir -p "$expanded_root"
/usr/bin/ditto -x -k "$archive_path" "$expanded_root"
package_root="$expanded_root/StudentTrackFull"
installer="$package_root/Install-StudentTrackFullOffline.command"

for required_path in \
  "$installer" \
  "$package_root/LICENSE" \
  "$package_root/source" \
  "$package_root/app/node_modules/prisma/build/index.js" \
  "$package_root/app/node_modules/pdfjs-dist/legacy/build/pdf.mjs" \
  "$package_root/app/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs" \
  "$package_root/app/node_modules/pdfjs-dist/cmaps/Adobe-GB1-UCS2.bcmap" \
  "$package_root/app/node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf" \
  "$package_root/app/node_modules/pdfjs-dist/iccs/CGATS001Compat-v2-micro.icc" \
  "$package_root/app/node_modules/pdfjs-dist/wasm/openjpeg.wasm" \
  "$package_root/app/.next/BUILD_ID" \
  "$package_root/app/src/generated/prisma/client.ts" \
  "$package_root/app/scripts/macos/Uninstall-StudentTrackFull.sh" \
  "$package_root/node/bin/node" \
  "$package_root/node/bin/npm"; do
  if [ ! -e "$required_path" ]; then
    echo "离线包缺少必要文件：$required_path" >&2
    exit 1
  fi
done

for forbidden_path in \
  "$package_root/app/data" \
  "$package_root/app/archives" \
  "$package_root/app/dev.db" \
  "$package_root/app/.env" \
  "$package_root/app/.git" \
  "$package_root/app/.next/dev" \
  "$package_root/app/.next/cache"; do
  if [ -e "$forbidden_path" ]; then
    echo "离线包包含不应发布的路径：$forbidden_path" >&2
    exit 1
  fi
done

export HOME="$scratch_root/home"
mkdir -p "$HOME/Desktop"
export STUDENT_TRACK_RUNTIME_ROOT="$HOME/Library/Application Support/Student Track"
export NPM_CONFIG_OFFLINE="true"
export HTTP_PROXY="http://127.0.0.1:9"
export HTTPS_PROXY="http://127.0.0.1:9"
export NO_PROXY="127.0.0.1,localhost"
export CI="true"

/bin/bash "$installer" --skip-desktop-shortcuts
installed_root="$STUDENT_TRACK_RUNTIME_ROOT"
database_path="$installed_root/database/student-track.db"
for required_path in \
  "$installed_root/app/.next/BUILD_ID" \
  "$installed_root/app/node_modules/prisma/build/index.js" \
  "$installed_root/node/bin/node" \
  "$installed_root/Start Student Track Full.command" \
  "$installed_root/Uninstall Student Track Full.command" \
  "$database_path"; do
  if [ ! -e "$required_path" ]; then
    echo "离线安装未写入必要文件：$required_path" >&2
    exit 1
  fi
done

port="3321"
stdout_log="$scratch_root/student-track-full.stdout.log"
stderr_log="$scratch_root/student-track-full.stderr.log"
server_pid=""

start_server() {
  STUDENT_TRACK_PORT="$port" /bin/bash "$installed_root/app/scripts/macos/Start-StudentTrackFull.sh" --no-browser >"$stdout_log" 2>"$stderr_log" &
  server_pid=$!
}

show_logs() {
  echo "::group::Offline Student Track Full stdout"
  tail -200 "$stdout_log" 2>/dev/null || true
  echo "::endgroup::"
  echo "::group::Offline Student Track Full stderr"
  tail -200 "$stderr_log" 2>/dev/null || true
  echo "::endgroup::"
}

wait_for_server() {
  for attempt in $(seq 1 60); do
    if ! kill -0 "$server_pid" 2>/dev/null; then
      show_logs
      echo "离线 Full 启动进程提前退出。" >&2
      exit 1
    fi
    if /usr/bin/curl --fail --silent --show-error "http://127.0.0.1:$port/api/semesters" >/dev/null; then
      return
    fi
    sleep 1
  done
  show_logs
  echo "离线 Full 未在 60 秒内启动。" >&2
  exit 1
}

stop_server() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  server_pid=""
}
trap stop_server EXIT

start_server
wait_for_server
listener_output="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN)"
if ! printf '%s\n' "$listener_output" | grep -q "127.0.0.1:$port"; then
  echo "离线 Full 生产服务没有只绑定 127.0.0.1。" >&2
  exit 1
fi

created_json="$(/usr/bin/curl --fail --silent --show-error \
  -X POST \
  -H 'Content-Type: application/json' \
  --data '{"name":"Offline Full CI Semester","startDate":"2099-01-01","endDate":"2099-06-30"}' \
  "http://127.0.0.1:$port/api/semesters")"
created_id="$("$installed_root/node/bin/node" -e 'const value=JSON.parse(process.argv[1]); if (!value.id) process.exit(1); process.stdout.write(value.id);' "$created_json")"
printf '%s\n' "preserved runtime marker" > "$installed_root/data/uninstall-preservation-marker.txt"

stop_server
start_server
wait_for_server
persisted_json="$(/usr/bin/curl --fail --silent --show-error "http://127.0.0.1:$port/api/semesters/$created_id")"
"$installed_root/node/bin/node" -e 'const value=JSON.parse(process.argv[1]); if (value.id !== process.argv[2]) process.exit(1);' "$persisted_json" "$created_id"
stop_server

/bin/bash "$installed_root/app/scripts/macos/Uninstall-StudentTrackFull.sh" --yes --skip-desktop-shortcuts
if [ ! -f "$database_path" ] || [ ! -f "$installed_root/data/uninstall-preservation-marker.txt" ]; then
  echo "卸载器删除了应保留的数据库或运行数据。" >&2
  exit 1
fi
for removed_path in "$installed_root/app" "$installed_root/node" "$installed_root/Start Student Track Full.command"; do
  if [ -e "$removed_path" ]; then
    echo "卸载器没有移除程序路径：$removed_path" >&2
    exit 1
  fi
done

/bin/bash "$installer" --skip-desktop-shortcuts
start_server
wait_for_server
persisted_json="$(/usr/bin/curl --fail --silent --show-error "http://127.0.0.1:$port/api/semesters/$created_id")"
"$installed_root/node/bin/node" -e 'const value=JSON.parse(process.argv[1]); if (value.id !== process.argv[2]) process.exit(1);' "$persisted_json" "$created_id"
stop_server
trap - EXIT
echo "macOS Full 离线包安装、卸载保留数据和重新安装验收通过。"
