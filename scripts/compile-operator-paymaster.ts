import { mkdirSync, writeFileSync } from "node:fs";
import { compileOperatorPaymaster } from "./lib/compile-operator-paymaster";

const artifact = compileOperatorPaymaster();
mkdirSync("contracts/artifacts", { recursive: true });
writeFileSync("contracts/artifacts/OrcusOperatorPaymaster.json", JSON.stringify(artifact, null, 2));
console.log("Compiled OrcusOperatorPaymaster to contracts/artifacts/OrcusOperatorPaymaster.json. No deployment or funding performed.");
