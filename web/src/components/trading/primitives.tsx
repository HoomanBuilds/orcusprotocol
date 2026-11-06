"use client";

import {
  Check,
  Copy,
  ExternalLink,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { shortAddress, statusLabel } from "@/lib/format";

export function Spinner() {
  return <LoaderCircle className="spin" size={15} aria-hidden="true" />;
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "bad" | "warn";
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Status({ value }: { value: string }) {
  const tone =
    /confirmed|active|authorized|allow|verified/.test(value) &&
    !/unverified/.test(value)
      ? "good"
      : /failed|rejected|revoked/.test(value)
        ? "bad"
        : /pending|paused|unconfigured|unknown|expired|insufficient-budget/.test(value)
          ? "warn"
          : "neutral";
  return <Badge tone={tone}>{statusLabel(value)}</Badge>;
}
export function Address({
  value,
  explorer,
}: {
  value?: string;
  explorer?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="muted">Not created</span>;
  return (
    <span className="address">
      <button
        title={`Copy ${value}`}
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          } catch {
            setCopied(false);
          }
        }}
      >
        <span>{shortAddress(value)}</span>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      {explorer && (
        <a
          href={`${explorer}/address/${value}`}
          target="_blank"
          rel="noreferrer"
          aria-label="View address on explorer"
        >
          <ExternalLink size={12} />
        </a>
      )}
    </span>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function InlineError({
  message,
  onDismiss,
}: {
  message?: string | null;
  onDismiss?: () => void;
}) {
  if (!message) return null;
  return (
    <div className="inline-error" role="alert">
      <TriangleAlert size={14} />
      <span>{message}</span>
      {onDismiss && (
        <button type="button" aria-label="Dismiss error" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
