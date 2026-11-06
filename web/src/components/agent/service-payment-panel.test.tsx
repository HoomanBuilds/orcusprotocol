import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServicePaymentPanel, servicePaymentCanPay, servicePaymentError } from "./service-payment-panel";

vi.mock("../trading/primitives", () => ({ Address: ({ value }: { value?: string }) => value ?? "Not configured", Badge: ({ children }: { children: React.ReactNode }) => children, Field: ({ label, children }: { label: string; children: React.ReactNode }) => <label>{label}{children}</label>, InlineError: ({ message }: { message?: string }) => message ?? null, Spinner: () => "Loading", Status: ({ value }: { value: string }) => value }));
afterEach(() => vi.unstubAllGlobals());

describe("testnet service-credit controls", () => {
  it("initially disables checkout and never fetches or broadcasts while rendering", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const markup = renderToStaticMarkup(React.createElement(ServicePaymentPanel, { owner: `0x${"1".repeat(40)}`, onRefresh: vi.fn(async () => undefined) }));
    expect(markup).toContain("Live payments are disabled");
    expect(markup).toContain("no token allowance or agent permission is granted");
    expect(markup).toContain("Sepolia ETH fee");
    expect(markup).toMatch(/disabled=""[^>]*>Review test payment/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires explicit confirmation and a fresh prepared quote, never enabling a submitted intent", () => {
    const intent = { status: "prepared", expiresAt: Date.now() + 1000 } as Parameters<typeof servicePaymentCanPay>[0];
    expect(servicePaymentCanPay(intent, true, true)).toBe(true);
    expect(servicePaymentCanPay(intent, true, false)).toBe(false);
    expect(servicePaymentCanPay(intent, false, true)).toBe(false);
    expect(servicePaymentCanPay({ ...intent!, status: "submitted" }, true, true)).toBe(false);
    expect(servicePaymentCanPay({ ...intent!, transactionHash: `0x${"a".repeat(64)}` }, true, true)).toBe(false);
    expect(servicePaymentCanPay(intent, true, true, Date.now() + 2000)).toBe(false);
  });
  it("translates pending and replay failures without leaking raw provider details", () => {
    expect(servicePaymentError({ code: "SERVICE_PAYMENT_PENDING", message: "rpc-secret" })).toContain("same intent");
    expect(servicePaymentError({ code: "SERVICE_PAYMENT_REPLAY" })).toContain("already granted");
    expect(servicePaymentError(new Error("rpc-secret"))).not.toContain("rpc-secret");
  });
});
