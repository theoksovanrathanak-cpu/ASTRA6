#!/usr/bin/env bash
# Rebuild the committed bundle. Node is only needed here, never on the server: the
# output in assets/ is what ships, so the Python image has no JavaScript toolchain.
set -euo pipefail
cd "$(dirname "$0")/.."
npm install --no-audit --no-fund --loglevel=error react@18.3.1 react-dom@18.3.1 esbuild@0.21.5
./node_modules/.bin/esbuild terminal/src/main.jsx \
  --bundle --minify --format=iife --loader:.jsx=jsx --jsx=automatic \
  --define:process.env.NODE_ENV='"production"' \
  --outfile=terminal/assets/app.js --log-level=warning
echo "built terminal/assets/app.js and app.css"
