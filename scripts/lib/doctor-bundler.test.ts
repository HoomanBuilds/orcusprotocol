import { describe, expect, it } from "vitest";
import { doctorBundlerConfiguration } from "./doctor-bundler";

describe("active bundler diagnostics", () => {
  it("probes the generic operator endpoint by default", () => {
    expect(doctorBundlerConfiguration({ BUNDLER_RPC_URL: "https://bundler.example/secret", ZERODEV_RPC_URL: "https://rpc.zerodev.app/secondary-secret" })).toEqual({ provider: "operator", status: "configured", url: "https://bundler.example/secret" });
  });
  it("uses hosted ZeroDev only when the operator explicitly selects it", () => {
    expect(doctorBundlerConfiguration({ ORCUS_GAS_SPONSOR_PROVIDER: "zerodev", BUNDLER_RPC_URL: "https://bundler.example/primary", ZERODEV_RPC_URL: "https://rpc.zerodev.app/secondary" })).toEqual({ provider: "zerodev", status: "configured", url: "https://rpc.zerodev.app/secondary" });
  });
  it("does not substitute configured secondary credentials for a missing primary", () => {
    expect(doctorBundlerConfiguration({ ZERODEV_RPC_URL: "https://rpc.zerodev.app/secondary-secret" })).toEqual({ provider: "operator", status: "missing" });
  });
  it("does not disclose an invalid provider value or an inactive endpoint", () => {
    expect(doctorBundlerConfiguration({ ORCUS_GAS_SPONSOR_PROVIDER: "secret-invalid-provider", BUNDLER_RPC_URL: "https://bundler.example/secret" })).toEqual({ status: "invalid" });
  });
});
