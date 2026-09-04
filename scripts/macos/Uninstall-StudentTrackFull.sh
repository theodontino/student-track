#!/bin/bash
set -euo pipefail

skip_confirmation=0
skip_desktop_shortcuts=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes)
      skip_confirmation=1
      shift
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
# shellcheck source=/dev/null
source "$script_dir/StudentTrack-Full.Common.sh"
student_track_require_macos

runtime_root="$(student_track_runtime_root)"
case "$runtime_root" in
  ""|"/"|"$HOME")
    echo "拒绝使用过宽的卸载目录：$runtime_root" >&2
    exit 1
    ;;
esac

app_root="$runtime_root/app"
node_root="$runtime_root/node"
start_launcher="$runtime_root/Start Student Track Full.command"
uninstall_launcher="$runtime_root/Uninstall Student Track Full.command"

if [ ! -d "$runtime_root" ]; then
  echo "没有找到 Student Track Full 安装目录：$runtime_root"
  exit 0
fi

if [ "$skip_confirmation" -eq 0 ]; then
  echo "将卸载 Student Track Full 程序和便携 Node。"
  echo "数据库、LLM 设置、附件、收件箱和备份会保留在：$runtime_root"
  printf '%s' "输入 UNINSTALL 继续："
  read -r confirmation
  if [ "$confirmation" != "UNINSTALL" ]; then
    echo "已取消卸载。"
    exit 1
  fi
fi

if command -v lsof >/dev/null 2>&1; then
  for listener_pid in $(lsof -tiTCP:3000 -sTCP:LISTEN 2>/dev/null || true); do
    listener_command="$(ps -p "$listener_pid" -o command= 2>/dev/null || true)"
    case "$listener_command" in
      *"$node_root"*|*"$app_root"*)
        kill "$listener_pid" 2>/dev/null || true
        ;;
    esac
  done
fi

cd "$HOME"
rm -rf "$app_root" "$node_root"
rm -f "$start_launcher"
if [ "$skip_desktop_shortcuts" -eq 0 ] && [ -d "$HOME/Desktop" ]; then
  rm -f "$HOME/Desktop/Student Track Full.command"
  rm -f "$HOME/Desktop/Uninstall Student Track Full.command"
fi
rm -f "$uninstall_launcher"

echo "Student Track Full 程序已卸载。"
echo "数据库和运行数据仍保留在：$runtime_root"
echo "再次运行安装器可以继续使用原数据库。"
