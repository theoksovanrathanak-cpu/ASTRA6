#!/usr/bin/env bash
# One-shot harness: the sandbox drops pip packages and /tmp between calls, so the server,
# the browser libs and Puppeteer are all prepared inside this single shell invocation.
set -u
cd /home/user/astra6-new || exit 1
PORT="${PORT:-8017}"

pip install -q uvicorn fastapi httpx requests python-dotenv 2>/dev/null
export VAPID_PRIVATE_KEY="$(grep -m1 VAPID_PRIVATE_KEY /tmp/vapid.txt 2>/dev/null | cut -d= -f2-)"
export VAPID_PUBLIC_KEY="$(grep -m1 VAPID_PUBLIC_KEY /tmp/vapid.txt 2>/dev/null | cut -d= -f2-)"

# browser libraries
if [ ! -d /tmp/libs/root/usr/lib/x86_64-linux-gnu ]; then
  mkdir -p /tmp/debs /tmp/libs
  ( cd /tmp/debs && apt-get download libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
    libxkbcommon0 libasound2t64 libxdamage1 libatspi2.0-0t64 libxcomposite1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libxfixes3 libdbus-1-3 libexpat1 libx11-6 libxcb1 libavahi-common3 \
    libavahi-client3 >/dev/null 2>&1 )
  for f in /tmp/debs/*.deb; do dpkg -x "$f" /tmp/libs/root; done
fi
export LD_LIBRARY_PATH=/tmp/libs/root/usr/lib/x86_64-linux-gnu:/tmp/libs/root/lib/x86_64-linux-gnu

# puppeteer
if [ ! -d /home/user/tools/node_modules/puppeteer ]; then
  ( cd /home/user/tools && npm i puppeteer --silent >/dev/null 2>&1 )
fi

setsid nohup python3 -m uvicorn main:app --host 127.0.0.1 --port "$PORT" > /tmp/uv.log 2>&1 &
for i in $(seq 1 40); do
  sleep 1
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/health" || true)
  [ "$code" = "200" ] && break
done
echo "server: $code"

LD_LIBRARY_PATH=/tmp/libs/root/usr/lib/x86_64-linux-gnu:/tmp/libs/root/lib/x86_64-linux-gnu PORT="$PORT" node "$1"
rc=$?
pkill -f "uvicorn main:app --host 127.0.0.1 --port $PORT" >/dev/null 2>&1
exit $rc
