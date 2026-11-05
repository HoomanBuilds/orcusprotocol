export { OrcusError as ApiError } from "@orcus/core";
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "The request could not be completed."; }
