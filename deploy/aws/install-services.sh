#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: bash deploy/aws/install-services.sh [--dry-run] [app-dir [service-user]]' \
    'Defaults: /opt/orcus, orcus. Installs units only; does not start services.'
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

dry_run=false
if [[ "${1:-}" == --help ]]; then
  usage
  exit 0
fi
if [[ "${1:-}" == --dry-run ]]; then
  dry_run=true
  shift
fi
[[ $# -le 2 ]] || { usage >&2; exit 1; }

app_dir="${1:-/opt/orcus}"
service_user="${2:-orcus}"
[[ "$app_dir" =~ ^/[a-zA-Z0-9._/-]+$ && "$app_dir" != / ]] || fail 'Use an absolute app directory without spaces or special characters.'
app_dir="$(realpath -e -- "$app_dir")" || fail 'App directory does not exist.'
[[ "$app_dir" =~ ^/[a-zA-Z0-9._/-]+$ && "$app_dir" != / ]] || fail 'Resolved app directory is not supported.'
[[ -f "$app_dir/package.json" ]] || fail 'App directory must contain the repository package.json.'
[[ "$service_user" =~ ^[a-z_][a-z0-9_-]*$ && "$service_user" != root ]] || fail 'Use an existing non-root service user.'
service_uid="$(id -u "$service_user")" || fail 'Service user does not exist.'
[[ "$service_uid" =~ ^[0-9]+$ && "$service_uid" -ne 0 ]] || fail 'Service user must not have UID 0.'
service_home="$(getent passwd "$service_user" | cut -d: -f6)" || fail 'Service user does not exist.'
[[ "$service_home" =~ ^/[a-zA-Z0-9._/-]+$ && "$service_home" != / ]] || fail 'Service user must have an absolute home without spaces or special characters.'
template_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for unit in orcus-web orcus-worker; do
  [[ -f "$template_dir/$unit.service.in" ]] || fail "Missing template: $unit.service.in"
done

render() {
  sed -e "s|@APP_DIR@|$app_dir|g" \
    -e "s|@SERVICE_USER@|$service_user|g" \
    -e "s|@SERVICE_HOME@|$service_home|g" "$template_dir/$1.service.in"
}

if "$dry_run"; then
  for unit in orcus-web orcus-worker; do
    printf '# %s.service\n' "$unit"
    render "$unit"
  done
  exit 0
fi

[[ $EUID -eq 0 ]] || fail 'Run with sudo to install systemd units, or use --dry-run.'
[[ -f "$app_dir/.env" && ! -L "$app_dir/.env" ]] || fail 'Run demo:setup as the service user first.'
[[ -f "$app_dir/web/.next/BUILD_ID" ]] || fail 'Run npm run build as the service user first.'
temp_dir="$(mktemp -d)"
trap 'rm -f -- "$temp_dir/orcus-web.service" "$temp_dir/orcus-worker.service"; rmdir -- "$temp_dir"' EXIT
for unit in orcus-web orcus-worker; do
  render "$unit" > "$temp_dir/$unit.service"
  install -o root -g root -m 0644 -- "$temp_dir/$unit.service" "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
printf '%s\n' 'Installed orcus-web.service and orcus-worker.service.' \
  'Start explicitly with: sudo systemctl enable --now orcus-web.service orcus-worker.service'
