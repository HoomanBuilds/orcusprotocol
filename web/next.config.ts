import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  transpilePackages: [
    "@orcus/core",
    "@orcus/server",
    "@orcus/engine",
    "@orcus/wallets",
  ],
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
};

export default config;
