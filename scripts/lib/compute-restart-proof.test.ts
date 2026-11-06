import { describe, expect, it, vi } from "vitest";
import { verifyComputeRestartReplay } from "./compute-restart-proof";

const instruction = { requestId: "existing-reference", message: "Remember a preference; never trade." };
const input = { instruction, requestIds: ["original-provider-id"], spentUsd: "0.000123" };

describe("non-billable compute restart verification", () => {
  it("replays only the original authenticated request and read-only persisted evidence", async () => {
    const request = vi.fn().mockResolvedValueOnce({ requestIds: input.requestIds }).mockResolvedValueOnce({ spentUsd: input.spentUsd, reservedUsd: "0.000000" }).mockResolvedValueOnce({ notes: [{}] });
    await expect(verifyComputeRestartReplay(request, input)).resolves.toMatchObject({ requestIds: input.requestIds });
    expect(request.mock.calls).toEqual([["agent/chat", instruction], ["budget"], ["memory?query=leverage"]]);
  });
  it("stops immediately if the original cached provider identity is not recovered", async () => {
    const request = vi.fn().mockResolvedValue({ requestIds: ["different-id"] });
    await expect(verifyComputeRestartReplay(request, input)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  });
  it.each([{ spentUsd: "0.000124", reservedUsd: "0.000000" }, { spentUsd: input.spentUsd, reservedUsd: "0.010000" }])("refuses cost drift or newly reserved inference after restart", async budget => {
    const request = vi.fn().mockResolvedValueOnce({ requestIds: input.requestIds }).mockResolvedValueOnce(budget);
    await expect(verifyComputeRestartReplay(request, input)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
