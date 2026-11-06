import { describe, expect, it } from "vitest";
import type { Automation } from "@orcus/core";
import { automationControl, automationFailure } from "./automation-ux";

const now = Date.now();
const job: Automation = { id: "job", userId: "user", accountId: "account", name: "ETH rule", instruction: "Monitor ETH", intervalSeconds: 300, status: "active", nextRunAt: now + 60_000, policyVersion: 1, expiresAt: now + 60_000, createdAt: now };

describe("automation control and failure states", () => {
  it("always permits pausing an active strategy but requires explicit resumption after agent pause", () => {
    expect(automationControl(job, true, now)).toMatchObject({ disabled: false, label: "Pause automation" });
    expect(automationControl({ ...job, status: "paused" }, true, now)).toMatchObject({ disabled: true, label: "Resume automation" });
    expect(automationControl({ ...job, status: "paused" }, false, now)).toMatchObject({ disabled: false });
  });
  it("never offers resume for an expired grant, including the exact expiry boundary", () => {
    for (const candidate of [{ ...job, status: "expired" as const }, { ...job, expiresAt: now }, { ...job, expiresAt: now - 1 }]) expect(automationControl(candidate, false, now)).toMatchObject({ disabled: true, label: "Automation expired" });
  });
  it("explains budget and runner recovery without exposing upstream secrets", () => {
    expect(automationFailure({ ...job, status: "insufficient-budget" })).toMatch(/expense|allowance/);
    expect(automationFailure({ ...job, status: "failed", error: "CRE runner failed https://private.example/key-secret" })).toMatch(/workflow runner/);
    expect(automationFailure({ ...job, status: "failed", error: "CRE runner failed https://private.example/key-secret" })).not.toContain("private.example");
    expect(automationFailure({ ...job, status: "failed", error: "permission expired" })).toMatch(/authority changed/);
    expect(automationFailure(job)).toBeUndefined();
  });
});
