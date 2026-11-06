import { resolveKernelBundlerUrl } from "@orcus/wallets/kernel";

export function doctorBundlerConfiguration(environment: { ORCUS_GAS_SPONSOR_PROVIDER?: string; BUNDLER_RPC_URL?: string; ZERODEV_RPC_URL?: string }) {
  const provider = environment.ORCUS_GAS_SPONSOR_PROVIDER ?? "operator";
  if (provider !== "operator" && provider !== "zerodev") return { status: "invalid" as const };
  try {
    const url = resolveKernelBundlerUrl(environment).trim();
    return url ? { provider, status: "configured" as const, url } : { provider, status: "missing" as const };
  }
  catch { return { provider, status: "missing" as const }; }
}
