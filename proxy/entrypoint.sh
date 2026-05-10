#!/bin/bash
set -euo pipefail

# Build /etc/proxy/filter.txt from server defaults + optional project allowlist.
# Glob entries (e.g. *.githubusercontent.com) are converted to extended regex.

DEFAULTS=/etc/proxy/allowlist.txt
PROJECT=/etc/proxy/project.txt
OUT=/etc/proxy/filter.txt

> "$OUT"
emit() {
  local host="$1"
  # Strip comments / empty
  [[ -z "$host" || "$host" =~ ^# ]] && return
  # Convert *.foo.com → \..*\.?foo\.com or just escape. tinyproxy uses POSIX extended regex.
  local escaped
  escaped=$(printf '%s' "$host" | sed -e 's/\./\\./g' -e 's/\*/.*/g')
  echo "^${escaped}\$" >> "$OUT"
}

while IFS= read -r line; do emit "$line"; done < "$DEFAULTS"
if [[ -f "$PROJECT" ]]; then
  echo "[proxy] merging project allowlist from $PROJECT"
  while IFS= read -r line; do emit "$line"; done < "$PROJECT"
fi

echo "[proxy] active filter:"
cat "$OUT" | sed 's/^/  /'

exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
