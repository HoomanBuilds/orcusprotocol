import { describe, expect, it } from "vitest";
import { doctorBundlerConfiguration, doctorOperatorStakeConfiguration } from "./doctor-bundler";

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
  it("does not label a blank primary endpoint as configured", () => {
    expect(doctorBundlerConfiguration({ BUNDLER_RPC_URL: "   ", ZERODEV_RPC_URL: "https://rpc.zerodev.app/secondary-secret" })).toEqual({ provider: "operator", status: "missing" });
  });
  it("does not disclose an invalid provider value or an inactive endpoint", () => {
    expect(doctorBundlerConfiguration({ ORCUS_GAS_SPONSOR_PROVIDER: "secret-invalid-provider", BUNDLER_RPC_URL: "https://bundler.example/secret" })).toEqual({ status: "invalid" });
  });
});

describe("operator bundler stake configuration", () => {
  it.each([undefined, "", "   "])("requires an explicit minimum when operator staking is required", minimum => {
    expect(doctorOperatorStakeConfiguration({ ORCUS_GAS_SPONSOR_MIN_STAKE_WEI: minimum })).toBe("missing");
  });
  it("accepts a positive configured minimum without claiming funds or admission", () => {
    expect(doctorOperatorStakeConfiguration({ ORCUS_GAS_SPONSOR_REQUIRE_STAKE: "true", ORCUS_GAS_SPONSOR_MIN_STAKE_WEI: "1" })).toBe("configured");
  });
  it.each(["0", "-1", "1.5", "01", (1n << 112n).toString()])("rejects invalid required minimum values", minimum => {
    expect(doctorOperatorStakeConfiguration({ ORCUS_GAS_SPONSOR_MIN_STAKE_WEI: minimum })).toBe("invalid");
  });
  it("keeps explicit no-stake policies and ZeroDev separate", () => {
    expect(doctorOperatorStakeConfiguration({ ORCUS_GAS_SPONSOR_REQUIRE_STAKE: "false" })).toBe("not required");
    expect(doctorOperatorStakeConfiguration({ ORCUS_GAS_SPONSOR_PROVIDER: "zerodev" })).toBe("not required");
    expect(doctorOperatorStakeConfiguration({ ORCUS_GAS_SPONSOR_REQUIRE_STAKE: "invalid-setting" })).toBe("invalid");
  });
});
