import { describe, expect, it } from "vitest";
import { automationInputSchema, tradeRequestSchema } from "@orcus/core";
import { parseUnits } from "viem";
import { createDemoData, DEMO_OBSERVED_AT, DEMO_OPERATING_ADDRESS, DEMO_OWNER_ADDRESS } from "./demo-workspace-data";
import { activityEntries, portfolioSummary } from "./workspace-model";

describe("explicit sample workspace", () => {
  it("uses a fixed sample observation rather than claiming current venue data", () => {
    expect(createDemoData(1)).toEqual(createDemoData(Date.now() + 86_400_000));
    const data = createDemoData();
    expect(data.metadata).toEqual({ kind: "sample", label: "Demo account", observedAt: DEMO_OBSERVED_AT, readOnly: true });
    expect(data.portfolio.observedAt).toBe(DEMO_OBSERVED_AT);
    expect(data.portfolio.positions.every(position => position.observedAt === DEMO_OBSERVED_AT)).toBe(true);
  });

  it("keeps each position, order and action on its matching venue account", () => {
    const data = createDemoData();
    expect(data.session.accounts.map(account => account.venue)).toEqual(["hyperliquid", "uniswap", "ostium"]);
    for (const record of [...data.portfolio.positions, ...data.portfolio.orders, ...data.actions.map(action => action.request)]) {
      expect(data.session.accounts.find(account => account.id === record.accountId)?.venue).toBe(record.venue);
    }
    expect(data.portfolio.orders.find(order => order.venue === "ostium")).toMatchObject({ size: "1", collateralUsd: "525", notionalUsd: "2625", leverage: 5, amountUnit: "base" });
    for (const action of data.actions) expect(tradeRequestSchema.safeParse(action.request).success).toBe(true);
  });

  it("reconciles equity, exposure and signed P&L without double-counting HL margin", () => {
    const { portfolio } = createDemoData();
    expect(portfolioSummary(portfolio, true)).toMatchObject({ equity: "23340.2", exposure: 15175, pnl: 265, complete: true });
    const scale = 1_000_000n;
    for (const position of portfolio.positions) {
      const delta = parseUnits(position.markPrice!, 6) - parseUnits(position.entryPrice, 6);
      const pnl = parseUnits(position.size, 6) * delta / scale * (position.side === "short" ? -1n : 1n);
      expect(parseUnits(position.unrealizedPnl, 6)).toBe(pnl);
    }
    expect(portfolio.balances.find(balance => balance.accountId === "demo-hyperliquid")?.usdValue).toBe("10175");
  });

  it("keeps operating allowance distinct from trading balances and provider verification", () => {
    const { budget, portfolio, payments, funding } = createDemoData();
    expect(budget.operatingAddress).toBe(DEMO_OPERATING_ADDRESS);
    expect(budget.operatingAddress).not.toBe(DEMO_OWNER_ADDRESS);
    expect(portfolio.accounts.some(account => account.address === budget.operatingAddress)).toBe(false);
    expect(parseUnits(budget.availableUsd, 6) + parseUnits(budget.spentUsd, 6) + parseUnits(budget.reservedUsd, 6)).toBe(parseUnits(budget.limitUsd, 6));
    expect(budget.computeBalanceStatus).toBe("unconfigured");
    expect(budget.providerBalance?.status).toBe("unconfigured");
    expect(payments.configured).toBe(false);
    expect(funding.policy).toBeNull();
  });

  it("provides meaningful saved content without execution evidence or live authority", () => {
    const data = createDemoData();
    expect(data.agentData.messages).toHaveLength(4);
    expect(data.agentData.permissions).toEqual([]);
    expect(data.automations).toHaveLength(2);
    for (const automation of data.automations) {
      expect(automation.status).toBe("paused");
      const { kind, accountId, name, instruction, intervalSeconds, request, condition, executionMode, maxExecutions } = automation;
      expect(automationInputSchema.safeParse({ kind, accountId, name, instruction, intervalSeconds, request, condition, executionMode, maxExecutions }).success).toBe(true);
      expect(automation.lastEvaluation).toBeUndefined();
    }
    const serialized = JSON.stringify(data);
    for (const key of ["transactionHash", "userOperationHash", "providerRequestId", "privacyEvidence", "modelId"]) expect(serialized).not.toContain(`"${key}"`);
    expect(serialized).not.toMatch(/0x[0-9a-fA-F]{64}/);
    for (const request of data.requests) {
      expect(request.id).toBe(request.requestId);
      expect(request.id.startsWith("demo-")).toBe(true);
      expect(request.modelCalls).toBe(0);
      expect(request.toolCalls).toBe(0);
    }
    const entries = activityEntries(data);
    expect(entries.length).toBe(6);
    expect(entries.filter(entry => entry.pending)).toHaveLength(1);
  });

  it("creates fresh independent fixtures on every demo reset", () => {
    const original = createDemoData();
    const changed = createDemoData();
    changed.portfolio.positions[0].size = "999";
    changed.agentData.messages.length = 0;
    expect(createDemoData()).toEqual(original);
  });
});
