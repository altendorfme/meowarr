#!/bin/sh
set -e

if [ -d /app/data ]; then
  marker=/app/data/.meowarr-owner-fixed
  current_owner=$(stat -c '%U' /app/data 2>/dev/null || echo unknown)
  if [ ! -f "$marker" ] || [ "$current_owner" != "app" ]; then
    chown -R app:app /app/data 2>/dev/null || true
    touch "$marker" 2>/dev/null || true
    chown app:app "$marker" 2>/dev/null || true
  fi
fi

exec su-exec app:app "$@"
