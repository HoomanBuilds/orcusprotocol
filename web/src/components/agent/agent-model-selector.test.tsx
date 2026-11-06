import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentModelOptions, AgentModelSelector } from "./agent-model-selector";

describe("provider-backed model selection", () => {
  it("does not invent model choices or enable an unsigned owner", () => {
    const markup = renderToStaticMarkup(<AgentModelSelector owner="" disabled={false} onChange={() => {}} onBusy={() => {}} refresh={async () => {}}/>);
    expect(markup).toContain('aria-label="Inference model"'); expect(markup).toContain("disabled");
    expect(markup).toContain("Configured default"); expect(markup).not.toContain("glm"); expect(markup).not.toContain("private inference");
  });
  it("renders an explicit disabled option for empty provider catalogs", () => {
    const markup = renderToStaticMarkup(<AgentModelOptions catalog={{ defaultModelId: "", selectedModelId: "", catalogAvailable: false, models: [] }} selected="" loading={false}/>);
    expect(markup).toContain("No models available");
    expect(markup).toContain("disabled");
    expect(markup).not.toContain("Configured default");
  });
});
