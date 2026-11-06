"use client";

import { useEffect, useRef, useState } from "react";
import { api, displayError, post } from "@/lib/api";

type Model = { id: string; name: string; available: boolean; compatibility: "configured" | "catalog"; privacy: "catalog-tee" | "unverified"; pricing?: { promptPerMillionUsd: string; completionPerMillionUsd: string }; reason?: string };
type ModelCatalog = { defaultModelId: string; selectedModelId: string; catalogAvailable: boolean; checkedAt?: number; warning?: string; models: Model[] };

export function AgentModelSelector({ owner, disabled, onChange, onBusy, refresh }: { owner: string; disabled: boolean; onChange: (id: string | undefined) => void; onBusy: (busy: boolean) => void; refresh: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [selected, setSelected] = useState(""), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const ownerRef = useRef(owner), inFlight = useRef(false); ownerRef.current = owner;
  useEffect(() => {
    let active = true; ownerRef.current = owner;
    setCatalog(null); setSelected(""); setError(null); onChange(undefined);
    if (!owner) return;
    setLoading(true);
    void api<ModelCatalog>("/api/agent/models").then(result => {
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
  return <div className="agent-model-selector">
    <label><span>0G model</span><select aria-label="Inference model" value={selected} disabled={!owner || disabled || loading || saving || !catalog} onChange={event => void select(event.target.value)}>
      {!catalog && <option value="">{loading ? "Loading models..." : "Configured default"}</option>}
      {catalog && !catalog.models.some(item => item.id === selected) && <option value={selected}>{selected}</option>}
      {catalog?.models.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.name}{!item.available ? " (unavailable)" : ""}</option>)}
    </select>{saving && <small role="status">Saving...</small>}</label>
    {catalog && <details className="model-details"><summary>Model details</summary><p>{model?.compatibility === "configured" ? "Configured deployment model." : "Listed by the provider catalog; tool compatibility has not been live-verified."} Each accepted request keeps its selected model.</p>{model?.pricing && <p>Provider pricing per 1M tokens: ${model.pricing.promptPerMillionUsd} input / ${model.pricing.completionPerMillionUsd} output. Actual usage determines the charge.</p>}<p>{model?.privacy === "catalog-tee" ? "TEE support is reported by the catalog. This is not proof of privacy for an individual request." : "No request-specific privacy guarantee is shown for this model."}</p>{catalog.warning && <p>{catalog.warning}</p>}{model?.reason && <p>{model.reason}</p>}</details>}
    {error && <p className="model-error" role="alert">{error} Requests use the last confirmed model preference.</p>}
  </div>;
}
