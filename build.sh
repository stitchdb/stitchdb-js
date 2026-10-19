#!/bin/sh
# Build stitchdb-js: ES module, CommonJS and a browser script (dist/stitchdb.js, global `stitchdb`).
set -e
cd "$(dirname "$0")"
B=node_modules/.bin/esbuild
# Presence only syncs between clients when the join config says presence.enabled (newer Realtime servers).
for f in node_modules/@supabase/realtime-js/dist/*/RealtimeChannel.js; do
  grep -q "enabled: !!(presence" "$f" || sed -i 's/^\( *\)presence,$/\1presence: Object.assign({}, presence, { enabled: !!(presence \&\& presence.enabled) || !!(this.bindings.presence \&\& this.bindings.presence.length) }),/' "$f"
done
mkdir -p dist
$B src/index.js --bundle --format=esm --platform=browser --target=es2020 --minify --outfile=dist/index.mjs --log-level=error
$B src/index.js --bundle --format=cjs --platform=node --target=node18 --minify --outfile=dist/index.cjs --log-level=error
$B src/index.js --bundle --format=iife --global-name=stitchdb --platform=browser --target=es2020 --minify --outfile=dist/stitchdb.js --log-level=error
sed -i 's/`supabase-js-/`stitchdb-js-/g' dist/index.mjs dist/index.cjs dist/stitchdb.js
cp types/index.d.ts dist/index.d.ts
echo "built stitchdb-js $(node -p "require('./package.json').version")"
