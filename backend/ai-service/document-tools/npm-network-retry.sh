#!/bin/sh
# Retry dependency downloads, never the application build or a broken lockfile.
set -eu

case "${1:-}" in
    ci|prune) ;;
    *) echo "Only npm ci and npm prune are supported" >&2; exit 64 ;;
esac

log=$(mktemp)
trap 'rm -f "$log"' EXIT HUP INT TERM
attempt=1
while :; do
    if npm "$@" --prefer-offline --fetch-retries=0 --fetch-timeout=60000 >"$log" 2>&1; then
        cat "$log"
        exit 0
    else
        status=$?
    fi
    cat "$log" >&2
    if [ "$attempt" -ge 3 ] || ! grep -Eq '^npm (error|ERR!) code (ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|ERR_SOCKET_TIMEOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|E408|E429|E500|E502|E503|E504)$' "$log"; then
        exit "$status"
    fi
    delay=$((attempt * 2))
    echo "Transient npm download failure; retry $((attempt + 1))/3 in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
done
