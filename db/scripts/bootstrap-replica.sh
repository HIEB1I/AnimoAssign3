
#!/usr/bin/env bash
#!/usr/bin/env bash
set -euo pipefail
set -euo pipefail


MONGO_PRIMARY_HOST=${MONGO_PRIMARY_HOST:-mongo-primary}
MONGO_PRIMARY_HOST=${MONGO_PRIMARY_HOST:-mongo-primary}
MONGO_PRIMARY_PORT=${MONGO_PRIMARY_PORT:-27017}
MONGO_PRIMARY_PORT=${MONGO_PRIMARY_PORT:-27017}
MONGO_URI="mongodb://${MONGO_ROOT_USERNAME}:${MONGO_ROOT_PASSWORD}@${MONGO_PRIMARY_HOST}:${MONGO_PRIMARY_PORT}/admin?authSource=admin"
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
printf 'Waiting for MongoDB primary at %s:%s to accept connections...' "$MONGO_PRIMARY_HOST" "$MONGO_PRIMARY_PORT"
until mongosh "$MONGO_URI" --quiet --eval "db.runCommand({ ping: 1 })" >/dev/null 2>&1; do
until mongosh "${mongo_args[@]}" --quiet --eval "db.runCommand({ ping: 1 })" >/dev/null 2>&1; do
  printf '.'
  printf '.'
  sleep 2
  sleep 2
done
done
printf ' done\n'
printf ' done\n'

mongosh "${mongo_args[@]}" /scripts/bootstrap-replica.js