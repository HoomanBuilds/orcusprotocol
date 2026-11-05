import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@orcus/core", "@orcus/server", "@orcus/engine"],
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
};

export default config;
