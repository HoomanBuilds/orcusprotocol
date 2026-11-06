import { validMasterKey, validateDataDir, validatePublicAppUrl } from "./demo-setup";
import { workerConfiguration } from "../../agent/src/worker-config";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export function doctorRuntimeConfiguration(environment: NodeJS.ProcessEnv, projectRoot: string) {
  const checks: { name: string; configured: boolean; message: string }[] = [];
  const check = (name: string, test: () => unknown, message: string) => {
    try { test(); checks.push({ name, configured: true, message: "configured; not a live service readiness check" }); }
    catch { checks.push({ name, configured: false, message }); }
  };
  check("Public application origin", () => validatePublicAppUrl(environment.ORCUS_APP_URL ?? ""), "set ORCUS_APP_URL to the public HTTPS origin, or HTTP loopback for local development");
  check("Persistent runtime directory", () => validateDataDir(environment.ORCUS_DATA_DIR ?? "", projectRoot), "set absolute ORCUS_DATA_DIR outside the checkout; run demo:setup --check to check existing private files");
  check("Runtime encryption key", () => { if (!validMasterKey(environment.ORCUS_MASTER_KEY ?? "")) throw new Error(); }, "set the original 32-byte ORCUS_MASTER_KEY; never replace a key protecting existing data");
  check("Authenticated worker destination", () => workerConfiguration(environment), "set a valid worker HTTP(S) origin and ORCUS_INTERNAL_TOKEN containing at least 32 characters");
  check("CRE evaluation", () => {
    if (environment.CRE_ENABLED !== "true" || !environment.CRE_WORKFLOW_DIR || !isAbsolute(environment.CRE_WORKFLOW_DIR) || !statSync(environment.CRE_WORKFLOW_DIR).isDirectory()) throw new Error();
  }, "enable CRE and set CRE_WORKFLOW_DIR to the existing absolute workflow directory; CLI login and simulation remain separate checks");
  if (environment.ZEROG_STORAGE_ENABLED === "true") {
    check("Enabled storage payer", () => {
      const payer = environment.ZEROG_STORAGE_PAYER ?? "agent";
      if (payer !== "agent" && payer !== "operator") throw new Error();
      if (payer === "operator") {
        const key = environment.ZEROG_STORAGE_SPONSOR_PRIVATE_KEY;
        if (!key || !/^0x[\da-fA-F]{64}$/.test(key)) throw new Error();
        privateKeyToAccount(key as `0x${string}`);
        for (const [name, fallback] of [["ZEROG_STORAGE_SPONSOR_MAX_GAS_0G", "0.003"], ["ZEROG_STORAGE_SPONSOR_MAX_STORAGE_FEE_0G", "0.01"], ["ZEROG_STORAGE_SPONSOR_DAILY_CAP_0G", "0.05"]] as const) {
          const value = environment[name] ?? fallback;
          if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,18})?$/.test(value) || parseEther(value) <= 0n) throw new Error();
        }
      }
    }, "configure the explicitly enabled storage payer and its positive native caps; payer funding and upload acceptance are not verified");
  }
  return checks;
}
