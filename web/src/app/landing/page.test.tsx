import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LandingPage, { metadata } from "./page";
import { HERO_MEDIA, canPlayHero, MotionVideo } from "./landing-interactions";
import { readFileSync, statSync } from "node:fs";

describe("Orcus landing page", () => {
  it("explains the actual testnet scope and shared account controls", () => {
    const markup = renderToStaticMarkup(<LandingPage/>);
    for (const text of ["Trading Agent", "Sepolia", "Hyperliquid testnet", "0G Compute", "0G Storage", "Chainlink CRE", "Scoped permissions", "Spending limits", "Manual takeover", "same supported trading accounts", "testnet prototype", "Illustrative interface", "separate trading portfolio", "operating wallet and agent keys are separate", "does not claim independently verified strict TEE guarantees", "does not claim a live decentralized CRE deployment"]) expect(markup).toContain(text);
    expect(markup).not.toMatch(/1000\+|\$25M|150k|SendAI|suzi\.trade|guaranteed returns<\/|backed by/);
  });

  it("keeps app links on the existing terminal and section links resolvable", () => {
    const markup = renderToStaticMarkup(<LandingPage/>);
    const links = [...markup.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1]);
    expect(links.filter(link => link === "/").length).toBeGreaterThan(3);
    for (const link of links.filter(link => link.startsWith("#"))) expect(markup).toContain(`id="${link.slice(1)}"`);
    expect(links.every(link => link === "/" || link.startsWith("#"))).toBe(true);
    const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("provides keyboard-friendly native disclosures and a closed initial menu", () => {
    const markup = renderToStaticMarkup(<LandingPage/>);
    expect(markup.match(/<details(?:\s|>)/g)).toHaveLength(6);
    expect(markup.match(/<summary>/g)).toHaveLength(6);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="landing-navigation"');
    expect(markup).toContain('id="landing-navigation"');
    expect(markup).toContain('aria-label="Main navigation" hidden=""');
    expect(markup).toContain("Skip to product details");
    expect(markup).not.toContain("A little more context");
    expect(markup.indexOf('id="scope"')).toBeGreaterThan(markup.indexOf("<footer"));
  });

  it("starts decorative video without autoplay and uses only local visual assets", () => {
    const markup = renderToStaticMarkup(<LandingPage/>);
    expect(markup).not.toMatch(/autoPlay=|autoplay=|<iframe|<script/);
    expect(markup).toContain('preload="none"');
    expect(markup).toContain('aria-hidden="true"');
    for (const match of markup.matchAll(/(?:src|poster|srcSet)="([^"]+)"/g)) expect(match[1]).toMatch(/^\/landing\//);
    expect(markup).not.toMatch(/<input|<textarea|Connect Wallet|Approve USDC/);
  });

  it("uses the complete local garden loop with poster-only motion opt-out", () => {
    expect(HERO_MEDIA).toEqual({ webm: "/landing/garden-hero-v1.webm", mp4: "/landing/garden-hero-v1.mp4", poster: "/landing/garden-hero-v1-poster.webp" });
    for (const path of Object.values(HERO_MEDIA)) expect(statSync(new URL(`../../../public${path}`, import.meta.url)).size).toBeGreaterThan(0);
    const markup = renderToStaticMarkup(<MotionVideo/>);
    expect(markup).toContain('loop=""');
    expect(markup).toContain('hidden=""');
    expect(markup).toContain(`poster="${HERO_MEDIA.poster}"`);
    expect(markup).not.toContain("<source");
    const source = readFileSync(new URL("./landing-interactions.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/currentTime\s*=|hero-mobile\.webm|src="\/landing\/hero\.webm"/);
    expect(source).toContain('"visibilitychange"');
    expect(source).toContain("IntersectionObserver");
  });

  it("pauses motion for reduced preference, hidden page, offscreen hero and the user control", () => {
    const active = { allowed: true, visible: true, pageVisible: true, userPaused: false };
    expect(canPlayHero(active)).toBe(true);
    for (const blocked of [{ allowed: false }, { visible: false }, { pageVisible: false }, { userPaused: true }]) expect(canPlayHero({ ...active, ...blocked })).toBe(false);
  });

  it("sets Orcus-specific preview metadata without inventing a public domain", () => {
    expect(metadata.title).toBe("Orcus | Your personal trading agent");
    expect(metadata.description).toContain("testnet prototype");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.openGraph).toMatchObject({ title: metadata.title, type: "website" });
  });

  it("uses local official protocol marks and a distinct Ethereum asset mark", () => {
    const markup = renderToStaticMarkup(<LandingPage/>);
    for (const name of ["uniswap", "hyperliquid", "chainlink", "0g"]) expect(markup).toContain(`src="/landing/brands/${name}.svg"`);
    expect(markup).toContain('src="/landing/brands/ethereum.png"');
    expect(markup).not.toContain("Ξ");
    expect(markup).not.toMatch(/>H<|>C<|>0G<|>M</);
  });

  it("shows rich asset examples without inventing live prices or support for every token", () => {
    const markup = renderToStaticMarkup(<LandingPage/>);
    for (const symbol of ["ETH", "USDC", "BTC", "SOL", "XRP", "DOGE", "AVAX", "LINK", "BNB", "ADA", "DOT"]) expect(markup).toContain(`src="/landing/tokens/${symbol}.svg"`);
    expect(markup).toContain('src="/landing/tokens/WETH.png"');
    for (const text of ["HYPE-USDC", "illustrative asset examples", "Quote / collateral", "Native ETH input wraps to WETH", "WETH / USDC", "Asset example"]) expect(markup).toContain(text);
    expect(markup).not.toMatch(/Mark Price|Funding Rate|APY|24H Fees|USDC-USDC/);
  });
});
