#!/bin/bash
set -euo pipefail

package_root=""
skip_desktop_shortcuts=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --package-root)
      package_root="$2"
      shift 2
      ;;
    --skip-desktop-shortcuts)
      skip_desktop_shortcuts=1
      shift
      ;;
    *)
      echo "未知参数：$1" >&2
      exit 1
      ;;
  esac
done

script_dir="$(cd "$(dirname "$0")" && pwd)"
if [ -z "$package_root" ]; then
  package_root="$(cd "$script_dir/../../.." && pwd)"
fi
package_app="$package_root/app"
package_node="$package_root/node"
common_script="$package_app/scripts/macos/StudentTrack-Full.Common.sh"

for required_path in "$package_app" "$package_node" "$common_script"; do
  if [ ! -e "$required_path" ]; then
    echo "离线安装包不完整，缺少：$required_path" >&2
    exit 1
  fi
done

# shellcheck source=/dev/null
source "$common_script"
student_track_require_macos

runtime_root="$(student_track_runtime_root)"
app_root="$runtime_root/app"
node_root="$runtime_root/node"
start_launcher="$runtime_root/Start Student Track Full.command"
uninstall_launcher="$runtime_root/Uninstall Student Track Full.command"
runtime_data_roots=(
  "$runtime_root/database"
  "$runtime_root/data"
  "$runtime_root/feedback-attachments"
  "$runtime_root/feedback-inbox"
  "$runtime_root/archives"
)

for existing_program_path in "$app_root" "$node_root" "$start_launcher"; do
  if [ -e "$existing_program_path" ]; then
    echo "检测到已有 Student Track Full 程序：$existing_program_path" >&2
    echo "请先运行卸载器；数据库和运行数据会保留。" >&2
    exit 1
  fi
done

runtime_root_existed=0
if [ -d "$runtime_root" ]; then
  runtime_root_existed=1
fi
preexisting_data_roots=()
for runtime_data_root in "${runtime_data_roots[@]}"; do
  if [ -e "$runtime_data_root" ]; then
    preexisting_data_roots+=("1")
  else
    preexisting_data_roots+=("0")
  fi
done

install_complete=0
cleanup_failed_install() {
  local exit_code=$?
  if [ "$install_complete" -eq 0 ]; then
    rm -rf "$app_root" "$node_root"
    rm -f "$start_launcher" "$uninstall_launcher"
    local index=0
    for runtime_data_root in "${runtime_data_roots[@]}"; do
      if [ "${preexisting_data_roots[$index]}" = "0" ]; then
        rm -rf "$runtime_data_root"
      fi
      index=$((index + 1))
    done
    if [ "$runtime_root_existed" -eq 0 ] && [ -d "$runtime_root" ]; then
      rmdir "$runtime_root" 2>/dev/null || true
    fi
    echo "离线安装未完成；本次创建的程序已移除，既有教学数据没有改动。" >&2
  fi
  exit "$exit_code"
}
trap cleanup_failed_install EXIT

mkdir -p "$runtime_root"
/usr/bin/ditto "$package_app" "$app_root"
/usr/bin/ditto "$package_node" "$node_root"

# shellcheck source=/dev/null
source "$app_root/scripts/macos/StudentTrack-Full.Common.sh"
student_track_assert_portable_node "$node_root"
student_track_initialize_full_environment

export PATH="$node_root/bin:$PATH"
export NPM_CONFIG_OFFLINE="true"
required_server_files="$app_root/.next/required-server-files.json"
prisma_cli="$app_root/node_modules/prisma/build/index.js"
generated_client="$app_root/src/generated/prisma/client.ts"
for required_file in "$required_server_files" "$app_root/.next/BUILD_ID" "$prisma_cli" "$generated_client"; do
  if [ ! -f "$required_file" ]; then
    echo "离线安装包缺少必要文件：$required_file" >&2
    exit 1
  fi
done
"$node_root/bin/node" -e '
  const metadata = require(process.argv[1]);
  if (metadata.config?.env?.NEXT_PUBLIC_STUDENT_TRACK_EDITION !== "full") {
    throw new Error("当前生产构建不是 Student Track Full");
  }
' "$required_server_files"

cd "$app_root"
if [ -s "$STUDENT_TRACK_DATABASE_PATH" ]; then
  "$node_root/bin/npm" run db:backup
  "$node_root/bin/npm" run db:verify-backup
else
  : > "$STUDENT_TRACK_DATABASE_PATH"
fi
"$node_root/bin/node" "$prisma_cli" migrate deploy

printf '%s\n' \
  '#!/bin/bash' \
  'set -e' \
  'runtime_root="$(cd "$(dirname "$0")" && pwd)"' \
  'exec /bin/bash "$runtime_root/app/scripts/macos/Start-StudentTrackFull.sh" "$@"' \
  > "$start_launcher"
printf '%s\n' \
  '#!/bin/bash' \
  'set -e' \
  'runtime_root="$(cd "$(dirname "$0")" && pwd)"' \
  'exec /bin/bash "$runtime_root/app/scripts/macos/Uninstall-StudentTrackFull.sh" "$@"' \
  > "$uninstall_launcher"
chmod 700 "$start_launcher" "$uninstall_launcher"

if [ "$skip_desktop_shortcuts" -eq 0 ]; then
  desktop_root="$HOME/Desktop"
  if [ -d "$desktop_root" ]; then
    ln -sfn "$start_launcher" "$desktop_root/Student Track Full.command"
    ln -sfn "$uninstall_launcher" "$desktop_root/Uninstall Student Track Full.command"
  else
    echo "没有找到桌面目录；请直接运行：$start_launcher"
  fi
fi

install_complete=1
trap - EXIT
echo "Student Track Full 离线安装完成。"
echo "程序目录：$app_root"
echo "数据目录：$runtime_root"
echo "启动入口：$start_launcher"
echo "卸载入口：$uninstall_launcher"
