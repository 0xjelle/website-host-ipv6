#!/bin/sh
# Container entrypoint: run HexaHost, then start BIRD once the generated
# config exists so BGP-over-tunnel works inside the container too.
set -e

node server/index.js &
NODE_PID=$!

(
  i=0
  while [ ! -f "${DATA_DIR:-/data}/bird/bird.conf" ] && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done
  if [ -f "${DATA_DIR:-/data}/bird/bird.conf" ] && command -v bird >/dev/null 2>&1; then
    bird -c "${DATA_DIR:-/data}/bird/bird.conf" || echo "bird failed to start (BGP disabled)"
  fi
) &

wait $NODE_PID
