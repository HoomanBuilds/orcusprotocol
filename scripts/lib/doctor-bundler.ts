import { resolveKernelBundlerUrl } from "@orcus/wallets/kernel";

export function doctorBundlerConfiguration(environment: { ORCUS_GAS_SPONSOR_PROVIDER?: string; BUNDLER_RPC_URL?: string; ZERODEV_RPC_URL?: string }) {
  try {
    const url = resolveKernelBundlerUrl({ BUNDLER_RPC_URL: environment.BUNDLER_RPC_URL }).trim();
    if (!url) return { status: "missing" as const };
    const parsed = new URL(url);
    if (parsed.username || parsed.password || !(parsed.protocol === "https:" || parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) return { status: "invalid" as const };
    return { status: "configured" as const, url };
  }
  catch { return { status: environment.BUNDLER_RPC_URL?.trim() ? "invalid" as const : "missing" as const }; }
}
