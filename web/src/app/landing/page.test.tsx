import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import LandingPage, { metadata } from "./landing-page";
import { HERO_MEDIA, canPlayHero, MarketMotion, MotionVideo } from "./landing-interactions";

describe("Orcus landing page", () => {
  it("explains shared control without overstating readiness or privacy", () => {
    const markup = renderToStaticMarkup(<LandingPage/>);
    for (const text of ["same supported trading accounts", "separate trading portfolio", "operating wallet and agent keys are separate", "Scoped permissions", "Spending limits", "Manual takeover", "testnet prototype", "Hyperliquid testnet", "Arbitrum Sepolia", "no sponsorship", "disabled by default", "does not claim independently verified strict TEE guarantees", "does not claim a live decentralized CRE deployment"]) expect(markup).toContain(text);
    expect(markup).not.toMatch(/1000\+|\$25M|150k|SendAI|suzi\.trade|backed by/);
  });

  it("uses a concise original composition rather than the reference's section sequence", () => {
    const markup = renderToStaticMarkup(<LandingPage/>);
    expect(markup.match(/<h1\b/g)).toHaveLength(1);
    expect(markup).toContain("with a second mind.");
    expect(markup).not.toMatch(/You bring.*conviction|Investment Banker|Wall Street|Hedge Fund/);
    expect(markup.indexOf('<h1')).toBeLessThan(markup.indexOf('<video'));
    expect(markup.indexOf('id="about"')).toBeLessThan(markup.indexOf('id="agent"'));
    expect(markup.indexOf('id="agent"')).toBeLessThan(markup.indexOf('id="markets"'));
    const marketing = markup.slice(0, markup.indexOf('<footer'));
    for (const paragraph of marketing.matchAll(/<p\b[^>]*>(.*?)<\/p>/g)) {
      expect(paragraph[1].replace(/<[^>]+>/g, "").length).toBeLessThan(100);
    }
  });

  it("connects the agent to its real tools and user authorization", () => {
    const markup = renderToStaticMarkup(<LandingPage/>);
    for (const text of ["Orcus agent connections", "You set the boundaries.", "0G Compute", "0G Storage backup optional", "Chainlink CRE", "Local workflow checks", "Uniswap", "Hyperliquid", "Ostium", "You authorize the actions."]) expect(markup).toContain(text);
    expect(markup).toContain("SHARED<br/>POSITIONS");
    expect(markup).toContain("Manual trading + authorized agent control");
  });

  it("keeps all navigation local and section targets unique", () => {
    const markup = renderToStaticMarkup(<LandingPage/>);
    const links = [...markup.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1]);
    expect(links.filter(link => link === "/overview").length).toBeGreaterThan(3);
    for (const link of links) {
      expect(link === "/overview" || link.startsWith("#")).toBe(true);
      if (link.startsWith("#")) expect(markup).toContain(`id="${link.slice(1)}"`);
    }
    const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps detailed scope collapsed and navigation keyboard accessible", () => {
    const markup = renderToStaticMarkup(<LandingPage/>);
    expect(markup.match(/<details(?:\s|>)/g)).toHaveLength(6);
    expect(markup.match(/<summary>/g)).toHaveLength(6);
    expect(markup).not.toMatch(/<details[^>]*\sopen/);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="landing-navigation"');
    expect(markup).toContain('aria-label="Main navigation" hidden=""');
    expect(markup).toContain("Skip to product details");
  });

  it("uses local existing assets, with no copied decorative artwork", () => {
    const markup = renderToStaticMarkup(<LandingPage/>);
    const css = readFileSync(new URL("./landing.module.css", import.meta.url), "utf8");
    expect(markup + css).not.toMatch(/laurel\.svg|paper-grain\.png|floral-desktop|floral-mobile|cutting-mat/);
    for (const match of markup.matchAll(/(?:src|poster)="([^"]+)"/g)) {
      expect(match[1]).toMatch(/^\/(landing|workspace)\//);
      expect(statSync(new URL(`../../../public${match[1]}`, import.meta.url)).size).toBeGreaterThan(0);
    }
    for (const name of ["uniswap", "hyperliquid", "chainlink", "0g"]) expect(markup).toContain(`src="/landing/brands/${name}.svg"`);
    expect(markup).toContain('src="/workspace/ostium.png"');
  });

  it("labels illustrations without inventing prices or trading actions", () => {
    const markup = renderToStaticMarkup(<LandingPage/>);
    expect(markup).toContain("Illustrative interface");
    expect(markup).toContain("Illustrative asset examples. Availability varies by venue.");
    expect(markup).toContain("Illustrative market chart, not live prices");
    expect(markup).not.toMatch(/<input|<textarea|<iframe|<script|Connect Wallet|Approve USDC|Mark Price|Funding Rate|APY|24H Fees/);
  });

  it("preserves the local garden with a poster-only initial render", () => {
    expect(HERO_MEDIA).toEqual({ webm: "/landing/garden-hero-v2.webm", mp4: "/landing/garden-hero-v2.mp4", poster: "/landing/garden-hero-v2-poster.webp" });
    for (const path of Object.values(HERO_MEDIA)) expect(statSync(new URL(`../../../public${path}`, import.meta.url)).size).toBeGreaterThan(0);
    const markup = renderToStaticMarkup(<MotionVideo/>);
    expect(markup).toContain('hidden=""');
    expect(markup).toContain('preload="none"');
    expect(markup).toContain(`poster="${HERO_MEDIA.poster}"`);
    expect(markup).not.toMatch(/<source|autoPlay=|autoplay=/);
  });

  it("honors every video playback guard", () => {
    const active = { allowed: true, visible: true, pageVisible: true, userPaused: false };
    expect(canPlayHero(active)).toBe(true);
    for (const blocked of [{ allowed: false }, { visible: false }, { pageVisible: false }, { userPaused: true }]) expect(canPlayHero({ ...active, ...blocked })).toBe(false);
    const source = readFileSync(new URL("./landing-interactions.tsx", import.meta.url), "utf8");
    expect(source).toContain('"visibilitychange"');
    expect(source).toContain("IntersectionObserver");
    expect(source).not.toMatch(/currentTime\s*=/);
  });

  it("keeps marquee motion optional and asset examples labeled", () => {
    const markup = renderToStaticMarkup(<MarketMotion><span>Example</span></MarketMotion>);
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("Pause");
    const css = readFileSync(new URL("./landing.module.css", import.meta.url), "utf8");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("animation-play-state: paused");
    const page = renderToStaticMarkup(<LandingPage/>);
    for (const symbol of ["ETH", "USDC", "BTC", "SOL", "XRP", "DOGE", "AVAX", "LINK", "BNB", "ADA", "DOT"]) expect(page).toContain(`src="/landing/tokens/${symbol}.svg"`);
  });

  it("sets Orcus-specific metadata and preserves testnet indexing policy", () => {
    expect(metadata.title).toBe("Orcus | Your personal trading agent");
    expect(metadata.description).toContain("testnet prototype");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.openGraph).toMatchObject({ title: metadata.title, type: "website" });
  });
});
