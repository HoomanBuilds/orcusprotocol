import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentResponse, AgentToolActivity, safeResearchUrl } from "./agent-response";
import { AutomationPolicySummary } from "./automation-review-card";

describe("grounded conversation presentation", () => {
  it("renders actual markdown lists and comparison tables", () => {
    const markup = renderToStaticMarkup(<AgentResponse content={"## Summary\n\n- One\n- Two\n\n| Asset | Price |\n| --- | ---: |\n| ETH | 2000 |"}/>);
    expect(markup).toContain("<ul>"); expect(markup).toContain("<table>"); expect(markup).toContain("Research comparison");
  });
  it("does not load external images or run HTML from model output", () => {
    const markup = renderToStaticMarkup(<AgentResponse content={'![tracking](https://example.com/private-wallet)\n\n<script>alert(1)</script>\n\n[bad](javascript:alert)\n\n[Source](https://example.com/source)'}/>);
    expect(markup).not.toContain("<img"); expect(markup).not.toContain("<script"); expect(markup).not.toContain("javascript:");
    expect(markup).toContain('rel="noopener noreferrer"'); expect(markup).toContain('href="https://example.com/source"');
  });
  it.each(["javascript:alert(1)", "data:text/html,test", "https://user:secret@example.com", "/api/private", "not a URL"])("removes unsafe outbound URL %s", value => expect(safeResearchUrl(value)).toBe(""));
  it("shows completed and unavailable tool checks without claiming success for both", () => {
    const markup = renderToStaticMarkup(<AgentToolActivity steps={[{ name: "read_markets", ok: true, observedAt: 1000 }, { name: "search_research", ok: false, observedAt: 1000 }]}/>);
    expect(markup).toContain("1 completed checks / some unavailable"); expect(markup).toContain("Market prices"); expect(markup).toContain("Unavailable");
    expect(markup).not.toContain("reasoning");
  });
  it("surfaces exact approval limits without an activation action", () => {
    const markup = renderToStaticMarkup(<AutomationPolicySummary draft={{ name: "ETH alert", kind: "alert", accountId: "account", executionMode: "on-crossing", maxExecutions: 3, intervalSeconds: 300, condition: { symbol: "ETH", operator: "above", price: "2000" } }}/>);
    expect(markup).toContain("up to 3 notifications"); expect(markup).toContain("after a new crossing"); expect(markup).toContain("no trade"); expect(markup).not.toContain("<button");
  });
  it("shows actual successful sources only and never exposes failed or credential-bearing URLs", () => {
    const source = { id: "source", title: "Observed source", url: "https://example.com/research", retrievedAt: 1000, network: "testnet" };
    const markup = renderToStaticMarkup(<AgentToolActivity steps={[{ name: "search_research", ok: true, observedAt: 1000, sources: [source, source, { ...source, url: "https://user:secret@example.com/private" }] }, { name: "search_research", ok: false, observedAt: 1000, sources: [{ ...source, title: "Failed source", url: "https://example.com/failed" }] }]}/>);
    expect(markup).toContain("Observed source"); expect(markup).toContain("testnet");
    expect(markup).not.toContain("Failed source"); expect(markup).not.toContain("secret");
    expect(markup.match(/href="https:\/\/example.com\/research"/g)).toHaveLength(1);
  });
  it("keeps exact collateral units, protective levels and native order IDs visible", () => {
    const markup = renderToStaticMarkup(<AutomationPolicySummary draft={{ name: "Change BTC order", kind: "trade", accountId: "account", executionMode: "once", maxExecutions: 1, intervalSeconds: 300, request: { accountId: "account", venue: "ostium", type: "edit-order", side: "buy", symbol: "BTC/USD", amount: "100.000000000000001", amountUnit: "collateral-usdc", price: "90000", leverage: 5, takeProfit: "100000", stopLoss: "0", orderId: "order-42", mode: "agent", reduceOnly: false, slippageBps: 50 } }}/>);
    expect(markup).toContain("100.000000000000001 USDC collateral"); expect(markup).toContain("edit-order"); expect(markup).toContain("order-42"); expect(markup).toContain("90000 USD"); expect(markup).toContain("Clear protection"); expect(markup).toContain("5x leverage");
    expect(markup).not.toContain("100 BTC");
  });
});
