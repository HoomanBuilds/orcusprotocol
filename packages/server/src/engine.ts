import * as engine from "@orcus/engine";
import { ApiError } from "./errors";

export async function callEngine<T>(name:string,...args:unknown[]):Promise<T> {
  const method=(engine as unknown as Record<string,unknown>)[name];
  if(typeof method!=="function")throw new ApiError("INTEGRATION_UNCONFIGURED",`${name} is not available in this build.`,503);
  try{return await (method as (...input:unknown[])=>Promise<T>)(...args);}
  catch(error){
    if(error instanceof ApiError)throw error;
    if(error instanceof Error&&"code"in error&&"status"in error&&typeof error.code==="string"&&typeof error.status==="number"){
      const wrapped=new ApiError(error.code,error.message,error.status);
      const phase="phase"in error&&["not-submitted","submitted-unknown","reverted"].includes(String(error.phase))?error.phase:undefined;
      const source="evidence"in error&&error.evidence&&typeof error.evidence==="object"?error.evidence as Record<string,unknown>:{};
      const evidence=Object.fromEntries(["transactionHash","userOperationHash"].flatMap(key=>typeof source[key]==="string"&&/^0x[\da-fA-F]{64}$/.test(source[key])?[[key,source[key]]]:[]));
      throw Object.assign(wrapped,{...(phase?{phase}:{}),...(Object.keys(evidence).length?{evidence}:{})});
    }
    throw error;
  }
}
