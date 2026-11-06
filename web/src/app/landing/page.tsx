import type { Metadata, Viewport } from "next";
import { ArrowUpRight, Plus } from "lucide-react";
import { LandingHeader, MarketMotion, MotionVideo } from "./landing-interactions";
import styles from "./landing.module.css";

export const metadata: Metadata = {
  title: "Orcus | Your personal trading agent",
  description: "Your markets, with a second mind. Trade yourself or work with your personal agent in the Orcus testnet prototype.",
  openGraph: { title: "Orcus | Your personal trading agent", description: "Trade yourself. Delegate when you want. Stay in control.", type: "website" },
  twitter: { card: "summary", title: "Orcus | Your personal trading agent" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#f1eee7" };

function Brand() {
  return <span className={styles.brand}>orcus<span>.</span></span>;
}

function OpenApp({ children = "Enter Orcus" }: { children?: React.ReactNode }) {
  return <a className={styles.appButton} href="/">{children}<ArrowUpRight size={17} aria-hidden="true"/></a>;
}

type Protocol = "0g" | "uniswap" | "hyperliquid" | "chainlink" | "ostium";
function ProtocolMark({ name }: { name: Protocol }) {
  const labels = { "0g": "0G", uniswap: "Uniswap", hyperliquid: "Hyperliquid", chainlink: "Chainlink", ostium: "Ostium" };
  return <img src={name === "ostium" ? "/workspace/ostium.png" : `/landing/brands/${name}.svg`} alt={labels[name]} width="36" height="36" loading="lazy"/>;
}

function Chart() {
  return <div className={styles.chart} role="img" aria-label="Illustrative market chart, not live prices">
    <svg viewBox="0 0 600 180" preserveAspectRatio="none" aria-hidden="true"><path d="M0 140L20 133L40 146L60 115L80 126L100 119L120 82L140 97L160 90L180 112L200 87L220 94L240 67L260 79L280 62L300 89L320 74L340 85L360 48L380 60L400 40L420 59L440 44L460 52L480 26L500 39L520 30L540 45L560 21L580 32L600 15" fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg>
  </div>;
}

function SharedAccount() {
  return <div className={styles.sharedAccount}>
    <div className={styles.accountTop}><Brand/><span className={styles.demoLabel}>Illustrative interface</span><span className={styles.accountTag}>One trading account</span></div>
    <div className={styles.accountBody}>
      <div className={styles.ownerSide}><span className={styles.smallLabel}>YOU</span><h3>Make the move.</h3><div className={styles.orderPreview}><div><img src="/landing/tokens/WETH.png" alt="WETH" width="28" height="28"/><span>WETH / USDC</span><img src="/landing/tokens/USDC.svg" alt="USDC" width="22" height="22"/></div><Chart/><span className={styles.orderHint}>Choose. Review. Trade.</span></div></div>
      <div className={styles.sharedRail}><span/><span>SHARED<br/>POSITIONS</span><span/></div>
      <div className={styles.agentSide}><span className={styles.smallLabel}>YOUR AGENT</span><h3>Hand over the follow-through.</h3><div className={styles.chatBubble}>Help manage my ETH position.<br/>Keep it within my limits.</div><div className={styles.agentPlan}><span className={styles.planDot}/><span>Review the plan</span><span>01</span></div><div className={styles.agentPlan}><span className={styles.planDot}/><span>Authorize the scope</span><span>02</span></div></div>
    </div>
    <div className={styles.accountBottom}><span>Manual trading + authorized agent control</span><a href="/">Open your workspace <ArrowUpRight size={15}/></a></div>
  </div>;
}

function AgentMap() {
  return <div className={styles.mapFrame} aria-label="Orcus agent connections">
    <div className={styles.agentMap}>
      <svg className={styles.mapLines} viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true">
        <path d="M500 130V250M280 170H340Q370 170 370 200V280H410M720 170H660Q630 170 630 200V280H590M280 460H300Q330 460 330 430V320H410M720 460H700Q670 460 670 430V320H590M500 350V450"/>
        {[[500,130],[500,250],[280,170],[410,280],[720,170],[590,280],[280,460],[410,320],[720,460],[590,320],[500,350],[500,450]].map(([cx,cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="4"/>)}
      </svg>
      <article className={`${styles.mapCard} ${styles.mapOwner}`}><span className={styles.smallLabel}>THE DIRECTION</span><strong>You set the boundaries.</strong><div className={styles.permissionChips}><span>Scope</span><span>Budget</span><span>Pause</span></div></article>
      <article className={`${styles.mapCard} ${styles.mapCompute}`}><span className={styles.smallLabel}>REASONING</span><div className={styles.mapBrand}><ProtocolMark name="0g"/><strong>0G Compute</strong></div><p>Research &amp; planning</p></article>
      <article className={`${styles.mapCard} ${styles.mapContext}`}><span className={styles.smallLabel}>PERSPECTIVE</span><div className={styles.contextAssets}>{["ETH", "BTC", "SOL"].map(token => <img key={token} src={`/landing/tokens/${token}.svg`} alt={token} width="32" height="32" loading="lazy"/>)}</div><p>Markets, balances &amp; positions</p></article>
      <div className={styles.mapCentre}><Brand/><span>Your personal agent</span></div>
      <article className={`${styles.mapCard} ${styles.mapMemory}`}><span className={styles.smallLabel}>CONTEXT</span><strong>Memory that stays.</strong><p>Encrypted local memory</p><small>0G Storage backup optional</small></article>
      <article className={`${styles.mapCard} ${styles.mapRules}`}><span className={styles.smallLabel}>CONDITIONS</span><div className={styles.mapBrand}><ProtocolMark name="chainlink"/><strong>Chainlink CRE</strong></div><p>Local workflow checks</p></article>
      <article className={`${styles.mapCard} ${styles.mapVenues}`}><span className={styles.smallLabel}>EXECUTION</span><div className={styles.mapVenueMarks}>{(["uniswap", "hyperliquid", "ostium"] as const).map(name => <span key={name}><ProtocolMark name={name}/><small>{name === "uniswap" ? "Uniswap" : name === "hyperliquid" ? "Hyperliquid" : "Ostium"}</small></span>)}</div></article>
    </div>
    <div className={styles.mapCaption}><span>One agent. Connected tools.</span><span>You authorize the actions.</span></div>
  </div>;
}

const assets = ["ETH", "BTC", "SOL", "USDC", "LINK", "AVAX", "XRP", "DOGE", "BNB", "ADA", "DOT"];
function AssetMarquee() {
  return <MarketMotion>{[0, 1].map(row => <div className={`${styles.marketRow} ${row === 1 ? styles.reverseRow : ""}`} key={row}><div className={styles.marketTrack}>{[0, 1].map(copy => <div className={styles.marketGroup} key={copy} aria-hidden={copy === 1 ? true : undefined}>{assets.map((_, index) => {
    const asset = assets[(index + row * 4) % assets.length];
    return <div className={styles.marketCard} key={asset}><div className={styles.marketName}><img src={`/landing/tokens/${asset}.svg`} alt="" width="32" height="32" loading="lazy"/><strong>{asset}</strong><span className={styles.cardDot}/></div><div className={styles.marketCardBottom}><span>Asset example</span><span>{asset === "USDC" ? "Stablecoin" : "Crypto"}</span></div></div>;
  })}</div>)}</div></div>)}</MarketMotion>;
}

const questions = [
  ["Can I trade myself?", "Yes. Manual actions and authorized agent actions use the same supported trading accounts, not a separate trading portfolio. Collateral and positions remain venue-specific."],
  ["Does the agent get my private key?", "No. The agent's operating wallet and agent keys are separate from your owner key. Connecting is not authorization. You grant and can revoke permissions per venue. Scoped permissions and spending-limit enforcement vary by venue."],
  ["What can I try today?", "This is a testnet prototype: Uniswap on Ethereum Sepolia, Hyperliquid testnet and Ostium on Arbitrum Sepolia. Availability depends on funding and authorization. Ostium offers price exposure, not ownership of shares or commodities. Gas is user-funded; there is no sponsorship."],
  ["How do compute and memory work?", "0G Compute powers planning and analysis. Compute credits are separate from trading funds. Memory is encrypted locally; optional 0G Storage backups are disabled by default. Onchain trades remain public. Orcus does not claim independently verified strict TEE guarantees."],
  ["How do strategies run?", "Strategies require your authorization, available balances and valid venue conditions. Chainlink CRE supplies local conditional workflow checks. Orcus does not claim a live decentralized CRE deployment or guaranteed trading returns."],
];

export default function LandingPage() {
  return <main className={styles.landing} id="top">
    <a className={styles.skipLink} href="#about">Skip to product details</a>
    <LandingHeader><Brand/></LandingHeader>
    <section className={styles.heroSection} aria-labelledby="hero-title">
      <div className={styles.heroHeading}><h1 id="hero-title">Your markets,<br/><em>with a second mind.</em></h1><div className={styles.heroAction}><span>Trade yourself. Delegate when you want.</span><OpenApp/></div></div>
      <div className={styles.heroScene}><MotionVideo/><div className={styles.heroShade}/><div className={styles.sceneNote}><span className={styles.sceneDot}/><span>A little more perspective.</span></div><a className={styles.testnetBadge} href="#scope">Testnet preview</a></div>
      <div className={styles.heroCaption}><span>YOUR WORKSPACE. YOUR AGENT. YOUR CALL.</span><a href="#about">Meet Orcus <Plus size={14}/></a></div>
    </section>

    <section className={styles.productSection} id="about">
      <div className={styles.sectionHeading}><h2>Two ways to trade.<br/><em>One place to stay in control.</em></h2></div>
      <SharedAccount/>
      <div className={styles.featureGrid}>
        <article className={styles.researchCard}><div className={styles.cardHeading}><span>01 / RESEARCH</span><h3>Find your angle.</h3></div><div className={styles.researchVisual}><div className={styles.researchRings}/><img src="/landing/tokens/ETH.svg" alt="ETH" width="44" height="44"/><div className={styles.questionSlip}>What matters for ETH today?</div></div></article>
        <article className={styles.strategyCard}><div className={styles.cardHeading}><span>02 / STRATEGIES</span><h3>Give your idea a plan.</h3></div><div className={styles.strategyVisual}><span>When conditions match</span><i/><span>Check my limits</span><i/><span>Take the authorized action</span></div></article>
        <article className={styles.activityCard}><div className={styles.cardHeading}><span>03 / CONTINUITY</span><h3>Pick up where you left off.</h3></div><div className={styles.activityVisual}><div><span/><p>Research<small>Saved to revisit</small></p></div><div><span/><p>Strategy draft<small>Ready for review</small></p></div><div><span/><p>Your next move<small>Always your call</small></p></div></div></article>
      </div>
      <p className={styles.illustrationNote}>Illustrative interface</p>
    </section>

    <section className={styles.mapSection} id="agent"><div className={styles.sectionHeading}><span className={styles.eyebrow}>INSIDE ORCUS</span><h2>Connected by design.<br/><em>Directed by you.</em></h2></div><AgentMap/></section>

    <section className={styles.marketsSection} id="markets"><div className={styles.marketHeading}><h2>Keep your horizons <em>open.</em></h2><span>Spot. Perpetuals. Global markets.</span></div><div className={styles.venueStrip}>{(["uniswap", "hyperliquid", "ostium"] as const).map((name, index) => <div key={name}><ProtocolMark name={name}/><span>{["Uniswap", "Hyperliquid", "Ostium"][index]}<small>{["Sepolia spot", "Testnet perpetuals", "Arbitrum Sepolia"][index]}</small></span></div>)}</div><AssetMarquee/><p className={styles.marketDisclaimer}>Illustrative asset examples. Availability varies by venue.</p></section>

    <section className={styles.controlSection} id="control"><div><span className={styles.eyebrow}>ALWAYS YOUR CALL</span><h2>Delegate.<br/><em>Without letting go.</em></h2><OpenApp>Find your next move</OpenApp></div><div className={styles.controlRows}>{[["01", "Scoped permissions", "Only the access you grant."], ["02", "Spending limits", "Set your boundaries first."], ["03", "Manual takeover", "Pause. Revoke. Take the controls."]].map(([n, title, copy]) => <div key={n}><span>{n}</span><div><h3>{title}</h3><p>{copy}</p></div><span className={styles.controlPoint}/></div>)}</div></section>

    <footer className={styles.footer}><div className={styles.footerTop}><a href="#top" aria-label="Orcus home"><Brand/></a><span>Your next move starts here.</span><OpenApp>Open workspace</OpenApp></div><details className={styles.footerScope} id="scope"><summary>Before you begin <Plus size={16}/></summary><div className={styles.questions}>{questions.map(([question, answer]) => <details key={question}><summary>{question}<Plus size={16}/></summary><p>{answer}</p></details>)}</div></details><div className={styles.footerBottom}><span>Orcus / 2026</span><span>Testnet prototype. Trading involves risk.</span><a href="#top">Back to top <ArrowUpRight size={14}/></a></div></footer>
  </main>;
}
