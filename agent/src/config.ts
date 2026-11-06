export function engineConfig() {
  const setting = (...names: string[]) => names.map(name => process.env[name]?.trim()).find(value => Boolean(value));
  const computeBase = setting("ZEROG_COMPUTE_BASE_URL", "ZG_SERVICE_URL");
  const computeKey = setting("ZEROG_COMPUTE_API_KEY", "0G_API_KEY", "ZG_API_SECRET");
  return {
    compute: {
      url: setting("ZEROG_COMPUTE_CHAT_URL") ?? (computeBase ? `${computeBase.replace(/\/$/, "")}/chat/completions` : computeKey ? "https://router-api.0g.ai/v1/chat/completions" : undefined),
      apiKey: computeKey,
      model: setting("ZEROG_COMPUTE_MODEL", "ZG_MODEL") ?? (computeKey ? "0gm-1.0-35b-a3b" : undefined),
      balanceUrl: setting("ZEROG_COMPUTE_BALANCE_URL"),
    },
    uniswap: {
      rpcUrl: process.env.SEPOLIA_RPC_URL ?? process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      router: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E" as const,
      quoter: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3" as const,
      factory: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c" as const,
      weth: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14" as const,
      usdc: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238" as const,
    },
    storage: {
      rpcUrl: process.env.ZEROG_STORAGE_RPC_URL ?? "https://evmrpc-testnet.0g.ai",
      indexerUrl: process.env.ZEROG_STORAGE_INDEXER_URL ?? "https://indexer-storage-testnet-turbo.0g.ai",
      configured: process.env.ZEROG_STORAGE_ENABLED === "true",
    },
    cre: {
      cliPath: process.env.CRE_CLI_PATH ?? "cre",
      workflowDir: process.env.CRE_WORKFLOW_DIR,
      target: process.env.CRE_TARGET ?? "staging-settings",
      enabled: process.env.CRE_ENABLED === "true",
    },
  };
}
