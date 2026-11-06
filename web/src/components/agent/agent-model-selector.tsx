"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentModelCatalog } from "@orcus/core";
import { api, displayError, post } from "@/lib/api";

export function AgentModelOptions({ catalog, selected, loading }: { catalog: AgentModelCatalog | null; selected: string; loading: boolean }) {
  if (!catalog) return <option value="">{loading ? "Loading models..." : "Configured default"}</option>;
  if (!catalog.models.length) return <option value="" disabled>No models available</option>;
  return <>{!catalog.models.some(item => item.id === selected) && <option value={selected}>{selected || "Select a model"}</option>}{catalog.models.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.name}{!item.available ? " (unavailable)" : ""}</option>)}</>;
}

export function AgentModelSelector({ owner, disabled, onChange, onBusy, refresh, compact = false }: { owner: string; disabled: boolean; onChange: (id: string | undefined) => void; onBusy: (busy: boolean) => void; refresh: () => Promise<void>; compact?: boolean }) {
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null);
  const [selected, setSelected] = useState(""), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const ownerRef = useRef(owner), inFlight = useRef(false); ownerRef.current = owner;
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const details = container.current?.querySelector("details");
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  useEffect(() => {
    let active = true; ownerRef.current = owner;
    setCatalog(null); setSelected(""); setError(null); onChange(undefined);
    if (!owner) return;
    setLoading(true);
    void api<AgentModelCatalog>("/api/agent/models").then(result => {
      if (!active) return;
      setCatalog(result); setSelected(result.selectedModelId); onChange(result.selectedModelId);
    }).catch(cause => { if (active) setError(displayError(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; ownerRef.current = ""; };
  }, [owner, onChange]);
  async function select(modelId: string) {
    if (!owner || inFlight.current || !catalog?.models.some(model => model.id === modelId && model.available)) return;
    inFlight.current = true; setSaving(true); setError(null); onBusy(true);
    try {
      await post("/api/agent/control", { command: "update", modelId });
      if (ownerRef.current !== owner) return;
      setSelected(modelId); onChange(modelId); await refresh();
    } catch (cause) { if (ownerRef.current === owner) setError(displayError(cause)); }
    finally { inFlight.current = false; if (ownerRef.current === owner) { setSaving(false); onBusy(false); } }
  }
  const model = catalog?.models.find(item => item.id === selected);
  return <div ref={container} className={`agent-model-selector${compact ? " compact" : ""}`}>
    <label><span>0G model</span><select aria-label="Inference model" value={selected} disabled={!owner || disabled || loading || saving || !catalog?.models.length} onChange={event => void select(event.target.value)}>
      <AgentModelOptions catalog={catalog} selected={selected} loading={loading}/>
    </select>{saving && <small role="status">Saving...</small>}</label>
    {catalog && <details className="model-details" onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary>{compact ? "Details" : "Model details / spending limits still apply"}</summary><div className="model-details-content"><p>{model?.compatibility === "configured" ? "Configured deployment model." : "Listed by the provider catalog; tool compatibility has not been live-verified."} Each accepted request keeps its selected model.</p>{model?.pricing && <p>Provider pricing per 1M tokens: ${model.pricing.promptPerMillionUsd} input / ${model.pricing.completionPerMillionUsd} output. Actual usage determines the charge.</p>}<p>Higher-cost models may be rejected by the current per-call spending ceiling. Selecting a model does not increase your budget.</p><p>{model?.privacy === "catalog-tee" ? "TEE support is reported by the catalog. This is not proof of privacy for an individual request." : "No request-specific privacy guarantee is shown for this model."}</p>{catalog.warning && <p>{catalog.warning}</p>}{model?.reason && <p>{model.reason}</p>}</div></details>}
    {error && <p className="model-error" role="alert">{error} Requests use the last confirmed model preference.</p>}
  </div>;
}
