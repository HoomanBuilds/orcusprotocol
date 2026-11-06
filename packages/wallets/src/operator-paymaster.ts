import { concatHex, decodeAbiParameters, encodeAbiParameters, getAddress, hashTypedData, keccak256, parseAbi, size, sliceHex, toHex, zeroAddress, type Address, type Hex } from "viem";

export const operatorPaymasterMaxValiditySeconds = 300;

export type OperatorUserOperation = {
  sender: Address;
  nonce: bigint | Hex;
  factory?: Address;
  factoryData?: Hex;
  callData: Hex;
  verificationGasLimit: bigint | Hex;
  callGasLimit: bigint | Hex;
  preVerificationGas: bigint | Hex;
  maxFeePerGas: bigint | Hex;
  maxPriorityFeePerGas: bigint | Hex;
};

export type OperatorSponsorshipAuthorization = {
  paymaster: Address;
  entryPoint: Address;
  chainId: number;
  validUntil: number;
  validAfter: number;
  maxCostWei: bigint;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
};

const authorizationParameters = [{ type: "uint48" }, { type: "uint48" }, { type: "uint256" }] as const;
const sponsorshipTypes = {
  Sponsorship: [
    { name: "sender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "initCodeHash", type: "bytes32" },
    { name: "callDataHash", type: "bytes32" },
    { name: "accountGasLimits", type: "bytes32" },
    { name: "preVerificationGas", type: "uint256" },
    { name: "gasFees", type: "bytes32" },
    { name: "paymasterGasLimits", type: "bytes32" },
    { name: "entryPoint", type: "address" },
    { name: "validUntil", type: "uint48" },
    { name: "validAfter", type: "uint48" },
    { name: "maxCost", type: "uint256" },
  ],
} as const;

function uint(value: bigint | Hex, bits: number) {
  if (typeof value !== "bigint" && !/^0x[0-9a-f]+$/iu.test(value)) throw new Error("Invalid unsigned sponsorship value.");
  const parsed = BigInt(value);
  if (parsed < 0n || parsed >= 1n << BigInt(bits)) throw new Error("Sponsorship value exceeds its unsigned range.");
  return parsed;
}

function bytes(value: Hex) {
  if (!/^0x(?:[0-9a-f]{2})*$/iu.test(value)) throw new Error("Invalid sponsorship bytes.");
  return value;
}

function address(value: Address) {
  const normalized = getAddress(value);
  if (normalized === zeroAddress) throw new Error("Sponsorship address cannot be zero.");
  return normalized;
}

function packedPair(high: bigint | Hex, low: bigint | Hex) {
  return concatHex([toHex(uint(high, 128), { size: 16 }), toHex(uint(low, 128), { size: 16 })]);
}

function validateAuthorization(authorization: OperatorSponsorshipAuthorization) {
  if (!Number.isSafeInteger(authorization.chainId) || authorization.chainId <= 0) throw new Error("Invalid sponsorship chain.");
  for (const timestamp of [authorization.validAfter, authorization.validUntil]) {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp >= 2 ** 48) throw new Error("Invalid sponsorship validity.");
  }
  if (authorization.validUntil <= authorization.validAfter || authorization.validUntil - authorization.validAfter > operatorPaymasterMaxValiditySeconds) throw new Error("Sponsorship validity must be finite and at most 300 seconds.");
  if (uint(authorization.maxCostWei, 256) === 0n) throw new Error("Sponsorship cost must be positive.");
  address(authorization.paymaster);
  address(authorization.entryPoint);
  packedPair(authorization.paymasterVerificationGasLimit, authorization.paymasterPostOpGasLimit);
}

export function operatorSponsorshipTypedData(operation: OperatorUserOperation, authorization: OperatorSponsorshipAuthorization) {
  validateAuthorization(authorization);
  if (operation.factoryData && !operation.factory) throw new Error("Factory data requires a factory.");
  if (operation.factory && operation.factoryData === undefined) throw new Error("Factory deployment data is required.");
  const initCode = operation.factory ? concatHex([address(operation.factory), bytes(operation.factoryData!)]) : "0x";
  return {
    domain: { name: "OrcusOperatorPaymaster", version: "1", chainId: authorization.chainId, verifyingContract: address(authorization.paymaster) },
    types: sponsorshipTypes,
    primaryType: "Sponsorship" as const,
    message: {
      sender: address(operation.sender),
      nonce: uint(operation.nonce, 256),
      initCodeHash: keccak256(initCode),
      callDataHash: keccak256(bytes(operation.callData)),
      accountGasLimits: packedPair(operation.verificationGasLimit, operation.callGasLimit),
      preVerificationGas: uint(operation.preVerificationGas, 256),
      gasFees: packedPair(operation.maxPriorityFeePerGas, operation.maxFeePerGas),
      paymasterGasLimits: packedPair(authorization.paymasterVerificationGasLimit, authorization.paymasterPostOpGasLimit),
      entryPoint: address(authorization.entryPoint),
      validUntil: authorization.validUntil,
      validAfter: authorization.validAfter,
      maxCost: authorization.maxCostWei,
    },
  };
}

export function operatorSponsorshipHash(operation: OperatorUserOperation, authorization: OperatorSponsorshipAuthorization) {
  return hashTypedData(operatorSponsorshipTypedData(operation, authorization));
}

export function encodeOperatorPaymasterData(authorization: OperatorSponsorshipAuthorization, signature: Hex): Hex {
  validateAuthorization(authorization);
  if (size(bytes(signature)) !== 65) throw new Error("Operator sponsorship requires a 65-byte signature.");
  return concatHex([encodeAbiParameters(authorizationParameters, [authorization.validUntil, authorization.validAfter, authorization.maxCostWei]), signature]);
}

export function decodeOperatorPaymasterData(data: Hex) {
  if (size(bytes(data)) !== 161) throw new Error("Invalid operator paymaster data length.");
  const [validUntil, validAfter, maxCostWei] = decodeAbiParameters(authorizationParameters, sliceHex(data, 0, 96));
  return { validUntil, validAfter, maxCostWei, signature: sliceHex(data, 96) };
}

export const operatorPaymasterAbi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "constructor(address entryPoint_, address initialOwner, address initialSigner, uint256 initialMaxOperationCostWei)",
  "function entryPoint() view returns (address)",
  "function verifyingSigner() view returns (address)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function maxOperationCostWei() view returns (uint256)",
  "function getDeposit() view returns (uint256)",
  "function deposit() payable",
  "function withdrawTo(address withdrawAddress, uint256 amount)",
  "function setVerifyingSigner(address signer)",
  "function setMaxOperationCostWei(uint256 maxCostWei)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
  "function renounceOwnership()",
  "function getSponsorshipHash(PackedUserOperation userOp, uint48 validUntil, uint48 validAfter, uint256 maxCost) view returns (bytes32)",
  "function validatePaymasterUserOp(PackedUserOperation userOp, bytes32 userOpHash, uint256 maxCost) returns (bytes context, uint256 validationData)",
  "event VerifyingSignerChanged(address indexed oldSigner, address indexed newSigner)",
  "event MaxOperationCostChanged(uint256 oldMaxCostWei, uint256 newMaxCostWei)",
]);
