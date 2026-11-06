"use client";

import { useCallback, useEffect, useState } from "react";
import { api, displayError, post } from "@/lib/api";
import { Field, InlineError, Spinner } from "../trading/primitives";

type MemoryNote = { id: string; kind: "note" | "preference" | "episode"; content: string; source: string; updatedAt: number };
type MemoryResult = { notes: MemoryNote[]; checkpointAvailable: boolean; warning: string };

export function MemoryControls({ userId }: { userId: string }) {
  const [data, setData] = useState<MemoryResult | null>(null);
  const [query, setQuery] = useState("");
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<"note" | "preference">("note");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (search = "") => {
    const result = await api<MemoryResult>(`/api/memory${search ? `?query=${encodeURIComponent(search)}` : ""}`);
    setData(result);
  }, []);

  useEffect(() => {
    let active = true;
    api<MemoryResult>("/api/memory").then(result => { if (active) setData(result); }).catch(cause => { if (active) setError(displayError(cause)); });
    return () => { active = false; };
  }, [userId]);

  async function perform(action: "search" | "remember" | "forget", id?: string) {
    setBusy(id ?? action);
    setError(null);
    try {
      if (action === "remember") { await post("/api/memory/notes", { content, kind }); setContent(""); }
      if (action === "forget" && id) await api(`/api/memory/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load(query);
    } catch (cause) { setError(displayError(cause)); }
    finally { setBusy(null); }
  }

  return (
    <details className="technical-limits">
      <summary>Inspect and manage your agent&apos;s saved memory</summary>
      <p className="fine-print">The agent recalls saved preferences and relevant execution records across restarts. Memory never grants trading authority. Do not save credentials.</p>
      <div className="form-grid">
        <Field label="Find a saved memory"><input value={query} onChange={event => setQuery(event.target.value)} maxLength={500} placeholder="Search assets, preferences or past actions" /></Field>
        <button className="button secondary small" type="button" disabled={!!busy} onClick={() => void perform("search")}>{busy === "search" ? <Spinner /> : null}Search memory</button>
      </div>
      <div className="form-grid">
        <Field label="Save as"><select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="note">Note</option><option value="preference">Preference</option></select></Field>
        <Field label="Memory"><textarea rows={2} value={content} onChange={event => setContent(event.target.value)} maxLength={4000} /></Field>
      </div>
      <button className="button secondary small" type="button" disabled={!!busy || !content.trim()} onClick={() => void perform("remember")}>{busy === "remember" ? <Spinner /> : null}Remember this</button>
      <InlineError message={error} />
      {data?.notes.map(note => (
        <div className="evaluation" key={note.id}>
          <small>{note.kind} / {new Date(note.updatedAt).toLocaleString()}</small>
          <p>{note.content}</p>
          <button className="button secondary small" type="button" disabled={!!busy} onClick={() => void perform("forget", note.id)}>{busy === note.id ? <Spinner /> : null}Forget</button>
        </div>
      ))}
      {data && !data.notes.length && <p className="fine-print">No saved memory matches this search.</p>}
      {data && <p className="fine-print">{data.checkpointAvailable ? "A durable agent checkpoint is available." : "No agent checkpoint yet."} {data.warning}</p>}
    </details>
  );
}
