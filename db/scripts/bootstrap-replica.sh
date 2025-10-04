#!/usr/bin/env bash
set -euo pipefail

MONGO_PRIMARY_HOST=${MONGO_PRIMARY_HOST:-mongo-primary}
MONGO_PRIMARY_PORT=${MONGO_PRIMARY_PORT:-27017}
MONGO_URI="mongodb://${MONGO_ROOT_USERNAME}:${MONGO_ROOT_PASSWORD}@${MONGO_PRIMARY_HOST}:${MONGO_PRIMARY_PORT}/admin?authSource=admin"

printf 'Waiting for MongoDB primary at %s:%s to accept connections...' "$MONGO_PRIMARY_HOST" "$MONGO_PRIMARY_PORT"
until mongosh "$MONGO_URI" --quiet --eval "db.runCommand({ ping: 1 })" >/dev/null 2>&1; do
  printf '.'
  sleep 2
done
printf ' done\n'

mongosh "$MONGO_URI" /scripts/bootstrap-replica.js