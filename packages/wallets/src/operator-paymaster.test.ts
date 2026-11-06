import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress, size, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decodeOperatorPaymasterData, encodeOperatorPaymasterData, operatorSponsorshipHash, operatorSponsorshipTypedData, type OperatorSponsorshipAuthorization, type OperatorUserOperation } from "./operator-paymaster";

const sender = "0x1111111111111111111111111111111111111111";
const operation: OperatorUserOperation = { sender, nonce: 1n, callData: "0x1234", callGasLimit: 100_000n, verificationGasLimit: 200_000n, preVerificationGas: 50_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n };
const authorization: OperatorSponsorshipAuthorization = { paymaster: "0x2222222222222222222222222222222222222222", entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", chainId: 11155111, validAfter: 100, validUntil: 220, maxCostWei: 10_000_000n, paymasterVerificationGasLimit: 100_000n, paymasterPostOpGasLimit: 0n };

describe("operator paymaster authorization", () => {
  it("signs typed data and encodes a fixed-size authorization", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const typed = operatorSponsorshipTypedData(operation, authorization);
    const signature = await signer.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(signer.address);
    const encoded = encodeOperatorPaymasterData(authorization, signature);
    expect(size(encoded)).toBe(161);
    expect(decodeOperatorPaymasterData(encoded)).toEqual({ validAfter: 100, validUntil: 220, maxCostWei: 10_000_000n, signature });
  });

  it.each([
    { sender: "0x3333333333333333333333333333333333333333" as Address },
    { nonce: 2n }, { callData: "0x5678" as Hex }, { callGasLimit: 100_001n },
    { verificationGasLimit: 200_001n }, { preVerificationGas: 50_001n },
    { maxFeePerGas: 11n }, { maxPriorityFeePerGas: 2n },
    { factory: "0x4444444444444444444444444444444444444444" as Address, factoryData: "0x1234" as Hex },
  ])("binds every account and operation field: %o", (change) => {
    expect(operatorSponsorshipHash({ ...operation, ...change }, authorization)).not.toBe(operatorSponsorshipHash(operation, authorization));
  });

  it.each([
    { paymaster: "0x3333333333333333333333333333333333333333" as Address },
    { entryPoint: "0x4444444444444444444444444444444444444444" as Address },
    { chainId: 1 }, { validAfter: 101 }, { validUntil: 221 }, { maxCostWei: 10_000_001n },
    { paymasterVerificationGasLimit: 100_001n }, { paymasterPostOpGasLimit: 1n },
  ])("binds every sponsor authorization field: %o", (change) => {
    expect(operatorSponsorshipHash(operation, { ...authorization, ...change })).not.toBe(operatorSponsorshipHash(operation, authorization));
  });

  it("binds factory calldata and ignores account signatures", () => {
    const deployed = { ...operation, factory: sender, factoryData: "0x1234" as Hex };
    expect(operatorSponsorshipHash(deployed, authorization)).not.toBe(operatorSponsorshipHash({ ...deployed, factoryData: "0x5678" }, authorization));
    expect(operatorSponsorshipHash({ ...operation, signature: "0x1234" } as OperatorUserOperation, authorization)).toBe(operatorSponsorshipHash(operation, authorization));
    expect(operatorSponsorshipHash({ ...operation, nonce: "0x1" }, authorization)).toBe(operatorSponsorshipHash(operation, authorization));
  });

  it.each([{ validUntil: 0 }, { validUntil: 100 }, { validUntil: 401 }, { validAfter: -1 }, { validUntil: 2 ** 48 }, { validAfter: 1.2 }, { chainId: 0 }, { maxCostWei: 0n }, { maxCostWei: 1n << 256n }, { paymaster: zeroAddress }, { entryPoint: zeroAddress }, { paymasterVerificationGasLimit: 1n << 128n }])("rejects invalid authorization bounds: %o", (change) => {
    expect(() => operatorSponsorshipHash(operation, { ...authorization, ...change })).toThrow();
  });

  it.each([{ nonce: -1n }, { callGasLimit: 1n << 128n }, { maxFeePerGas: -1n }, { preVerificationGas: 1n << 256n }, { callData: "0x1" as Hex }, { factoryData: "0x1234" as Hex }, { factory: sender }])("rejects malformed account operation: %o", (change) => {
    expect(() => operatorSponsorshipHash({ ...operation, ...change }, authorization)).toThrow();
  });

  it("rejects truncated or overlong authorizations and signatures", () => {
    expect(() => encodeOperatorPaymasterData(authorization, "0x1234")).toThrow(/65-byte/);
    expect(() => decodeOperatorPaymasterData("0x")).toThrow(/length/);
    expect(() => decodeOperatorPaymasterData(`0x${"00".repeat(162)}`)).toThrow(/length/);
    expect(() => decodeOperatorPaymasterData("0x1")).toThrow(/bytes/);
  });
});
