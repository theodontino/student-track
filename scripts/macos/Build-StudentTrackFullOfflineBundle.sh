#!/bin/bash
set -euo pipefail

output_directory=""
node_root=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      output_directory="$2"
      shift 2
      ;;
    --node-root)
      node_root="$2"
      shift 2
      ;;
    *)
      echo "未知参数：$1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$output_directory" ]; then
  echo "必须使用 --output 指定空输出目录。" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
project_root="$(cd "$script_dir/../.." && pwd)"
# shellcheck source=/dev/null
source "$script_dir/StudentTrack-Full.Common.sh"
student_track_require_macos

if [ -z "$node_root" ]; then
  node_executable="$(command -v node)"
  node_root="$(cd "$(dirname "$node_executable")/.." && pwd)"
fi
student_track_assert_portable_node "$node_root"

if [ "${STUDENT_TRACK_EDITION:-}" != "full" ]; then
  echo "离线包只能从 STUDENT_TRACK_EDITION=full 的生产构建创建。" >&2
  exit 1
fi

for required_path in \
  "$project_root/package.json" \
  "$project_root/node_modules" \
  "$project_root/.next/BUILD_ID" \
  "$project_root/.next/required-server-files.json" \
  "$project_root/src/generated/prisma/client.ts"; do
  if [ ! -e "$required_path" ]; then
    echo "离线包缺少已安装依赖、Prisma 生成物或 Full 生产构建：$required_path" >&2
    exit 1
  fi
done

"$node_root/bin/node" -e '
  const metadata = require(process.argv[1]);
  if (metadata.config?.env?.NEXT_PUBLIC_STUDENT_TRACK_EDITION !== "full") {
    throw new Error("当前生产构建不是 Student Track Full");
  }
' "$project_root/.next/required-server-files.json"

if [ -n "$(git -C "$project_root" status --porcelain)" ]; then
  echo "离线包只能从干净的已提交工作区创建。" >&2
  exit 1
fi

if [ -e "$output_directory" ]; then
  if [ ! -d "$output_directory" ] || [ -n "$(find "$output_directory" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "离线包输出目录必须为空：$output_directory" >&2
    exit 1
  fi
else
  mkdir -p "$output_directory"
fi

version="$($node_root/bin/node -p "require('$project_root/package.json').version")"
source_commit="$(git -C "$project_root" rev-parse HEAD)"
node_version="$($node_root/bin/node --version)"
node_architecture="$($node_root/bin/node -p 'process.arch')"
stage_root="$output_directory/stage"
bundle_root="$stage_root/StudentTrackFull"
bundle_app="$bundle_root/app"
bundle_node="$bundle_root/node"
source_archive="$stage_root/student-track-source.zip"
archive_path="$output_directory/StudentTrackFull-macOS-$node_architecture-$version.zip"

mkdir -p "$bundle_app" "$bundle_node"
git -C "$project_root" archive --format=tar HEAD | tar -xf - -C "$bundle_app"
/usr/bin/ditto "$project_root/node_modules" "$bundle_app/node_modules"
mkdir -p "$bundle_app/src/generated/prisma"
/usr/bin/ditto "$project_root/src/generated/prisma" "$bundle_app/src/generated/prisma"
/usr/bin/ditto "$project_root/.next" "$bundle_app/.next"
rm -rf "$bundle_app/.next/cache" "$bundle_app/.next/dev"
/usr/bin/ditto "$node_root" "$bundle_node"

cp "$script_dir/Install-StudentTrackFullOffline.command" "$bundle_root/Install-StudentTrackFullOffline.command"
chmod 700 "$bundle_root/Install-StudentTrackFullOffline.command"
cp "$project_root/LICENSE" "$bundle_root/LICENSE"
git -C "$project_root" archive --format=zip --output="$source_archive" HEAD
mkdir -p "$bundle_root/source"
cp "$source_archive" "$bundle_root/source/student-track-$version-source.zip"

printf '%s\n' \
  '{' \
  '  "product": "Student Track Full",' \
  "  \"version\": \"$version\"," \
  '  "edition": "full",' \
  "  \"sourceCommit\": \"$source_commit\"," \
  "  \"nodeVersion\": \"$node_version\"," \
  "  \"architecture\": \"$node_architecture\"" \
  '}' \
  > "$bundle_root/BUILD-INFO.json"

for forbidden_path in \
  "$bundle_app/data" \
  "$bundle_app/archives" \
  "$bundle_app/dev.db" \
  "$bundle_app/dev.db-wal" \
  "$bundle_app/dev.db-shm" \
  "$bundle_app/.env" \
  "$bundle_app/feedback-attachments" \
  "$bundle_app/feedback-inbox" \
  "$bundle_app/.git" \
  "$bundle_app/.next/dev" \
  "$bundle_app/.next/cache"; do
  if [ -e "$forbidden_path" ]; then
    echo "离线包包含不应发布的路径：$forbidden_path" >&2
    exit 1
  fi
done

/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$bundle_root" "$archive_path"
rm -rf "$stage_root"
echo "已创建 macOS Full 离线包：$archive_path"
