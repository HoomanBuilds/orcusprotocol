import * as engine from "@orcus/engine";
import { ApiError } from "./errors.js";

export async function callEngine<T>(name:string,...args:unknown[]):Promise<T> {
  const method=(engine as unknown as Record<string,unknown>)[name];
  if(typeof method!=="function")throw new ApiError("INTEGRATION_UNCONFIGURED",`${name} is not available in this build.`,503);
  try{return await (method as (...input:unknown[])=>Promise<T>)(...args);}
  catch(error){
    if(error instanceof ApiError)throw error;
    if(error instanceof Error&&"code"in error&&"status"in error&&typeof error.code==="string"&&typeof error.status==="number")throw new ApiError(error.code,error.message,error.status);
    throw error;
  }
}
