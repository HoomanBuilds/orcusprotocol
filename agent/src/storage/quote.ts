import { JsonRpcProvider, getAddress } from "ethers";
import { Indexer, MemData, FixedPriceFlow__factory, getMarketContract } from "@0gfoundation/0g-storage-ts-sdk";
import { engineConfig } from "../config";
import { EngineError } from "../errors";

export async function quoteEncryptedUpload(bytes: Uint8Array, payerAddress: string) {
  const payload = Buffer.from(bytes);
  if (payload.length < 37 || payload.length > 1_000_037 || payload.subarray(0, 9).toString() !== "ORCUSMEM1") throw new EngineError("INVALID_MEMORY", "Quote an encrypted Orcus memory object below one megabyte.");
  const cfg = engineConfig().storage, provider = new JsonRpcProvider(cfg.rpcUrl), payer = getAddress(payerAddress);
  try {
    if ((await provider.getNetwork()).chainId !== 16602n) throw new EngineError("WRONG_NETWORK", "Storage fee quotes are limited to Galileo testnet.", 409);
    const [nodes, selectionError] = await new Indexer(cfg.indexerUrl).selectNodes(1);
    if (selectionError || !nodes.length) throw new EngineError("STORAGE_SELECTION_FAILED", "No storage node is available for a read-only fee quote.", 502);
    const status = await nodes[0].getStatus();
    if (!status || Number(status.networkIdentity.chainId) !== 16602) throw new EngineError("WRONG_NETWORK", "The storage node does not report the configured Galileo network.", 409);
    const flowAddress = getAddress(status.networkIdentity.flowAddress);
    if (await provider.getCode(flowAddress) === "0x") throw new EngineError("INVALID_STORAGE_FLOW", "The selected Galileo storage Flow contract has no code.", 502);
    const data = new MemData(payload), flow = FixedPriceFlow__factory.connect(flowAddress, provider);
    const [submission, submissionError] = await data.createSubmission("0x", payer);
    if (submissionError || !submission) throw new EngineError("STORAGE_HASH_FAILED", "The encrypted object submission could not be prepared.", 502);
    const price = await getMarketContract(await flow.market(), provider).pricePerSector();
    const sectors = submission.data.nodes.reduce((total, node) => total + (1n << BigInt(node.height)), 0n);
    const fee = sectors * price, fees = await provider.getFeeData();
    if (!fees.gasPrice || fees.gasPrice <= 0n) throw new EngineError("STORAGE_QUOTE_UNAVAILABLE", "The network did not report a usable gas price.", 502);
    const [estimate, balance] = await Promise.all([flow.getFunction("submit").estimateGas(submission, { from: payer, value: fee, gasPrice: fees.gasPrice }), provider.getBalance(payer)]);
    const gasLimit = (estimate * 120n + 99n) / 100n, gas = gasLimit * fees.gasPrice;
    return { chainId: 16602, payerAddress: payer, flowAddress, storageFeeWei: fee.toString(), gasLimit: gasLimit.toString(), gasPriceWei: fees.gasPrice.toString(), maximumEstimatedGasWei: gas.toString(), estimatedTotalWei: (fee + gas).toString(), balanceWei: balance.toString(), canAfford: balance >= fee + gas, encryptedBytes: payload.length, observedAt: Date.now(), transactionsSubmitted: 0 as const };
  } finally { provider.destroy(); }
}
