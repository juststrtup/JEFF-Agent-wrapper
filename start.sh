#!/usr/bin/env bash
# start.sh — Dual-process launcher for Render free tier
# Starts the Node sidecar (Express on :3000) in background,
# then starts uvicorn in foreground so Render tracks the main process.

set -e

echo "[start.sh] Checking for compiled sidecar at dist/server.js..."
if [ ! -f "dist/server.js" ]; then
  echo "[start.sh] ERROR: dist/server.js not found. Did tsc run? Listing dist/:"
  ls -la dist/ 2>/dev/null || echo "[start.sh] dist/ directory does not exist"
  echo "[start.sh] Listing root directory .ts files:"
  ls -la *.ts 2>/dev/null || echo "[start.sh] No .ts files found"
  exit 1
fi

echo "[start.sh] Starting Node sidecar (dist/server.js) on port ${SIDECAR_PORT:-3000}..."
node dist/server.js &
NODE_PID=$!

# Give the sidecar time to bind the port
sleep 2

echo "[start.sh] Starting FastAPI (uvicorn) on port $PORT..."
alembic upgrade head
exec uvicorn main:app --host 0.0.0.0 --port "$PORT"
