"use client";

import { useCallback, useEffect, useState } from "react";
import { api, displayError, post } from "@/lib/api";
import { Field, InlineError, Spinner } from "../trading/primitives";
import styles from "./settings-panels.module.css";

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
    <section className={`settings-card ${styles.card}`}>
      <div className={styles.heading}><div><h2>Saved memory</h2><p>Notes and preferences your agent can recall.</p></div></div>
      <form className={styles.search} onSubmit={event => { event.preventDefault(); if (!busy) void perform("search"); }}>
        <Field label="Search memory"><input value={query} onChange={event => setQuery(event.target.value)} maxLength={500} placeholder="Asset, preference or past action" /></Field>
        <button className="button secondary" type="submit" disabled={!!busy}>{busy === "search" ? <Spinner /> : null}Search</button>
      </form>
      <details className={styles.disclosure}>
        <summary>Add a memory</summary>
        <form className={styles.stack} onSubmit={event => { event.preventDefault(); if (!busy && content.trim()) void perform("remember"); }}>
          <Field label="Type"><select value={kind} disabled={!!busy} onChange={event => setKind(event.target.value as typeof kind)}><option value="note">Note</option><option value="preference">Preference</option></select></Field>
          <Field label="What should your agent remember?"><textarea rows={3} value={content} disabled={!!busy} onChange={event => setContent(event.target.value)} maxLength={4000} placeholder="I prefer lower leverage and want to avoid overnight positions." /></Field>
          <p className={styles.hint}>Never add passwords or private keys. Memories do not grant trading permission.</p>
          <button className="button secondary" type="submit" disabled={!!busy || !content.trim()}>{busy === "remember" ? <Spinner /> : null}Save memory</button>
        </form>
      </details>
      <InlineError message={error} />
      {!data && !error && <p className={styles.hint} role="status">Loading saved memory...</p>}
      <div className={styles.stack}>
      {data?.notes.map(note => (
        <article className={styles.note} key={note.id}>
          <header><small>{note.kind} · {new Date(note.updatedAt).toLocaleDateString()}</small>
          <button className="text-link" type="button" disabled={!!busy} onClick={() => void perform("forget", note.id)}>{busy === note.id ? <Spinner /> : null}Forget</button></header>
          <p>{note.content}</p>
        </article>
      ))}
      </div>
      {data && !data.notes.length && <div className={styles.empty}><strong>{query ? "No matching memories" : "A fresh start"}</strong><p>{query ? "Try another search, or add a note above." : "Add a preference or note for your agent to remember."}</p></div>}
      {data && <details className={styles.disclosure}><summary>Persistence details</summary><p>{data.checkpointAvailable ? "A durable agent checkpoint is available." : "No agent checkpoint yet."} {data.warning}</p></details>}
    </section>
  );
}
