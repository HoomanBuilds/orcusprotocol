import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import solc from "solc";
import type { Abi, Hex } from "viem";

const require = createRequire(import.meta.url);
export function compileOperatorPaymaster() {
  const filename = "contracts/src/OrcusOperatorPaymaster.sol";
  const source = readFileSync(fileURLToPath(new URL(`../../${filename}`, import.meta.url)), "utf8");
  const input = { language: "Solidity", sources: { [filename]: { content: source } }, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: (name: string) => {
    try { return { contents: readFileSync(require.resolve(name), "utf8") }; }
    catch { return { error: `Could not resolve Solidity dependency ${name}.` }; }
  } }));
  const errors = (output.errors ?? []).filter((error: { severity: string }) => error.severity === "error");
  if (errors.length) throw new Error(errors.map((error: { formattedMessage: string }) => error.formattedMessage).join("\n"));
  const contract = output.contracts[filename].OrcusOperatorPaymaster;
  return { abi: contract.abi as Abi, bytecode: `0x${contract.evm.bytecode.object}` as Hex };
}
