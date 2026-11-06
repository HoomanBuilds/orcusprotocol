import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpenseBillingCheck } from "./expense-billing-check";

vi.mock("../trading/primitives", () => ({ InlineError: ({ message }: { message?: string }) => message ?? null, Spinner: () => "Loading" }));
afterEach(() => vi.unstubAllGlobals());

describe("unknown expense billing control", () => {
  it("shows a read-only recovery action without calling the provider while rendering", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const markup = renderToStaticMarkup(React.createElement(ExpenseBillingCheck, { owner: "owner-a", expenseId: "expense-1", status: "unknown", onRefresh: vi.fn(async () => undefined) }));
    expect(markup).toContain("Check provider billing");
    expect(markup).toContain("does not retry inference, transfer funds or top up compute");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["reserved", "settled", "released"])("does not offer a recovery action for %s expenses", status => {
    const markup = renderToStaticMarkup(React.createElement(ExpenseBillingCheck, { owner: "owner-a", expenseId: "expense-1", status, onRefresh: vi.fn(async () => undefined) }));
    expect(markup).toBe("");
  });
});
