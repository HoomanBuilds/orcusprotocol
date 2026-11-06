import type { Automation } from "@orcus/core";

export function automationControl(job: Automation, agentPaused: boolean, now = Date.now()) {
  const expired = job.status === "expired" || job.expiresAt !== undefined && job.expiresAt <= now;
  if (expired) return { status: "expired", disabled: true, label: "Automation expired", detail: "This strategy expired. Create a new owner-approved strategy with a current grant." };
  if (job.status === "active") return { status: job.status, disabled: false, label: "Pause automation", detail: "Pausing stops new evaluations. Submitted actions and venue protective orders remain separate." };
  if (agentPaused) return { status: job.status, disabled: true, label: "Resume automation", detail: "Resume the agent first, then explicitly resume this strategy. Owner controls remain available." };
  return { status: job.status, disabled: false, label: "Resume automation", detail: job.status === "insufficient-budget" ? "Review the separate expense allowance before resuming. Trading principal is not used for operating costs." : "Resuming rechecks current permissions, budget and workflow readiness." };
}

export function automationFailure(job: Automation): string | undefined {
  if (!job.error && job.status !== "failed" && job.status !== "insufficient-budget") return;
  if (job.status === "insufficient-budget" || /budget|allowance/i.test(job.error ?? "")) return "Automation paused because its operating allowance is unavailable. Review the budget, then resume explicitly.";
  if (/permission|grant|authoriz|control/i.test(job.error ?? "")) return "Automation stopped after account authority changed. Review permissions before resuming.";
  if (/cre|runner|workflow/i.test(job.error ?? "")) return "The workflow runner could not complete this evaluation. Check service readiness before resuming; no result is fabricated.";
  return "The last evaluation failed. Check service readiness and existing activity before resuming.";
}
