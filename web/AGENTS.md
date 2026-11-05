# Frontend workflow

- Read relevant framework documentation bundled with the installed Next.js version before changing its APIs or configuration.
- Use root npm commands. Root scripts load the root `.env`; keep credentials out of browser configuration and source code.
- The interface uses `@orcus/core` API types. Server authentication and persistence live in `@orcus/server`; signing helpers live in `@orcus/wallets`.
- Manual actions and agent actions use the same supported trading accounts. Do not introduce separate portfolios or request an owner's private key.
- Show real pending, stale, failed and unconfigured states. Do not fabricate market values, execution evidence or sponsor readiness.
- Preserve the global preference for ASCII hyphens and `->` instead of em dashes or Unicode arrows.
