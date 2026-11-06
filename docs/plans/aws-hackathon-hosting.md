# AWS hackathon hosting

## Scope

Host the testnet hackathon app on one Ubuntu 24.04 x86_64 or ARM64 EC2 instance. Run the existing Node 22 web app and background worker as the same unprivileged user with systemd. Use the existing Caddy proxy for `https://orcusprotocol.xyz`, preserving its other sites.

This is a single-machine demo, not a high-availability production platform. No Docker, Terraform, ECS, RDS, KMS, backup system or monitoring stack is required.

## Runtime layout

- `/opt/orcus`: checkout, dependencies, built web app and owner-only `.env`.
- `/var/lib/orcus`: service user's home, Bun/CRE binaries, CLI authentication and caches.
- `/var/lib/orcus/data`: shared SQLite state and local signing-key material, outside the checkout. Keep this directory and the existing master key through ordinary app updates so account and chat state remain usable.
- `orcus-web.service`: Next.js on `127.0.0.1:3000`.
- `orcus-worker.service`: loopback calls into the same app, using the same `.env` and internal token.
- Optional Caddy: public ports 80/443 with a domain pointed at the instance.

The selected shared host is ARM64. Install dependencies on that architecture rather than copying a laptop's native modules. Keep `/opt/orcus` separate from any older checkout under `/home/ubuntu/orcus`. Web and worker service defaults cap combined memory at 3 GiB and combined CPU at one core; build serially in a separately bounded systemd unit with the app stopped.

`npm run demo:setup` owns first-run secret generation and validation. `ORCUS_APP_URL` is the public HTTPS origin; `ORCUS_INTERNAL_APP_URL` is `http://127.0.0.1:3000`. Provider credentials and limited testnet payer configuration remain operator-supplied, not generated funding or granted authorization.

CRE uses the real CLI, Bun and workflow compiler on this host. Only local, non-broadcast workflow simulation is in scope. One web process owns the workflow directory; do not run a separate simulation in that directory while it is serving evaluations.

## Acceptance

The [runbook](../../deploy/aws/README.md) must cover host prerequisites, setup, a build, the two services, optional HTTPS, and a browser/account persistence check after restart. It must keep secrets out of command arguments and preserve the data directory during updates.

Prepared hosting files are not evidence that AWS resources were created, the application was hosted, or integrations are funded and authenticated. Actual hosting requires the operator's chosen instance, SSH access, public origin and private configuration.
