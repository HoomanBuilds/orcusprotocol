import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../lib/use-workspace";
import { SettingsView } from "./settings-view";
import { ServicePaymentPanel } from "./service-payment-panel";
import { MemoryControls } from "./memory-controls";

vi.mock("../../lib/wallets", () => ({}));
vi.mock("./ostium-account-card", () => ({ OstiumAccountCard: () => null }));
vi.mock("./compute-funding-panel", () => ({ ComputeFundingPanel: () => <div>Native funding controls</div> }));

const workspace = {
  session: { user: { id: "user", address: `0x${"1".repeat(40)}` }, accounts: [], agent: null },
  agentData: null, budget: { availableUsd: "20", spentUsd: "3", reservedUsd: "2", limitUsd: "25", expenses: [], nativeExpenses: [], storagePayer: { enabled: false, costBearer: "operator" } },
  health: { compute: { configured: true, message: "Configured inference endpoint" }, cre: { configured: false, message: "Missing runner" } },
  refresh: vi.fn(), control: vi.fn(),
} as unknown as Workspace;

describe("focused settings panels", () => {
  it("distinguishes spending allowance, recorded expenses and pending reservations", () => {
    const html = renderToStaticMarkup(<SettingsView workspace={workspace} section="budget"/>);
    expect(html).toContain("Remaining expense allowance");
    expect(html).toContain("Spending limit, not a funded balance");
    expect(html).toContain("Recorded expenses");
    expect(html).toContain("Reserved for pending work");
    expect(html).toContain("Saving this limit does not deposit funds or add compute credits");
    expect(html).toMatch(/<details[^>]*><summary>Advanced compute funding/);
    expect(html).not.toContain("Maximum trade size");
  });

  it("keeps preferences separate from account permissions and disables unavailable backups", () => {
    const html = renderToStaticMarkup(<SettingsView workspace={workspace} section="agent"/>);
    expect(html).toContain("Preferences stay within your account permissions");
    expect(html).toContain("Ask me first");
    expect(html).toContain("Within my limits");
    expect(html).toContain("Saved memory");
    expect(html).toContain("Cloud backups are disabled");
    expect(html).toMatch(/disabled=""[^>]*>Back up memory/);
    expect(html).not.toContain(">Running<");
  });

  it("never presents configured services as proven live execution", () => {
    const html = renderToStaticMarkup(<SettingsView workspace={workspace} section="services"/>);
    expect(html).toContain("Configured does not guarantee a successful live request");
    expect(html).toContain("Local workflow simulation");
    expect(html).toContain("not hosted DON execution");
    expect(html).toContain("Not configured");
    expect(html).toContain("Checking");
    expect(html).toMatch(/<details[^>]*><summary>View details/);
  });

  it("keeps backup actions disabled until configuration is known", () => {
    const loading = { ...workspace, budget: { ...workspace.budget, storagePayer: undefined } } as Workspace;
    const html = renderToStaticMarkup(<SettingsView workspace={loading} section="agent"/>);
    expect(html).toContain("Waiting for backup configuration");
    expect(html).toMatch(/disabled=""[^>]*>Back up memory/);
    expect(html).toMatch(/disabled=""[^>]*>Restore latest backup/);
    expect(html).not.toContain("Each backup can spend");
  });

  it("does not offer checkout before loading its configuration", () => {
    const html = renderToStaticMarkup(<ServicePaymentPanel owner={workspace.session.user!.address} onRefresh={workspace.refresh}/>);
    expect(html).toContain("Loading payment configuration");
    expect(html).not.toContain("Add test credits (USDC)");
    expect(html).not.toContain("Pay in owner wallet");
  });

  it("separates memory search and entry, without inventing a loaded empty state", () => {
    const html = renderToStaticMarkup(<MemoryControls userId="user"/>);
    expect(html).toContain("Loading saved memory");
    expect(html).not.toContain("A fresh start");
    expect(html).toMatch(/<details[^>]*><summary>Add a memory/);
    expect(html).toContain("Never add passwords or private keys");
  });
});
