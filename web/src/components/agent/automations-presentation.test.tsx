import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/lib/use-workspace";
import { AutomationsView } from "./automations-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const workspace = (ready: boolean) => ({
  session: { user: null, accounts: [] },
  markets: [], automations: [], health: { cre: { ready } },
}) as unknown as Workspace;

describe("compact workspace presentation", () => {
  it("offers all three automation choices without nested illustrative boxes", () => {
    const markup = renderToStaticMarkup(<AutomationsView workspace={workspace(false)}/>);
    for (const label of ["Price alert", "Scheduled trade", "Conditional trade"]) expect(markup).toContain(label);
    expect(markup.match(/Connect to configure/g)).toHaveLength(3);
    expect(markup).not.toContain("automation-rule-preview");
    expect(markup).not.toContain('automation-starter-top"><span>');
  });

  it.each([false, true])("keeps actual runner availability visible when ready is %s", ready => {
    const markup = renderToStaticMarkup(<AutomationsView workspace={workspace(ready)}/>);
    expect(markup).toContain(ready ? "Runner configured" : "Runner unavailable");
    expect(markup).toContain("<details><summary>Execution details</summary>");
    expect(markup).toContain("not hosted DON execution");
    if (!ready) expect(markup).toContain("Configure the runner before activating an automation.");
    expect(markup).toContain('disabled=""');
  });

  it("themes all workspace native options and keeps account address rows compact", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    expect(css).toContain(".product-workspace select { color-scheme: dark;");
    expect(css).toContain(".product-workspace select option, .product-workspace select optgroup { background: var(--surface-2);");
    expect(css).toContain(".settings-workspace-page .account-addresses { gap: 0; margin: 12px 0; }");
    expect(css).toContain(".settings-workspace-page .account-addresses > div { min-height: 44px; padding: 0;");
  });
});
