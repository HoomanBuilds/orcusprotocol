"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "@orcus/core";
import { Check, CircleAlert, ExternalLink } from "lucide-react";

const toolLabels: Record<string, string> = {
  read_markets: "Market prices", read_portfolio: "Account positions", analyze_market: "Technical analysis",
  read_market_context: "Funding and order book", search_research: "Research sources", search_memory: "Personal context",
  remember_preference: "Preference saved", forget_memory: "Memory removal", propose_action: "Trade proposal", propose_automation: "Automation proposal",
};

export function safeResearchUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

export function AgentResponse({ content }: { content: string }) {
  return <div className="agent-response"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeResearchUrl} components={{
    a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}<ExternalLink size={11} aria-hidden="true" /></a> : <span>{children}</span>,
    img: () => null,
    table: ({ children }) => <div className="agent-table-scroll" role="region" aria-label="Research comparison" tabIndex={0}><table>{children}</table></div>,
  }}>{content}</Markdown></div>;
}

export function AgentToolActivity({ steps }: { steps: ChatMessage["toolSteps"] }) {
  if (!steps?.length) return null;
  const sources = steps.filter(step => step.ok).flatMap(step => step.sources ?? []).filter((source, index, all) => safeResearchUrl(source.url) && all.findIndex(item => item.url === source.url) === index).slice(0, 12);
  return <><details className="agent-tool-activity"><summary>{steps.filter(step => step.ok).length} completed checks{steps.some(step => !step.ok) ? " / some unavailable" : ""}</summary><ol>{steps.map((step, index) => <li key={`${step.name}:${index}`}>
    {step.ok ? <Check size={13} aria-hidden="true" /> : <CircleAlert size={13} aria-hidden="true" />}
    <span>{toolLabels[step.name] ?? "Agent tool"}<small>{step.ok ? "Completed" : "Unavailable"}</small></span>
    <time dateTime={new Date(step.observedAt).toISOString()}>{new Date(step.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
  </li>)}</ol></details>{sources.length > 0 && <div className="agent-source-list" aria-label="Research sources">{sources.map(source => <a key={source.url} href={safeResearchUrl(source.url)} target="_blank" rel="noopener noreferrer" title={`Retrieved ${new Date(source.retrievedAt).toLocaleString()}${source.network ? ` / ${source.network}` : ""}`}><ExternalLink size={12}/><span>{source.title}</span>{source.network && <small>{source.network}</small>}</a>)}</div>}</>;
}
