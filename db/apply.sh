#!/usr/bin/env bash
set -euo pipefail

DB_URL="${DATABASE_URL:?DATABASE_URL is required}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for migration in "$DIR"/migrations/*.sql; do
  echo "applying ${migration##*/}"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$migration"
done

echo "migrations applied"