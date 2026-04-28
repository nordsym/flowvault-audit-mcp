#!/usr/bin/env bash
# Build flowvault-audit.mcpb (Claude Desktop Extension).
# Lives at mcpb/. Output goes to mcpb/dist/flowvault-audit.mcpb.
# Bundle ships compiled dist/, server entry, and pinned node_modules so the
# install is fully self-contained.
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
OUT_DIR="$(pwd)/dist"
OUTPUT="$OUT_DIR/flowvault-audit.mcpb"
ICON_SRC="./icon.png"
STAGE="$(mktemp -d -t flowvault-audit-mcpb.XXXXXX)"

echo "→ Ensuring TypeScript build is current"
( cd "$ROOT" && npx tsc -p . )

echo "→ Staging into $STAGE"
mkdir -p "$OUT_DIR"
cp manifest.json "$STAGE/manifest.json"

if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$STAGE/icon.png"
else
  echo "  (note: $ICON_SRC missing, packaging without icon)"
fi

mkdir -p "$STAGE/server/compiled"
cp server/package.json "$STAGE/server/package.json"
cp server/index.js     "$STAGE/server/index.js"
cp -R "$ROOT/dist/." "$STAGE/server/compiled/"

echo "→ Installing pinned node_modules into bundle"
( cd "$STAGE/server" && npm install --omit=dev --no-audit --no-fund --silent )

echo "→ Trimming bundle"
find "$STAGE/server/node_modules" -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name examples \) -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGE/server/node_modules" -type f \( -name "*.md" -o -name "*.markdown" -o -name "*.map" -o -name "LICENSE*" -o -name "CHANGELOG*" \) -delete 2>/dev/null || true

echo "→ Zipping → $OUTPUT"
rm -f "$OUTPUT"
( cd "$STAGE" && zip -qr "$OUTPUT" . )

rm -rf "$STAGE"
ls -lh "$OUTPUT"
echo "✓ flowvault-audit.mcpb ready"
