import { describe, expect, it } from "vitest";
import { computePriceCeilings } from "./pricing";

describe("compute reservation price ceilings", () => {
  it("uses byte-bounded input and output ceilings whose worst-case charge fits the reservation", () => {
    const messages = [{ content: "Analyze ETH" }, { content: "नमस्ते" }], output = 1000;
    const headers = computePriceCeilings("0.01", messages, output);
    const ceilingMicros = BigInt(headers["X-0G-Provider-Max-Price-Usd-Prompt"].replace(".", ""));
    const bound = BigInt(Buffer.byteLength(JSON.stringify(messages), "utf8") + messages.length * 32 + 256 + output);
    expect(ceilingMicros * bound <= 9999n * 1_000_000n).toBe(true);
    expect(headers["X-0G-Provider-Max-Price-Usd-Completion"]).toBe(headers["X-0G-Provider-Max-Price-Usd-Prompt"]);
  });
  it("keeps direct unbudgeted calls explicit and rejects malformed reservations", () => {
    expect(computePriceCeilings(undefined, [], 1)).toEqual({});
    expect(computePriceCeilings("0", [], 1)["X-0G-Provider-Max-Price-Usd-Prompt"]).toBe("0");
    expect(() => computePriceCeilings("-1", [], 1)).toThrow("expense reservation");
  });
});
