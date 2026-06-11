#!/bin/zsh
# Generates an Xcode project from the Safari build (requires full Xcode).
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/build.mjs
rm -rf platform/safari
mkdir -p platform

xcrun safari-web-extension-converter dist/safari \
  --project-location platform/safari \
  --app-name "Shortless" \
  --bundle-identifier de.digitmedia.Shortless \
  --macos-only \
  --no-open \
  --no-prompt \
  --force

echo ""
echo "Done. Xcode project: platform/safari"
echo "Open with: open platform/safari/Shortless/Shortless.xcodeproj"
