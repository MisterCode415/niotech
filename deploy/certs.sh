#!/usr/bin/env bash
# Obtain or renew the Let's Encrypt certificate and hand it to nginx.
# Run once after the first deploy, then from cron (see README) for renewals.
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.production"

SERVER_NAME="$(grep -E '^SERVER_NAME=' .env.production | cut -d= -f2)"
EMAIL="$(grep -E '^PLATFORM_ADMIN_EMAIL=' .env.production | cut -d= -f2)"

[[ -n "$SERVER_NAME" ]] || { echo "error: SERVER_NAME not set in .env.production" >&2; exit 1; }

# Webroot validation keeps nginx serving throughout, so renewals cause no downtime.
$COMPOSE --profile certbot run --rm certbot certonly \
  --webroot --webroot-path /var/www/certbot \
  --non-interactive --agree-tos --email "$EMAIL" \
  --keep-until-expiring \
  -d "$SERVER_NAME"

# nginx reads from a fixed path so its config does not change when the hostname does.
install -m 644 "deploy/letsencrypt/live/$SERVER_NAME/fullchain.pem" deploy/certs/fullchain.pem
install -m 600 "deploy/letsencrypt/live/$SERVER_NAME/privkey.pem" deploy/certs/privkey.pem

$COMPOSE exec web nginx -s reload

echo "Certificate installed for $SERVER_NAME"
