import assert from "node:assert/strict";

export async function verifyComputeRestartReplay(request: (path: string, body?: unknown) => Promise<unknown>, input: { instruction: unknown; requestIds: string[]; spentUsd: string }) {
  const replay = await request("agent/chat", input.instruction) as { requestIds?: string[] };
  assert.deepEqual(replay.requestIds, input.requestIds);
  const budget = await request("budget") as { spentUsd?: string; reservedUsd?: string };
  assert.equal(budget.spentUsd, input.spentUsd);
  assert.equal(budget.reservedUsd, "0.000000");
  const memory = await request("memory?query=leverage") as { notes?: unknown[] };
  assert.ok(memory.notes?.length);
  return { name: "restart-replay-and-memory-no-extra-charge", requestIds: replay.requestIds };
}
