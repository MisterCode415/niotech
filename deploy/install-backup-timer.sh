#!/usr/bin/env bash
# Install the monthly database dump on the application VM. Run as root (sudo) on the VM, from the
# repository checkout:
#
#   sudo STORAGE_ACCOUNT=<name> BACKUP_DATABASE_URL='postgres://nio_backup:...' \
#     ./deploy/install-backup-timer.sh
#
# Creates /etc/nio/backup.env (root-only), installs the Azure CLI if missing, and enables a systemd
# timer that runs deploy/db-dump.sh at 03:00 UTC on the 1st of each month. Safe to re-run.
set -euo pipefail

fail() { echo "error: $*" >&2; exit 1; }
[[ "$(id -u)" == "0" ]] || fail "run as root (sudo)"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG=/etc/nio/backup.env

if [[ ! -f "$CONFIG" ]]; then
  : "${STORAGE_ACCOUNT:?set STORAGE_ACCOUNT (printed by deploy/azure-storage.sh)}"
  : "${BACKUP_DATABASE_URL:?set BACKUP_DATABASE_URL (the nio_backup login; see deploy/create-backup-db-role.sql)}"
  install -d -m 700 /etc/nio
  umask 077
  cat > "$CONFIG" <<EOF
BACKUP_DATABASE_URL=${BACKUP_DATABASE_URL}
STORAGE_ACCOUNT=${STORAGE_ACCOUNT}
BACKUP_CONTAINER=${BACKUP_CONTAINER:-db-backups}
EOF
  chmod 600 "$CONFIG"
  echo "==> Wrote $CONFIG"
else
  echo "==> $CONFIG exists; leaving it as is"
fi

if ! command -v az >/dev/null; then
  echo "==> Installing the Azure CLI"
  curl -fsSL https://aka.ms/InstallAzureCLIDeb | bash
fi

cat > /etc/systemd/system/nio-db-dump.service <<EOF
[Unit]
Description=Dump the Qinio database to write-once blob storage
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${REPO}/deploy/db-dump.sh
EOF

cat > /etc/systemd/system/nio-db-dump.timer <<EOF
[Unit]
Description=Monthly Qinio database dump

[Timer]
OnCalendar=*-*-01 03:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now nio-db-dump.timer
echo "==> Timer installed:"
systemctl list-timers nio-db-dump.timer --no-pager
echo
echo "Take the first dump now to prove it works:  sudo systemctl start nio-db-dump.service"
echo "Watch it:                                   journalctl -u nio-db-dump.service -f"
