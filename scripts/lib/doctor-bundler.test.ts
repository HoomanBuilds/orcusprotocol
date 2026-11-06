import { describe, expect, it } from "vitest";
import { doctorBundlerConfiguration } from "./doctor-bundler";

describe("self-funded bundler diagnostics", () => {
  it("uses the configured bundler without sponsor credentials", () => {
    expect(doctorBundlerConfiguration({ BUNDLER_RPC_URL: "https://bundler.example/secret" })).toEqual({ status: "configured", url: "https://bundler.example/secret" });
  });
  it.each(["zerodev", "operator", "invalid-provider"])("ignores stale sponsor provider configuration: %s", provider => {
    expect(doctorBundlerConfiguration({ ORCUS_GAS_SPONSOR_PROVIDER: provider, BUNDLER_RPC_URL: "https://bundler.example/primary", ZERODEV_RPC_URL: "https://rpc.zerodev.app/secondary" })).toEqual({ status: "configured", url: "https://bundler.example/primary" });
  });
  it.each([undefined, "", "   "])("does not substitute secondary credentials for a missing bundler", url => {
    expect(doctorBundlerConfiguration({ BUNDLER_RPC_URL: url, ZERODEV_RPC_URL: "https://rpc.zerodev.app/secondary-secret" })).toEqual({ status: "missing" });
  });
  it.each(["not-a-url", "http://bundler.example/secret", "https://user:secret@bundler.example", "file:///tmp/bundler"])("rejects invalid transport without disclosing credentials", url => {
    expect(doctorBundlerConfiguration({ BUNDLER_RPC_URL: url })).toEqual({ status: "invalid" });
  });
  it.each(["http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001"])("accepts explicit loopback development endpoints", url => {
    expect(doctorBundlerConfiguration({ BUNDLER_RPC_URL: url })).toEqual({ status: "configured", url });
  });
});
