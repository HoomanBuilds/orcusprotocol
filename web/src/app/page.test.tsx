import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import HomePage, { metadata } from "./page";
import LandingPage from "./landing/landing-page";
import LegacyLandingPage from "./landing/page";

const redirect = vi.hoisted(() => vi.fn(() => { throw new Error("redirect"); }));
vi.mock("next/navigation", () => ({ permanentRedirect: redirect }));

describe("public home routing", () => {
  it("renders the landing page at the root without the workspace shell", () => {
    expect(HomePage).toBe(LandingPage);
    const markup = renderToStaticMarkup(<HomePage/>);
    expect(markup).toContain("with a second mind.");
    expect(markup).toContain('href="/overview"');
    expect(markup).not.toContain('class="workspace-sidebar"');
    expect(metadata.title).toBe("Orcus | Your personal trading agent");
  });

  it("redirects the old landing path to the root", () => {
    expect(() => LegacyLandingPage()).toThrow("redirect");
    expect(redirect).toHaveBeenCalledWith("/");
  });
});
