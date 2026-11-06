# One EC2 instance for the hackathon

Run the web app and worker directly on Ubuntu with systemd. No Docker or managed database is needed. These files prepare hosting; no AWS instance has been created or started by adding them.

## 1. Choose the host

Use a user-approved Ubuntu 24.04 x86_64 or ARM64 EC2 instance with SSH access and enough memory to build Next.js and compile the CRE workflow. A dedicated 2-vCPU, 4-GiB machine is a starting point for this demo, not a load-tested sizing guarantee. On a shared machine, measure available RAM, free disk and existing CPU use before installing. Use a Canonical Ubuntu image, not an arbitrary image with Ubuntu in its name. See [Ubuntu's EC2 guidance](https://documentation.ubuntu.com/aws/aws-how-to/instances/launch-ubuntu-ec2-instance/).

Allow inbound SSH on TCP 22 only from your own IP, and TCP 80/443 for the public site. Do not expose 3000 or the data directory. Leave outbound HTTPS available for RPC, providers, package downloads and CRE. These follow the [AWS security group examples](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-rules-reference.html). If a host firewall is enabled, it needs matching rules.

Supply your own repository URL and approved revision. The selected origin is `https://orcusprotocol.xyz`. Reuse the instance's existing Elastic IP when present; replacing an in-use address can break its other sites. Point the domain's A record at that address, and add AAAA only if IPv6 also reaches this host. Do not change unrelated DNS records.

## 2. Install the host tools

Run these commands on the EC2 instance as its SSH administrator, not on your laptop:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git gnupg unzip xz-utils build-essential python3
```

Install Node 22 system-wide, version 22.16.0 or newer. Skip the following block if the host already has a compatible system-wide Node 22 and npm; do not replace a working runtime used by other apps. This example selects the official 22.23.4 Linux archive for the host architecture and verifies its published checksum. For later updates, choose a supported 22.x release from [Node's official downloads](https://nodejs.org/en/download) and follow its linked signed-checksum verification instructions.

```sh
node_download_dir="$(mktemp -d)"
cd "$node_download_dir"
case "$(uname -m)" in
  x86_64) orcus_node_arch=x64 ;;
  aarch64|arm64) orcus_node_arch=arm64 ;;
  *) printf '%s\n' 'Unsupported Node architecture'; exit 1 ;;
esac
orcus_node_archive="node-v22.23.4-linux-$orcus_node_arch"
curl -fsSLO "https://nodejs.org/dist/v22.23.4/$orcus_node_archive.tar.xz"
curl -fsSLO https://nodejs.org/dist/v22.23.4/SHASUMS256.txt
sha256sum --check --ignore-missing SHASUMS256.txt
sudo install -d -m 0755 /usr/local/lib/nodejs
sudo tar -xJf "$orcus_node_archive.tar.xz" -C /usr/local/lib/nodejs
sudo ln -s "/usr/local/lib/nodejs/$orcus_node_archive/bin/node" /usr/local/bin/node
sudo ln -s "/usr/local/lib/nodejs/$orcus_node_archive/bin/npm" /usr/local/bin/npm
sudo ln -s "/usr/local/lib/nodejs/$orcus_node_archive/bin/npx" /usr/local/bin/npx
node --version
npm --version
```

Stop if verification fails. The symlink commands deliberately do not replace existing binaries. Do not continue past a conflicting installation without choosing which Node installation the host should use.

## 3. Put the code on the instance

For a fresh installation only, choose the real repository URL and approved revision before running:

```sh
ORCUS_REPOSITORY_URL='YOUR_REPOSITORY_URL'
ORCUS_REVISION='YOUR_APPROVED_COMMIT'
id orcus >/dev/null 2>&1 || sudo useradd --system --user-group --create-home --home-dir /var/lib/orcus --shell /bin/bash orcus
if [ -e /opt/orcus ]; then
  printf '%s\n' '/opt/orcus already exists. Use the existing-checkout instructions instead.'
else
  sudo install -d -o orcus -g orcus -m 0750 /opt/orcus
  sudo -u orcus git clone "$ORCUS_REPOSITORY_URL" /opt/orcus
  sudo -u orcus git -C /opt/orcus checkout --detach "$ORCUS_REVISION"
fi
```

For an existing checkout, inspect `git status --short` and its ownership first. Keep its `.env` and runtime data; do not clone over it, reset it or recursively change unrelated ownership. `/opt/orcus` is the intended app directory, not a developer-machine path. The installer also accepts a different absolute checkout path and non-root user. Adjust the paths throughout this runbook consistently if you choose different locations.

Use `git clone` for source delivery. Do not upload an entire local working directory, `.env`, wallet files or ignored assets. Configure credentials privately on the host instead.

An older `/home/ubuntu/orcus` is not the new deployment target. Leave it untouched. Run `npm ci` on the target architecture: copying x86_64 `node_modules` or `.next` output to ARM64 can ship incompatible `better-sqlite3`, SWC or image-processing binaries.

## 4. Install and configure as the app user

Enter the service user's shell. Install the same Bun and CRE CLI versions already verified for this repository, not an untested latest version. Their official installers are documented by [Bun](https://bun.sh/docs/installation) and [Chainlink](https://docs.chain.link/cre/getting-started/cli-installation/macos-linux); the CRE installer verifies its release binary. Go is not needed for this TypeScript workflow.

Both installers support Linux ARM64. CRE v1.39.0 publishes `cre_linux_arm64.tar.gz` for Ubuntu 24.04 and an `ldd2-35` variant for older glibc; its installer selects the appropriate build. Confirm `node -p process.arch`, `bun --version` and `cre version` on the host before compiling. Published ARM binaries are compatibility evidence, not proof that this app's native modules or authenticated simulation work there.

```sh
sudo -iu orcus
set -euo pipefail
export PATH=/var/lib/orcus/.bun/bin:/var/lib/orcus/.cre/bin:/usr/local/bin:/usr/bin:/bin
curl -fsSL https://bun.com/install | bash -s 'bun-v1.3.14'
curl -fsSL https://cre.chain.link/install.sh | bash -s v1.39.0
bun --version
cre version
cd /opt/orcus
npm ci
npm ci --prefix workflows/cre/strategy
bun install --cwd workflows/cre/strategy
cd workflows/cre/strategy
bunx cre-setup
npm run typecheck
npm run build
cd /opt/orcus
npm run demo:setup -- --app-url https://orcusprotocol.xyz --data-dir /var/lib/orcus/data
exit
```

The setup command generates missing app secrets privately and preserves existing nonempty values. It sets `ORCUS_INTERNAL_APP_URL=http://127.0.0.1:3000` when missing. Keep the generated `.env` and `/var/lib/orcus/data` private and persistent. Do not delete or regenerate the master key when updating an existing database. `.env` stays in the checkout with owner-only permissions; SQLite and local key material stay outside it.

Edit only your private host configuration, using your own editor session:

```sh
sudoedit /opt/orcus/.env
```

Use [.env.example](../../.env.example) for the actual required provider settings. For the complete demo, supply 0G Compute credentials, CRE authentication and the configured Sepolia ERC-4337 bundler. These are real prerequisites, not sample credentials or automatically funded accounts. Each Uniswap smart account pays gas from its own Sepolia ETH balance for both owner and agent actions. No paymaster, operator gas key, paymaster deposit or stake is needed. The smart account's ERC-4337 gas prefund is taken from its own ETH. Keep enough ETH beyond any native swap input; the session signer is not the fee wallet. Ostium owner actions use owner ETH and delegated actions use delegate ETH on Arbitrum Sepolia. Hyperliquid orders use signed API requests with venue trading fees. There are no automatic gas top-ups. Keep optional integrations disabled unless you have configured them. In particular, set:

```dotenv
CRE_ENABLED=true
CRE_CLI_PATH=/var/lib/orcus/.cre/bin/cre
CRE_WORKFLOW_DIR=/opt/orcus/workflows/cre
CRE_TARGET=staging-settings
```

Set `CRE_API_KEY` privately in the root `.env`, or authenticate as `orcus` with the CLI's user-controlled browser login. The check below runs `cre whoami` before simulation using the same allowlisted environment as the managed runner. If authentication is missing, choose your own API key or complete `cre login` yourself as `orcus`, then recheck. CLI authentication and organization access are separate from installing the binary. Do not request deployment access or run CRE secret/lifecycle operations for this hosting setup.

Before starting the app, run as `orcus` with the same PATH:

```sh
sudo -iu orcus
set -euo pipefail
export PATH=/var/lib/orcus/.bun/bin:/var/lib/orcus/.cre/bin:/usr/local/bin:/usr/bin:/bin
cd /opt/orcus
npm run demo:setup -- --check
npm run doctor
node --import tsx deploy/aws/check-cre.mjs
exit
```

Build once from the SSH administrator account with web and worker stopped. Keep dependency installation, workflow compilation and this build serial. The bounded unit below reserves room for the other hosted apps and is removed after completion:

```sh
sudo systemd-run --unit=orcus-build --wait --collect --pipe \
  -p User=orcus -p WorkingDirectory=/opt/orcus \
  -p MemoryHigh=2560M -p MemoryMax=3072M -p MemorySwapMax=256M \
  -p CPUQuota=100% -p Nice=10 \
  /usr/bin/env PATH=/var/lib/orcus/.bun/bin:/var/lib/orcus/.cre/bin:/usr/local/bin:/usr/bin:/bin \
  NODE_OPTIONS=--max-old-space-size=2304 NEXT_TELEMETRY_DISABLED=1 \
  npm run build -- --webpack
```

Do not copy the laptop's build as a shortcut. A failed or memory-killed build is not deployable; inspect it before changing limits or starting services.

The wrapper opaquely parses the root `.env` with Node, then forwards only the existing CRE child-environment allowlist. Explicit empty `--env` and `--public-env` files prevent the CLI from implicitly loading another dotenv. Do not source `.env` in Bash or pass the app's whole dotenv to the CLI. Authentication details and raw failure output are withheld; success prints one validated actual `ORCUS_CRE_LOCAL_RESULT` line. The fixed simulation is `cre workflow simulate strategy --target local-simulation --non-interactive --trigger-index 0`, run from `workflows/cre` with those private file flags.

All checks must pass before claiming the complete demo is ready. This is an actual read-only local simulation requiring authentication/network access, not a broadcast, workflow deployment or hosted DON proof. See the [workflow runbook](../../workflows/cre/README.md) for exact dependency and integration behavior. Do not run this check while the live web service is processing evaluations in the same workflow directory.

The compatible official CRE SDK 1.23.0 remains pinned; npm reports two high entries (Zod 3.25.76 and its SDK dependent) from the single [GHSA-mrhx-c7xc-m3w5 advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
No compatible patched Zod 3/SDK is published, and no override or fake fix was applied: this is a known limited hackathon dependency risk, not production certification. See the [dated verification record](../../docs/research/verification-2026-11-06.md).

## 5. Install and start both services

Run as the SSH administrator:

```sh
cd /opt/orcus
bash deploy/aws/install-services.sh --dry-run /opt/orcus orcus
sudo bash deploy/aws/install-services.sh /opt/orcus orcus
sudo systemctl enable --now orcus-web.service orcus-worker.service
sudo systemctl is-active orcus-web.service orcus-worker.service
curl --fail --silent --show-error --output /dev/null http://127.0.0.1:3000/
```

The helper replaces only `/etc/systemd/system/orcus-web.service` and `orcus-worker.service`, then reloads systemd. It does not install dependencies, read `.env`, copy source, start services or change app data. Both units use the same checkout and user. The existing npm scripts load `.env` themselves, so no secret appears in a service command. systemd handles process startup and failure restarts as documented in [systemd.service](https://freedesktop.org/software/systemd/man/latest/systemd.service.html).

Shared-host defaults cap the web service and its child processes at 2560 MiB, with a 1536 MiB Node heap; the worker is capped at 512 MiB with a 256 MiB heap. CPU quotas are 80% and 20% of one core respectively. Combined memory is bounded at 3 GiB, not all host RAM. CRE simulation executes inside the web service's limits. These are starting limits for light demo traffic, not a throughput guarantee. Check `MemoryPeak`, `NRestarts` and logs during a smoke test; avoid raising limits without rechecking the other apps. Use systemd drop-ins for host-specific overrides rather than editing shared app code.

## 6. Optional Caddy HTTPS

If you already have an HTTPS reverse proxy, point it at `127.0.0.1:3000` instead. Otherwise, install Caddy using its [official Ubuntu package instructions](https://caddyserver.com/docs/install#debian-ubuntu-raspbian). The package starts a `caddy` service. DNS and inbound ports 80/443 must work before it can issue a publicly trusted certificate, as described in [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).

For a fresh Caddy installation only:

```sh
sudo install -m 0644 /opt/orcus/deploy/aws/Caddyfile.example /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
curl --fail --silent --show-error --output /dev/null https://orcusprotocol.xyz/
```

The example hostname must match `ORCUS_APP_URL`. If the host already has a Caddyfile, add only the Orcus site block to it; do not run the replacement `install` command above or replace its other sites. Validate the candidate before reloading Caddy, then verify existing sites too. Never publish plain HTTP at an arbitrary IP and expect the HTTPS sign-in origin to match. Without working DNS, keep the site private until the intended domain resolves correctly.

## Verify and update

In a browser at the public origin, connect the intended wallet and sign in, then create a chat and testnet account. Restart both services and confirm the same account/chat remain visible. This verifies persistence on this instance; it is not evidence that trading, billable inference or self-funded gas settlement succeeded. Confirm those flows separately with the intended testnet accounts and limits.

```sh
sudo systemctl restart orcus-web.service orcus-worker.service
sudo systemctl is-active orcus-web.service orcus-worker.service
sudo journalctl -u orcus-web.service -u orcus-worker.service -n 50 --no-pager
```

Read logs privately. Do not post configuration, credentials or account details when asking for help. A running worker and successful HTTP response alone do not prove an evaluation succeeded.

For a code update, stop both services first. As `orcus`, inspect `git status --short`, fetch and check out your approved commit without discarding local changes, rerun `npm ci` and the workflow dependency/compiler steps if changed, then run `demo:setup -- --check`, `doctor` and `build`. Restart both services only after those commands succeed. Reinstall the units only if deployment files changed. Keep `.env`, the master key and `/var/lib/orcus/data` unchanged. Do not compile/simulate concurrently against the live workflow directory.

Stopping the worker pauses conditional automation. Instance/disk deletion can lose this local state. This deliberately small hackathon setup does not include replication, backups or a recovery platform.

The current hackathon deployment uses https://orcusprotocol.xyz on the approved AWS host at 15.135.178.84. Hosting and read-only browser checks do not prove wallet signing or trading. For subsequent updates, use the approved revision and existing host access, plus privately configured provider credentials and CRE authentication; do not modify unrelated hosted apps. Never paste those secrets into chat or command arguments.
