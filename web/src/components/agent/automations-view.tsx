"use client";

import { useState } from "react";
import { Clock3, GitBranch, Plus, Power, ShieldCheck } from "lucide-react";
import type { Workspace } from "@/lib/use-workspace";
import { api, displayError, post } from "@/lib/api";
import { time } from "@/lib/format";
import {
  Badge,
  Empty,
  Field,
  InlineError,
  Spinner,
  Status,
} from "../trading/primitives";

export function AutomationsView({ workspace: w }: { workspace: Workspace }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [accountId, setAccountId] = useState("");
  const [interval, setIntervalValue] = useState("300");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy("create");
    setError(null);
    try {
      await post("/api/automations", {
        name,
        instruction,
        accountId: accountId || w.session.accounts[0]?.id,
        intervalSeconds: Number(interval),
      });
      setCreating(false);
      setName("");
      setInstruction("");
      await w.refresh();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(id: string, status: string) {
    setBusy(id);
    setError(null);
    try {
      await api(`/api/automations/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: status === "active" ? "paused" : "active",
        }),
      });
      await w.refresh();
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="workspace-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONDITIONS, NOT GUESSWORK</span>
          <h1>Strategy automations</h1>
          <p>
            Owner-approved strategies evaluated by Chainlink CRE, executed
            within your permissions.
          </p>
        </div>
        <button
          className="button primary"
          type="button"
          disabled={!w.session.user || !w.session.accounts.length}
          onClick={() => setCreating((value) => !value)}
        >
          <Plus size={15} />
          New automation
        </button>
      </div>
      <div className="info-banner">
        <GitBranch size={17} />
        <span>
          <strong>CRE local simulation</strong> / the durable worker schedules
          evaluations. This is not hosted DON execution. Stopping the runner
          pauses conditional strategies, not owner controls.
        </span>
      </div>
      <InlineError message={error} />
      {creating && (
        <div className="automation-form">
          <h2>New approved strategy</h2>
          <div className="form-grid">
            <Field label="Name">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="My ETH accumulation"
              />
            </Field>
            <Field label="Trading account">
              <select
                value={accountId || w.session.accounts[0]?.id || ""}
                onChange={(event) => setAccountId(event.target.value)}
              >
                {w.session.accounts.map((account) => (
                  <option value={account.id} key={account.id}>
                    {account.venue} / {account.address.slice(0, 8)}...
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Evaluation interval">
              <select
                value={interval}
                onChange={(event) => setIntervalValue(event.target.value)}
              >
                <option value="300">Every 5 minutes</option>
                <option value="900">Every 15 minutes</option>
                <option value="3600">Hourly</option>
                <option value="86400">Daily</option>
              </select>
            </Field>
          </div>
          <Field
            label="Instruction and conditions"
            hint="Be specific about the asset, amount, trigger and limits. Owner permissions remain the final boundary."
          >
            <textarea
              rows={3}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="Check ETH market conditions every hour and propose a bounded trade..."
            />
          </Field>
          <div className="form-actions">
            <button
              className="button secondary"
              type="button"
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              type="button"
              disabled={
                busy === "create" || !name.trim() || !instruction.trim()
              }
              onClick={() => void create()}
            >
              {busy === "create" ? <Spinner /> : <ShieldCheck size={15} />}
              Create approved strategy
            </button>
          </div>
        </div>
      )}
      {!w.automations.length ? (
        <Empty
          title="Let your strategy do the waiting"
          action={
            w.session.user ? undefined : (
              <button
                className="button secondary small"
                type="button"
                onClick={() => void w.connect()}
              >
                Connect wallet
              </button>
            )
          }
        >
          Create a bounded strategy after adding your trading account and
          granting permissions. The worker keeps the schedule when your browser
          closes.
        </Empty>
      ) : (
        <div className="automation-list">
          {w.automations.map((job) => (
            <article className="automation-card" key={job.id}>
              <div className="automation-top">
                <span className="automation-icon">
                  <GitBranch size={18} />
                </span>
                <div>
                  <h2>{job.name}</h2>
                  <span>
                    <Clock3 size={12} />
                    Every {Math.round(job.intervalSeconds / 60)} min / next{" "}
                    {time(job.nextRunAt)}
                  </span>
                </div>
                <Status value={job.status} />
                <button
                  className="icon-button"
                  type="button"
                  aria-label={
                    job.status === "active"
                      ? "Pause automation"
                      : "Resume automation"
                  }
                  disabled={busy === job.id}
                  onClick={() => void toggle(job.id, job.status)}
                >
                  {busy === job.id ? <Spinner /> : <Power size={15} />}
                </button>
              </div>
              <p>{job.instruction}</p>
              {job.lastEvaluation ? (
                <div className="evaluation">
                  <span className="eyebrow">LATEST CRE EVALUATION</span>
                  <div>
                    <Status value={job.lastEvaluation.decision} />
                    <Badge>{job.lastEvaluation.source}</Badge>
                    <time>{time(job.lastEvaluation.observedAt)}</time>
                  </div>
                  <p>{job.lastEvaluation.reason}</p>
                  <code title={job.lastEvaluation.id}>
                    {job.lastEvaluation.id}
                  </code>
                  {job.lastEvaluation.requestId && (
                    <small>0G request: {job.lastEvaluation.requestId}</small>
                  )}
                </div>
              ) : (
                <div className="evaluation muted">
                  No evaluation received. Waiting for the configured runner.
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
