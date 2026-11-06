"use client";

import { useEffect, useRef, useState } from "react";
import { AgentRequestSession, emptyAgentRequests, type AgentRequestDraft } from "./agent-requests";

export function useAgentRequests(owner: string | undefined, onRefresh: () => Promise<void>) {
  const key = owner?.toLowerCase() ?? "";
  const [state, setState] = useState(() => emptyAgentRequests());
  const session = useRef<AgentRequestSession | null>(null);
  const refresh = useRef(onRefresh); refresh.current = onRefresh;
  useEffect(() => {
    setState(emptyAgentRequests(key));
    if (!key) return;
    const current = new AgentRequestSession(key, setState, () => refresh.current());
    session.current = current;
    void current.load();
    const timer = setInterval(() => { if (current.pending) void current.load(); }, 3000);
    const resume = () => { if (document.visibilityState !== "hidden") void current.load(); };
    window.addEventListener("focus", resume); document.addEventListener("visibilitychange", resume);
    return () => { current.dispose(); if (session.current === current) session.current = null; clearInterval(timer); window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, [key]);
  const visible = state.owner === key ? state : emptyAgentRequests(key);
  return { ...visible, reload: () => session.current?.owner === key ? session.current.load() : Promise.resolve(), submit: (draft: AgentRequestDraft) => session.current?.owner === key ? session.current.submit(draft) : Promise.resolve(false) };
}
