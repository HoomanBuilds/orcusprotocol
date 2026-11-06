import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { formatUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encryptMemory, quoteEncryptedUpload } from "../agent/src/storage/index";
import { selectStoragePayer } from "../packages/server/src/storage-payer";
import { Platform } from "../packages/server/src/platform";
import { AgentMemoryStore } from "../packages/server/src/memory";
import { Store } from "../packages/server/src/store";

let store = new Store();
try {
  const user = store.ensureUser(privateKeyToAccount(generatePrivateKey()).address), platform = new Platform(store);
  const limits = { maxGas0G: "0.003", maxStorageFee0G: "0.01" };
  const payer = selectStoragePayer(store, user, { limits, agent: () => { throw new Error("This verifier requires a configured platform storage payer."); } });
  assert.equal(payer.costBearer, "operator");
  const quote = await quoteEncryptedUpload(encryptMemory({ purpose: "encrypted-storage-verification", nonce: randomUUID() }, randomBytes(32)), payer.payerAddress);
  console.log(JSON.stringify({ phase: "read-only-quote", payerAddress: quote.payerAddress, flowAddress: quote.flowAddress, chainId: quote.chainId, balance0G: formatUnits(BigInt(quote.balanceWei), 18), estimatedGas0G: formatUnits(BigInt(quote.maximumEstimatedGasWei), 18), storageFee0G: formatUnits(BigInt(quote.storageFeeWei), 18), gasCap0G: limits.maxGas0G, storageFeeCap0G: limits.maxStorageFee0G, transactionsSubmitted: 0 }, null, 2));
  if (!process.argv.includes("--allow-testnet-storage-fees")) {
    console.log("Quote only. Funded verification requires explicit fee consent plus --expected-flow and --expected-payer.");
  } else {
    const option = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3).toLowerCase();
    assert.equal(option("expected-flow"), quote.flowAddress.toLowerCase(), "Bind the exact approved Flow destination before spending testnet fees.");
    assert.equal(option("expected-payer"), payer.payerAddress.toLowerCase(), "Bind the approved testnet payer before spending.");
    assert.ok(quote.canAfford);
    assert.ok(BigInt(quote.maximumEstimatedGasWei) <= 3_000_000_000_000_000n && BigInt(quote.storageFeeWei) <= 10_000_000_000_000_000n);
    process.env.ZEROG_STORAGE_ENABLED = "true";
    const note = new AgentMemoryStore(store, user.id).remember({ content: `Synthetic storage verification ${randomUUID()}`, kind: "note" });
    const backup = await platform.memory(user, "backup", { ...limits, expectedFlowAddress: quote.flowAddress });
    assert.ok("status" in backup);
    assert.equal(backup.status, "confirmed");
    const rootHash = backup.rootHash;
    store.db.close();
    store = new Store();
    const restored = await new Platform(store).memory(user, "restore");
    assert.equal(restored.rootHash, rootHash);
    assert.ok(new AgentMemoryStore(store, user.id).get(note.id));
    const expenses = (await new Platform(store).budget(user)).nativeExpenses;
    assert.ok(expenses.some(expense => expense.status === "confirmed" && expense.payerAddress.toLowerCase() === payer.payerAddress.toLowerCase()));
    console.log(JSON.stringify({ status: "passed", rootHash, expense: expenses[0], userNeeded0G: false, publicDeployments: 0 }, null, 2));
  }
} finally { if (store.db.open) store.db.close(); }
