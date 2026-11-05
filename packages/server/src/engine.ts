import * as engine from "@orcus/engine";
import { ApiError } from "./errors.js";

export async function callEngine<T>(name:string,...args:unknown[]):Promise<T> {
  const method=(engine as unknown as Record<string,unknown>)[name];
  if(typeof method!=="function")throw new ApiError("INTEGRATION_UNCONFIGURED",`${name} is not available in this build.`,503);
  return await (method as (...input:unknown[])=>Promise<T>)(...args);
}
