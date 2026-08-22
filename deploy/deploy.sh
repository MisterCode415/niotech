#!/usr/bin/env bash
# Build and (re)start the NIO Tech stack. Safe to re-run; it is the normal way to ship a change.
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "error: $*" >&2; exit 1; }

[[ -f .env.production ]] || fail "missing .env.production (copy .env.production.example and fill it in)"
[[ -f deploy/allowlist.conf ]] || fail "missing deploy/allowlist.conf (copy deploy/allowlist.conf.example and add your IP)"

grep -q 'replace-me' .env.production && fail "unreplaced 'replace-me' placeholders in .env.production"

read_env() { grep -E "^$1=" .env.production | head -1 | cut -d= -f2- | tr -d '"'; }

COMPOSE="docker compose -f docker-compose.prod.yml"
if [[ "$(read_env BUNDLED_DB)" == "true" ]]; then
  echo "==> Using the bundled database (no managed instance)"
  COMPOSE="$COMPOSE -f docker-compose.bundled-db.yml"
fi
COMPOSE="$COMPOSE --env-file .env.production"

# nginx will not start without a certificate, and certbot cannot validate without nginx running,
# so a self-signed placeholder breaks the cycle. deploy/certs.sh replaces it with a real one.
if [[ ! -f deploy/certs/fullchain.pem ]]; then
  echo "==> No certificate found; generating a self-signed placeholder"
  mkdir -p deploy/certs
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout deploy/certs/privkey.pem \
    -out deploy/certs/fullchain.pem \
    -subj "/CN=$(read_env SERVER_NAME)" 2>/dev/null
  echo "    Browsers will warn until you run deploy/certs.sh"
fi

echo "==> Building images"
$COMPOSE build

if [[ "$(read_env BUNDLED_DB)" == "true" ]]; then
  echo "==> Starting database"
  $COMPOSE up -d postgres
fi

echo "==> Applying migrations"
$COMPOSE run --rm api pnpm db:migrate

echo "==> Ensuring platform admin exists"
$COMPOSE run --rm api pnpm db:bootstrap

echo "==> Starting application"
$COMPOSE up -d --remove-orphans

echo "==> Waiting for the API to report healthy"
for _ in $(seq 1 30); do
  if $COMPOSE ps api | grep -q healthy; then
    echo "    healthy"
    break
  fi
  sleep 2
done

$COMPOSE ps
echo
echo "Deployed. Logs: $COMPOSE logs -f api"
