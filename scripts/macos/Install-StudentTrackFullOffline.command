#!/bin/bash
set -euo pipefail

package_root="$(cd "$(dirname "$0")" && pwd)"
exec /bin/bash "$package_root/app/scripts/macos/Install-StudentTrackFullOffline.sh" --package-root "$package_root" "$@"
