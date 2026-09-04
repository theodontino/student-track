#!/bin/bash

student_track_require_macos() {
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "Student Track Full 脚本仅支持 macOS。" >&2
    return 1
  fi

  case "$(uname -m)" in
    arm64|x86_64) ;;
    *)
      echo "仅支持 Apple Silicon 或 Intel 64 位 Mac。" >&2
      return 1
      ;;
  esac
}

student_track_expected_node_arch() {
  if [ "$(uname -m)" = "arm64" ]; then
    printf '%s\n' "arm64"
  else
    printf '%s\n' "x64"
  fi
}

student_track_runtime_root() {
  if [ -n "${STUDENT_TRACK_RUNTIME_ROOT:-}" ]; then
    printf '%s\n' "$STUDENT_TRACK_RUNTIME_ROOT"
  else
    printf '%s\n' "$HOME/Library/Application Support/Student Track"
  fi
}

student_track_assert_portable_node() {
  local node_root="$1"
  local node_executable="$node_root/bin/node"
  local npm_executable="$node_root/bin/npm"

  if [ ! -x "$node_executable" ] || [ ! -x "$npm_executable" ]; then
    echo "Node.js 运行时不完整：$node_root" >&2
    return 1
  fi

  local node_version
  local node_architecture
  local npm_version
  node_version="$($node_executable --version)"
  node_architecture="$($node_executable -p 'process.arch')"
  npm_version="$($npm_executable --version)"
  case "$node_version" in
    v24.*) ;;
    *)
      echo "离线包需要 Node.js 24；当前为 $node_version。" >&2
      return 1
      ;;
  esac
  if [ "$node_architecture" != "$(student_track_expected_node_arch)" ]; then
    echo "Node.js 架构与当前 Mac 不一致：$node_architecture。" >&2
    return 1
  fi
  case "$npm_version" in
    11.*) ;;
    *)
      echo "离线包需要 npm 11；当前为 $npm_version。" >&2
      return 1
      ;;
  esac
}

student_track_initialize_full_environment() {
  STUDENT_TRACK_RUNTIME_ROOT="$(student_track_runtime_root)"
  STUDENT_TRACK_DATABASE_ROOT="$STUDENT_TRACK_RUNTIME_ROOT/database"
  STUDENT_TRACK_DATABASE_PATH="$STUDENT_TRACK_DATABASE_ROOT/student-track.db"
  STUDENT_TRACK_DATA_ROOT="${STUDENT_TRACK_DATA_ROOT:-$STUDENT_TRACK_RUNTIME_ROOT/data}"
  STUDENT_TRACK_ARCHIVES_ROOT="${STUDENT_TRACK_ARCHIVES_ROOT:-$STUDENT_TRACK_RUNTIME_ROOT/archives}"
  STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT="${STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT:-$STUDENT_TRACK_RUNTIME_ROOT/feedback-attachments}"
  STUDENT_TRACK_FEEDBACK_INBOX_ROOT="${STUDENT_TRACK_FEEDBACK_INBOX_ROOT:-$STUDENT_TRACK_RUNTIME_ROOT/feedback-inbox}"

  mkdir -p \
    "$STUDENT_TRACK_RUNTIME_ROOT" \
    "$STUDENT_TRACK_DATABASE_ROOT" \
    "$STUDENT_TRACK_DATA_ROOT" \
    "$STUDENT_TRACK_ARCHIVES_ROOT" \
    "$STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT" \
    "$STUDENT_TRACK_FEEDBACK_INBOX_ROOT"

  export STUDENT_TRACK_EDITION="full"
  export STUDENT_TRACK_RUNTIME_ROOT
  export STUDENT_TRACK_DATA_ROOT
  export STUDENT_TRACK_ARCHIVES_ROOT
  export STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT
  export STUDENT_TRACK_FEEDBACK_INBOX_ROOT
  export DATABASE_URL="file:$STUDENT_TRACK_DATABASE_PATH"
  export NEXT_TELEMETRY_DISABLED="1"
}
