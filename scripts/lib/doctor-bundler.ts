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

export function doctorOperatorStakeConfiguration(environment: { ORCUS_GAS_SPONSOR_PROVIDER?: string; ORCUS_GAS_SPONSOR_REQUIRE_STAKE?: string; ORCUS_GAS_SPONSOR_MIN_STAKE_WEI?: string }) {
  if ((environment.ORCUS_GAS_SPONSOR_PROVIDER ?? "operator") !== "operator" || environment.ORCUS_GAS_SPONSOR_REQUIRE_STAKE === "false") return "not required";
  if ((environment.ORCUS_GAS_SPONSOR_REQUIRE_STAKE ?? "true") !== "true") return "invalid";
  const minimum = environment.ORCUS_GAS_SPONSOR_MIN_STAKE_WEI;
  if (!minimum?.trim()) return "missing";
  return /^[1-9]\d{0,33}$/.test(minimum) && BigInt(minimum) < 1n << 112n ? "configured" : "invalid";
}
