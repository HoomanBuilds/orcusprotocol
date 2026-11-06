import { EngineError } from "../errors";

const credentialToken = /\b(?:sk|mk|pk)[_-][A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i;
const credentialAssignment = /\b(?:private[\s_-]*key|seed[\s_-]*phrase|mnemonic|api[\s_-]*key|password|secret[\s_-]*key)\s*["']?\s*[:=]\s*["']?[^\s"']+/i;
const publicEvidenceLabel = /\b(?:transaction|tx(?:n)?|request|block|user[ _-]?operation|userop|storage[ _-]?root|root|order)(?:[ _-]?(?:hash|id))?\s*[:=]?\s*$/i;

export function containsCredentialMaterial(value: string): boolean {
  if (credentialToken.test(value) || credentialAssignment.test(value)) return true;
  for (const match of value.matchAll(/\b0x[\da-fA-F]{64}\b/g)) {
    if (!publicEvidenceLabel.test(value.slice(Math.max(0, match.index - 64), match.index))) return true;
  }
  return false;
}

export function rejectCredentialMaterial(value: string, code = "CREDENTIAL_INPUT_REJECTED") {
  if (containsCredentialMaterial(value)) throw new EngineError(code, "Remove credentials and label any public transaction hash explicitly. No credential content was forwarded.", 400);
}

export function redactCredentialMaterial(value: string): string {
  return containsCredentialMaterial(value) ? "[credential-containing text omitted]" : value;
}
