import { describe, expect, it, vi } from "vitest";
import { ServicePaymentScope } from "./service-payment-scope";

describe("service payment owner request isolation", () => {
  it("ignores a late owner's response after switching away and back", async () => {
    const scope = new ServicePaymentScope("OWNER-A"), apply = vi.fn(); scope.activate();
    const ticket = scope.capture();
    let resolve!: (value: string) => void;
    const response = new Promise<string>(done => { resolve = done; }).then(value => { if (scope.isCurrent(ticket)) apply(value); });
    scope.changeOwner("owner-b"); scope.activate(); scope.changeOwner("owner-a"); scope.activate();
    resolve("old owner's balance"); await response;
    expect(apply).not.toHaveBeenCalled();
    expect(scope.isCurrent(scope.capture())).toBe(true);
  });
  it("invalidates requests immediately on owner render change and on unmount", () => {
    const scope = new ServicePaymentScope("A"); scope.activate(); const first = scope.capture();
    scope.changeOwner("B"); expect(scope.isCurrent(first)).toBe(false);
    scope.activate(); const second = scope.capture(); scope.stop(); expect(scope.isCurrent(second)).toBe(false);
    scope.activate(); expect(scope.isCurrent(second)).toBe(false);
  });
  it("does not invalidate an unchanged owner merely because checksum casing changes", () => {
    const scope = new ServicePaymentScope("OWNER"); scope.activate(); const current = scope.capture();
    scope.changeOwner("owner"); expect(scope.isCurrent(current)).toBe(true);
  });
});
