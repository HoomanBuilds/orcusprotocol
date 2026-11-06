import { describe, expect, it } from "vitest";
import { operatorPaymasterAbi } from "../../packages/wallets/src/operator-paymaster";
import { compileOperatorPaymaster } from "./compile-operator-paymaster";

describe("operator paymaster Solidity build", () => {
  it("compiles against reference EntryPoint 0.7 and matches every shared ABI function", () => {
    const compiled = compileOperatorPaymaster();
    expect(compiled.bytecode).toMatch(/^0x[0-9a-f]+$/u);
    for (const expected of operatorPaymasterAbi.filter(item => item.type === "function" || item.type === "constructor")) {
      const actual = compiled.abi.find(item => item.type === expected.type && (item.type !== "function" || expected.type !== "function" || item.name === expected.name));
      expect(actual).toBeDefined();
      if (actual?.type === "function" || actual?.type === "constructor") {
        expect(actual.inputs.map(input => input.type)).toEqual(expected.inputs.map(input => input.type));
      }
    }
  }, 20_000);
});
