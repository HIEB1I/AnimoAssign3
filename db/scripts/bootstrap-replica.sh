#!/usr/bin/env bash
set -euo pipefail

MONGO_PRIMARY_HOST=${MONGO_PRIMARY_HOST:-mongo-primary}
MONGO_PRIMARY_PORT=${MONGO_PRIMARY_PORT:-27017}
MONGO_ROOT_USERNAME=${MONGO_ROOT_USERNAME:-${MONGO_INITDB_ROOT_USERNAME:-}}
MONGO_ROOT_PASSWORD=${MONGO_ROOT_PASSWORD:-${MONGO_INITDB_ROOT_PASSWORD:-}}

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
  if (( attempt % 15 == 0 )); then
    printf $'\nStill waiting for MongoDB (exit %s). Last error:\n%s\n' "$status" "$output" >&2
  fi
  sleep 2
done
printf $' done\n'
mongosh "${mongo_args[@]}" /scripts/bootstrap-replica.js