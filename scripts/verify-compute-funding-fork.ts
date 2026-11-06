import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, defineChain, formatEther, http, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { computePaymentVault, readComputeVaultBalance, reconcileComputeFunding, submitComputeFunding, validateComputeFunding } from "../agent/src/budget/funding";
import { assertComputeFundingAuthority, configureComputeFunding, getComputeFundingPolicy, prepareComputeFunding, recordComputeFundingSubmission, settleComputeFunding } from "../packages/server/src/compute-funding";
import { Store } from "../packages/server/src/store";
import { withGalileoFork } from "./lib/galileo-fork";

await withGalileoFork(async ({ rpcUrl, rpc, block }) => {
  process.env.ZEROG_STORAGE_RPC_URL = rpcUrl;
  const payerKey = generatePrivateKey(), payer = privateKeyToAccount(payerKey), owner = privateKeyToAccount(generatePrivateKey()), beneficiary = privateKeyToAccount(generatePrivateKey()), unrelated = privateKeyToAccount(generatePrivateKey());
  const galileo = defineChain({ id: 16602, name: "Isolated Galileo fork", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } }, testnet: true });
  const client = createPublicClient({ chain: galileo, transport: http(rpcUrl) });
  assert.ok(await client.getCode({ address: computePaymentVault }));
  await rpc("anvil_setBalance", [payer.address, toHex(parseEther("1"))]);
  const before = await readComputeVaultBalance(beneficiary.address), unrelatedBefore = await readComputeVaultBalance(unrelated.address);
  const directory = mkdtempSync(join(tmpdir(), "orcus-compute-funding-fork-")), path = join(directory, "funding.sqlite");
  let store = new Store(path);
  try {
    const user = store.ensureUser(owner.address);
    const managementReadFixture = { status: "verified", source: "0g-router", chainId: 16602, currency: "0g", accountAddress: beneficiary.address, balanceNeurons: "0", observedAt: Date.now() };
    const context = { operatingAddress: payer.address, providerBalance: managementReadFixture, paymentVaultBalance: before };
    const policy = { enabled: true, chainId: 16602, currency: "0g", computeAccountAddress: beneficiary.address, topUp0G: "0.001", maximumTotal0G: "0.004", lowBalance0G: "0.0001", maxGas0G: "0.003", expiresAt: Date.now() + 600_000 };
    assert.throws(() => configureComputeFunding(store, user, policy, { ...context, providerBalance: { ...managementReadFixture, chainId: 16661 } }), /Mainnet accounts/);
    assert.throws(() => configureComputeFunding(store, user, { ...policy, maximumTotal0G: "0.001" }, context), /deposit and its maximum gas/);
    configureComputeFunding(store, user, policy, context);
    const prepared = prepareComputeFunding(store, user, "isolated-vault-payment", context);
    assert.equal(prepared.status, "prepared"); if (prepared.status !== "prepared") throw new Error("No compute funding intent.");
    const intent = prepared.intent;
    assert.throws(() => validateComputeFunding({ ...intent, computeAccountAddress: unrelated.address }), /approved compute account/);
    assert.equal(prepareComputeFunding(store, user, "isolated-vault-payment", context).status, "prepared");
    assert.equal(getComputeFundingPolicy(store, user).reserved0G, "0.004");
    const result = await submitComputeFunding(intent, payerKey, {
      assertAuthority: () => { assertComputeFundingAuthority(store, user, intent.id); },
      onSubmissionIntent: transactionHash => { recordComputeFundingSubmission(store, user, intent.id, transactionHash); },
    });
    assert.equal(result.status, "confirmed");
    assert.equal(getComputeFundingPolicy(store, user).intents[0].status, "submitting");
    store.db.close(); store = new Store(path);
    const persisted = getComputeFundingPolicy(store, user).intents[0];
    assert.equal(persisted.transactionHash, result.transactionHash);
    const recovered = await reconcileComputeFunding(persisted, persisted.transactionHash!);
    assert.equal(recovered.status, "confirmed"); assert.equal(recovered.creditStatus, "awaiting-router-sync");
    settleComputeFunding(store, user, intent.id, recovered); settleComputeFunding(store, user, intent.id, recovered);
    const final = getComputeFundingPolicy(store, user), after = await readComputeVaultBalance(beneficiary.address), unrelatedAfter = await readComputeVaultBalance(unrelated.address);
    assert.equal(BigInt(after.balanceNeurons) - BigInt(before.balanceNeurons), BigInt(intent.amountWei));
    assert.equal(unrelatedAfter.balanceNeurons, unrelatedBefore.balanceNeurons);
    assert.equal(final.reserved0G, "0"); assert.equal(final.spent0G, formatEther(BigInt(intent.amountWei) + BigInt(recovered.gasPaidWei!)));
    assert.equal(final.intents[0].evidence?.creditStatus, "awaiting-router-sync");
    const blocked = prepareComputeFunding(store, user, "do-not-double-top-up", { ...context, providerBalance: { ...managementReadFixture, observedAt: Date.now() }, paymentVaultBalance: after });
    assert.equal(blocked.status, "no-action"); if (blocked.status !== "no-action") throw new Error("Duplicate deposit was not blocked.");
    assert.match(blocked.reason, /awaiting a later Router balance/);
    assert.equal(await client.getBalance({ address: owner.address }), 0n);
    console.log(JSON.stringify({ scope: "isolated-galileo-fork", forkBlock: block, chainId: 16602, publicNetworkWrites: 0, protocolDeployments: 0, actualExistingPaymentVault: computePaymentVault, transactionHash: recovered.transactionHash, beneficiary: beneficiary.address, deposit0G: policy.topUp0G, actualGas0G: formatEther(BigInt(recovered.gasPaidWei!)), spent0G: final.spent0G, reserve0G: final.reserved0G, creditStatus: recovered.creditStatus, managementBalanceSource: "explicit-local-test-fixture-not-real-Router-response", verified: ["existing deployed PaymentVault.depositFor execution", "exact beneficiary balance increase", "unrelated beneficiary unchanged", "owner native balance unchanged", "native deposit and gas caps", "durable signed intent before broadcast", "receipt recovery after SQLite reopen", "idempotent expense settlement", "no second deposit while Router sync is unproven"], notProven: ["real Router management balance", "Router worker credit synchronization", "production Router funding", "public funded transaction", "service revenue paying inference"] }, null, 2));
  } finally { store.db.close(); rmSync(directory, { recursive: true, force: true }); }
});
