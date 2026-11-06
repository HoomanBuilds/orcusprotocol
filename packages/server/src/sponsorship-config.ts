import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { ApiError } from "./errors";

export type GasSponsorProvider = "operator" | "zerodev";

function endpoint(value: string | undefined, name: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error();
    return value;
  } catch { throw new ApiError("SPONSORSHIP_CONFIG_INVALID", `Configure a server-only HTTPS ${name} endpoint or local development endpoint.`, 503); }
}

export function gasSponsorConfig() {
  const provider = process.env.ORCUS_GAS_SPONSOR_PROVIDER ?? "operator";
  if (provider !== "operator" && provider !== "zerodev") throw new ApiError("SPONSORSHIP_CONFIG_INVALID", "Select operator or zerodev explicitly for gas sponsorship.", 503);
  const bundlerUrl = endpoint(provider === "operator" ? process.env.BUNDLER_RPC_URL : process.env.ZERODEV_RPC_URL, "bundler");
  if (provider === "zerodev") {
    const paymasterUrl = endpoint(process.env.ZERODEV_PAYMASTER_RPC_URL, "ZeroDev paymaster");
    if (paymasterUrl) {
      const url = new URL(paymasterUrl);
      if (url.protocol !== "https:" || url.hostname !== "rpc.zerodev.app" || url.port && url.port !== "443") throw new ApiError("SPONSORSHIP_CONFIG_INVALID", "Use the server-only HTTPS ZeroDev paymaster endpoint.", 503);
    }
    return { provider, bundlerUrl, paymasterUrl, configured: Boolean(bundlerUrl && paymasterUrl) } as const;
  }
  const privateKey = process.env.ORCUS_GAS_SPONSOR_PRIVATE_KEY;
  if (privateKey && (!/^0x[\da-fA-F]{64}$/.test(privateKey) || BigInt(privateKey) === 0n || BigInt(privateKey) >= 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n)) throw new ApiError("SPONSORSHIP_CONFIG_INVALID", "The operator gas signing key is invalid.", 503);
  let paymaster: Address | undefined;
  if (process.env.ORCUS_PAYMASTER_ADDRESS) {
    try { paymaster = getAddress(process.env.ORCUS_PAYMASTER_ADDRESS); if (paymaster === zeroAddress) throw new Error(); }
    catch { throw new ApiError("SPONSORSHIP_CONFIG_INVALID", "Configure the deployed Sepolia operator paymaster address.", 503); }
  }
  const rpcUrl = endpoint(process.env.SEPOLIA_RPC_URL ?? process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com", "Sepolia RPC")!;
  return { provider, bundlerUrl, rpcUrl, paymaster, privateKey: privateKey as Hex | undefined, configured: Boolean(bundlerUrl && privateKey && paymaster) } as const;
}
