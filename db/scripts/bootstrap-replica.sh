#!/usr/bin/env bash
set -euo pipefail

MONGO_PRIMARY_SERVICE_HOST=${MONGO_PRIMARY_SERVICE_HOST:-mongo-primary}
MONGO_PRIMARY_HOST=${MONGO_PRIMARY_HOST:-$MONGO_PRIMARY_SERVICE_HOST}
MONGO_PRIMARY_PORT=${MONGO_PRIMARY_PORT:-27017}
MONGO_ROOT_USERNAME=${MONGO_ROOT_USERNAME:-}
MONGO_ROOT_PASSWORD=${MONGO_ROOT_PASSWORD:-}

if [[ -z "${MONGO_ROOT_USERNAME}" || -z "${MONGO_ROOT_PASSWORD}" ]]; then
  printf 'MONGO_ROOT_USERNAME and MONGO_ROOT_PASSWORD must be provided for replica bootstrap.\n' >&2
  exit 1
fi

is_loopback_host() {
  case "$1" in
    ""|localhost|127.*|::1|0.0.0.0)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

if is_loopback_host "$MONGO_PRIMARY_HOST"; then
  printf 'Provided MongoDB host "%s" resolves to the bootstrap container; falling back to service host "%s".\n' \
    "$MONGO_PRIMARY_HOST" "$MONGO_PRIMARY_SERVICE_HOST" >&2
  MONGO_PRIMARY_HOST=$MONGO_PRIMARY_SERVICE_HOST
fi

mongo_args=(--host "$MONGO_PRIMARY_HOST" --port "$MONGO_PRIMARY_PORT")
if [[ -n "${MONGO_ROOT_USERNAME}" ]]; then
  mongo_args+=(--username "$MONGO_ROOT_USERNAME")
  if [[ -n "${MONGO_ROOT_PASSWORD}" ]]; then
    mongo_args+=(--password "$MONGO_ROOT_PASSWORD")
  fi
  mongo_args+=(--authenticationDatabase admin)
fi

printf 'Waiting for MongoDB primary at %s:%s to accept connections...' "$MONGO_PRIMARY_HOST" "$MONGO_PRIMARY_PORT"
attempt=0
while true; do
  if output=$(mongosh "${mongo_args[@]}" --quiet --eval "db.runCommand({ ping: 1 })" 2>&1); then
    break
  fi

  status=$?
  attempt=$((attempt + 1))
  if [[ $output == *"Authentication failed"* || $output == *"auth failed"* ]]; then
    printf $'\nMongoDB rejected the provided root credentials while contacting %s:%s.\n' "$MONGO_PRIMARY_HOST" "$MONGO_PRIMARY_PORT" >&2
    printf $'Last error from mongosh (exit %s):\n%s\n' "$status" "$output" >&2
    exit "$status"
  fi

  printf '.'