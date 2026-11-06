import { describe, expect, it } from "vitest";
import { assertSuccessfulComputeFinal } from "./compute-final-proof";

const successful = { requiresClarification: false, message: { content: "Saved your preference: spot trading without leverage.", toolSteps: [{ name: "remember_preference", ok: true }] } };
describe("compute final-result verification", () => {
  it("requires an actual successful final result, not only a successful tool", () => {
    expect(() => assertSuccessfulComputeFinal(successful, "remember_preference", [/spot/i, /leverage/i])).not.toThrow();
    expect(() => assertSuccessfulComputeFinal({ ...successful, requiresClarification: true }, "remember_preference")).toThrow();
    expect(() => assertSuccessfulComputeFinal({ ...successful, message: { ...successful.message, content: "I could not verify the sources in that answer." } }, "remember_preference")).toThrow();
    expect(() => assertSuccessfulComputeFinal({ ...successful, message: { ...successful.message, content: "Okay" } }, "remember_preference", [/spot/i])).toThrow();
    expect(() => assertSuccessfulComputeFinal({ ...successful, message: { ...successful.message, toolSteps: [{ name: "remember_preference", ok: false }] } }, "remember_preference")).toThrow();
  });
});
