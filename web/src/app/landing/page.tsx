import type { Metadata, Viewport } from "next";
import { useId } from "react";
import {
  ArrowUp, ArrowUpRight, Check, CirclePause, Cpu, Fingerprint,
  Globe2, LockKeyhole, MousePointer2, Pause,
  Plus, ShieldCheck, SlidersHorizontal, Wallet,
} from "lucide-react";
import { LandingHeader, MotionVideo, MarketMotion } from "./landing-interactions";
import styles from "./landing.module.css";

export const metadata: Metadata = {
  title: "Orcus | Your personal trading agent",
  description: "Your decisions. Your personal agent. The same trading accounts. Explore the Orcus testnet prototype, powered by 0G, Uniswap, Hyperliquid and Chainlink CRE.",
  openGraph: {
    title: "Orcus | Your personal trading agent",
    description: "Trade yourself or give your agent a plan. Stay in control of the same accounts.",
    type: "website",
  },
  twitter: { card: "summary", title: "Orcus | Your personal trading agent", description: "Your decisions. Your agent. Your accounts. A testnet prototype." },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#e9e6df" };

function Brand({ footer = false }: { footer?: boolean }) {
  return <span className={footer ? styles.footerBrand : styles.brand}>orcus<span className={styles.brandDot}>.</span></span>;
}

type ProtocolName = "uniswap" | "hyperliquid" | "chainlink" | "0g" | "ethereum";

function ProtocolLogo({ name }: { name: ProtocolName }) {
  const labels = { uniswap: "Uniswap", hyperliquid: "Hyperliquid", chainlink: "Chainlink", "0g": "0G", ethereum: "Ethereum" };
  return <img className={styles.protocolLogo} src={`/landing/brands/${name}.${name === "ethereum" ? "png" : "svg"}`} alt={labels[name]} width="48" height="48" loading="lazy" decoding="async"/>;
}

type AssetSymbol = "ETH" | "WETH" | "USDC" | "BTC" | "SOL" | "XRP" | "DOGE" | "AVAX" | "LINK" | "HYPE" | "BNB" | "ADA" | "DOT";

function AssetLogo({ symbol }: { symbol: AssetSymbol }) {
  if (symbol === "HYPE") return <ProtocolLogo name="hyperliquid"/>;
  return <img className={styles.assetLogo} src={`/landing/tokens/${symbol}.${symbol === "WETH" ? "png" : "svg"}`} alt={symbol} width="32" height="32" loading="lazy" decoding="async"/>;
}

function SpotPairLogo() {
  return <span className={styles.assetPair}><span className={styles.ethToken}><AssetLogo symbol="WETH"/></span><span className={styles.quoteToken}><AssetLogo symbol="USDC"/></span></span>;
}

function EnterButton({ secondary = false }: { secondary?: boolean }) {
  return <a className={secondary ? styles.glassButton : styles.enterButton} href="/">{secondary ? "Explore the terminal" : "Enter Orcus"}</a>;
}

function Laurel({ flip = false }: { flip?: boolean }) {
  return <img className={flip ? styles.laurelFlipped : styles.laurel} width="15" height="33" src="/landing/laurel.svg" alt="" aria-hidden="true"/>;
}

function SectionHeading({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className={styles.sectionHeading}><h2>{title}</h2><p>{children}</p></div>;
}

function DemoLabel() {
  return <span className={styles.demoLabel}>Illustrative interface</span>;
}

function ResearchDemo() {
  return <div className={`${styles.demo} ${styles.researchDemo}`}>
    <DemoLabel />
    <div className={styles.researchContext}><span className={styles.miniMark}>o.</span><span>A little context.<br/><strong>A clearer next move.</strong></span></div>
    <div className={styles.promptCard}><p>Help me plan an ETH spot trade<br/>with a clear spending limit</p><div><Plus size={24}/><span className={styles.promptSend}><ArrowUp size={24}/></span></div></div>
    <div className={styles.answerHint}><span>0G planning. Encrypted memory backups.</span></div>
  </div>;
}

function MiniChart({ large = false }: { large?: boolean }) {
  const gradientId = useId();
  return <div className={large ? styles.largeChart : styles.miniChart} aria-label="Illustrative price chart, not live market data" role="img">
    <div className={styles.chartGrid}/>
    <svg viewBox="0 0 500 180" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#c2ed8c" stopOpacity=".22"/><stop offset="1" stopColor="#c2ed8c" stopOpacity="0"/></linearGradient></defs><path d="M0 156 18 150 30 155 48 125 62 131 77 113 92 118 109 92 125 101 139 84 152 97 169 78 185 86 200 54 216 65 235 56 251 71 269 54 283 62 299 41 313 57 329 47 345 60 362 32 380 39 396 28 410 41 429 21 447 32 465 16 484 26 500 12V180H0Z" fill={`url(#${gradientId})`}/><path d="M0 156 18 150 30 155 48 125 62 131 77 113 92 118 109 92 125 101 139 84 152 97 169 78 185 86 200 54 216 65 235 56 251 71 269 54 283 62 299 41 313 57 329 47 345 60 362 32 380 39 396 28 410 41 429 21 447 32 465 16 484 26 500 12" fill="none" stroke="#c2ed8c" strokeWidth="2"/></svg>
  </div>;
}

function TradingDemo() {
  return <div className={`${styles.demo} ${styles.tradingDemo}`}>
    <DemoLabel/>
    <div className={styles.floatingTicket}><div className={styles.ticketTop}><SpotPairLogo/><span>WETH / USDC<small>Uniswap · Sepolia</small></span><span className={styles.testnetPill}>TESTNET</span></div><MiniChart/><div className={styles.tradeModes}><span>Manual trading</span><span>Agent control</span></div><div className={styles.ticketFooter}><Wallet size={15}/><span>Native ETH input wraps to WETH</span><Check size={15}/></div></div>
  </div>;
}

function StrategyDemo() {
  return <div className={`${styles.demo} ${styles.strategyDemo}`}>
    <DemoLabel/>
    <div className={styles.strategyPrompt}>Watch the market.<br/>Only act within my rules.</div>
    <div className={styles.ruleCard}><div><span className={styles.ruleIcon}><SlidersHorizontal size={18}/></span><span>Your strategy, your limits</span><span className={styles.statusDot}/></div><dl><div><dt>Venue</dt><dd>Hyperliquid testnet</dd></div><div><dt>Permission</dt><dd>Scoped by you</dd></div><div><dt>Budget</dt><dd>Required before activation</dd></div></dl><div className={styles.ruleStatus}><CirclePause size={15}/><span>Pause or take over at any time</span></div></div>
  </div>;
}

const features = [
  { first: "turn your ideas into", second: "a trading plan", Demo: ResearchDemo },
  { first: "trade your way with", second: "one workspace", Demo: TradingDemo },
  { first: "give your agent rules,", second: "not free rein", Demo: StrategyDemo },
];

const marketCards: { asset: AssetSymbol; brand?: "uniswap" | "hyperliquid"; name: string; value: string; status: string }[] = [
  { asset: "ETH", brand: "uniswap", name: "ETH input", value: "Sepolia", status: "Wrap + swap" },
  { asset: "WETH", brand: "uniswap", name: "WETH-USDC", value: "Sepolia", status: "Spot pair" },
  { asset: "USDC", name: "USDC", value: "Testnet quote", status: "Quote / collateral" },
  { asset: "BTC", brand: "hyperliquid", name: "BTC-USDC", value: "Hyperliquid", status: "Testnet perp example" },
  { asset: "SOL", brand: "hyperliquid", name: "SOL-USDC", value: "Hyperliquid", status: "Testnet perp example" },
  { asset: "XRP", name: "XRP", value: "Illustrative", status: "Asset example" },
  { asset: "DOGE", brand: "hyperliquid", name: "DOGE-USDC", value: "Hyperliquid", status: "Testnet perp example" },
  { asset: "AVAX", brand: "hyperliquid", name: "AVAX-USDC", value: "Hyperliquid", status: "Testnet perp example" },
  { asset: "LINK", name: "LINK", value: "Illustrative", status: "Asset example" },
  { asset: "HYPE", brand: "hyperliquid", name: "HYPE-USDC", value: "Hyperliquid", status: "Testnet perp example" },
  { asset: "BNB", brand: "hyperliquid", name: "BNB-USDC", value: "Hyperliquid", status: "Testnet perp example" },
  { asset: "ADA", brand: "hyperliquid", name: "ADA-USDC", value: "Hyperliquid", status: "Testnet perp example" },
  { asset: "DOT", name: "DOT", value: "Illustrative", status: "Asset example" },
];

function MarketCard({ card }: { card: typeof marketCards[number] }) {
  return <div className={styles.marketCard}><div className={styles.marketName}><span className={styles.marketTokenPair}><span className={`${styles.token} ${card.asset === "HYPE" ? styles.hyperliquidToken : ""}`}><AssetLogo symbol={card.asset}/></span>{card.brand && <span className={`${styles.venueBadge} ${card.brand === "hyperliquid" ? styles.hyperliquidToken : styles.protocolToken}`}><ProtocolLogo name={card.brand}/></span>}</span><h3>{card.name}</h3></div><dl><div><dt>Context</dt><dd>{card.value}</dd></div><div><dt>Market</dt><dd>{card.status}</dd></div></dl></div>;
}

function MarketRows() {
  return <MarketMotion>{[0, 1, 2].map(row => <div className={`${styles.marketRow} ${row === 1 ? styles.reverseRow : ""}`} key={row}><div className={styles.marketTrack}>{[0, 1].map(copy => <div className={styles.marketGroup} key={copy} aria-hidden={copy === 1 ? true : undefined}>{marketCards.map((_, index) => <MarketCard card={marketCards[(index + row * 4) % marketCards.length]} key={index}/>)}</div>)}</div></div>)}</MarketMotion>;
}

function Infrastructure() {
  return <div className={styles.infrastructure}>
    <svg className={styles.connectors} viewBox="0 0 944 669" fill="none" preserveAspectRatio="none" aria-hidden="true"><path d="M324 90H595M780 147V286H595M396 349V378H208V424M496 349V378H783V420M415 477H623M783 506V556H727V588M208 530V556H250V583M434 626H566" stroke="#ff9bd3" strokeWidth="2" strokeDasharray="3 5"/>{[[324,90],[595,90],[780,147],[595,286],[396,349],[208,424],[496,349],[783,420],[415,477],[623,477],[783,506],[727,588],[208,530],[250,583],[434,626],[566,626]].map(([cx,cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="5" stroke="#ff4da9" strokeWidth="1.5" fill="#ffd5ed"/>)}</svg>
    <div className={`${styles.infraNode} ${styles.inferenceNode}`}><span className={styles.nodeLabel}>Ideas &amp; reasoning</span><div className={styles.modelIcons}><span className={styles.zeroG}><ProtocolLogo name="0g"/></span><span className={styles.ideaIcon}><Cpu size={30}/></span></div><p>Inference through 0G Compute</p></div>
    <div className={`${styles.infraNode} ${styles.contextNode}`}><span className={`${styles.nodeLabel} ${styles.greenLabel}`}>Market context</span><div className={styles.contextIcons}><span><ProtocolLogo name="ethereum"/></span><span className={styles.hyperliquidToken}><ProtocolLogo name="hyperliquid"/></span><span><ProtocolLogo name="chainlink"/></span></div><p>Venue data, balances &amp; positions</p></div>
    <div className={`${styles.infraNode} ${styles.protocolNode}`}><span className={`${styles.nodeLabel} ${styles.oliveLabel}`}>Trading venues</span><div className={styles.protocolNames}><span><span className={styles.protocolCoin}><ProtocolLogo name="uniswap"/></span>Uniswap<small>Sepolia spot</small></span><span><span className={`${styles.protocolCoin} ${styles.hyperliquidToken}`}><ProtocolLogo name="hyperliquid"/></span>Hyperliquid<small>Testnet perps</small></span></div></div>
    <div className={`${styles.infraNode} ${styles.controlNode}`}><span className={`${styles.nodeLabel} ${styles.pinkLabel}`}>Orcus control layer</span><div className={styles.controlIcons}><ShieldCheck size={35}/><div><strong>Permission before execution.</strong><p>Scoped actions. Spending limits.<br/>Pause and manual takeover.</p></div></div></div>
    <div className={`${styles.infraNode} ${styles.memoryNode}`}><span className={`${styles.nodeLabel} ${styles.oliveLabel}`}>Encrypted memory</span><div className={styles.memoryGraphic}><span className={styles.memoryBrand}><ProtocolLogo name="0g"/></span><span><strong>0G Storage</strong><small>Your agent&apos;s saved context</small></span><LockKeyhole size={18}/></div></div>
    <div className={`${styles.infraNode} ${styles.walletNode}`}><span className={styles.nodeLabel}>Trading accounts</span><div className={styles.walletGraphic}><Wallet size={42}/><Fingerprint size={36}/><span>You + your agent<br/><small>The same accounts</small></span></div></div>
    <div className={`${styles.infraNode} ${styles.rulesNode}`}><span className={styles.nodeLabel}>Conditional evaluation</span><div className={styles.rulesGraphic}><span className={styles.rulesBrand}><ProtocolLogo name="chainlink"/></span><span>Chainlink CRE<small>Local workflow runner</small></span><span className={styles.nodeCheck}><Check size={19}/></span></div></div>
  </div>;
}

function TerminalPreview({ phone = false }: { phone?: boolean }) {
  return <div className={phone ? styles.phoneScreen : styles.terminalScreen}>
    <div className={styles.terminalHeader}><span className={styles.terminalLogo}>orcus.</span><span className={styles.terminalNav}>Trade &nbsp; Agent &nbsp; Automations</span><span className={styles.terminalNetwork}>Testnet</span></div>
    <div className={styles.terminalBody}><div className={styles.terminalMain}><div className={styles.terminalPair}><SpotPairLogo/><span>WETH / USDC<small>Uniswap · Ethereum Sepolia</small></span><span className={styles.previewBadge}>PREVIEW</span></div><MiniChart large/><div className={styles.positionsTabs}><span>Positions</span><span>Orders</span><span>Activity</span></div><div className={styles.emptyPositions}>Your trading activity, in one place.</div></div><div className={styles.terminalSidebar}><span className={styles.sidebarLabel}>PERSONAL AGENT</span><div className={styles.agentGreeting}><span className={styles.miniMark}>o.</span><strong>Your plan.<br/>Your next move.</strong></div><p>Set the direction. Your agent works within the limits you authorize.</p><div className={styles.previewControl}><ShieldCheck size={14}/> Permission scoped</div><div className={styles.previewControl}><Pause size={14}/> Manual takeover</div><div className={styles.previewInput}>Ask your trading agent <ArrowUp size={15}/></div></div></div>
    <span className={styles.screenIllustration}>Illustrative interface. No live prices or positions.</span>
  </div>;
}

const questions = [
  { question: "Is Orcus live on mainnet?", answer: "No. Orcus is a testnet prototype. Spot trading uses Uniswap on Ethereum Sepolia, and perpetual trading uses Hyperliquid testnet. Do not treat this prototype as a production trading service." },
  { question: "Does my agent need a separate trading portfolio?", answer: "No. Manual actions and authorized agent actions use the same supported trading accounts. The agent's operating wallet and agent keys are separate from your owner wallet and trading principal. You choose the permissions, set spending limits, and can pause the agent or take manual control." },
  { question: "What does 0G do in Orcus?", answer: "0G Compute provides agent inference, and 0G Storage stores encrypted agent memory. This does not make onchain trades private, and Orcus does not claim independently verified strict TEE guarantees." },
  { question: "How do conditional strategies work?", answer: "Conditional evaluations use a Chainlink CRE local workflow runner. Execution still depends on your authorized scope, configured services, available balances, and venue conditions. Orcus does not claim a live decentralized CRE deployment." },
  { question: "Does the agent guarantee trading returns?", answer: "No. Models can be wrong, strategies can fail, and trading involves risk. There is no Orcus token or promise of guaranteed returns. Review the agent's plan and permissions before authorizing an action." },
];

export default function LandingPage() {
  return <main className={styles.landing} id="top">
    <a className={styles.skipLink} href="#about">Skip to product details</a>
    <section className={styles.heroShell} aria-labelledby="hero-title"><div className={styles.hero}>
      <MotionVideo/>
      <div className={styles.heroShade}/>
      <LandingHeader><Brand/></LandingHeader>
      <div className={styles.heroContent}><div className={styles.heroTitleGroup}><a className={styles.builtBadge} href="#scope"><span className={styles.badgeDot}/>a testnet prototype</a><h1 id="hero-title"><span>your personal</span><em>Trading Agent</em></h1></div><EnterButton/><a href="#control" className={styles.invite}><Laurel/><span>your keys. your control.</span><Laurel flip/></a></div>
    </div></section>

    <section className={styles.featuresSection} id="about" aria-label="How Orcus works"><div className={styles.featureContainer}>
      {features.map(({ first, second, Demo }, index) => <div key={first}><article className={`${styles.featureRow} ${index === 1 ? styles.featureReverse : ""}`}><div className={styles.featureCopy}><span className={styles.featureNumber}>({index + 1})</span><h2><span>{first}</span><em>{second}</em></h2></div><div className={styles.featureFrame}><Demo/></div></article>{index < 2 && <div className={styles.featureSpacer} aria-hidden="true"/>}</div>)}
    </div></section>

    <section className={styles.marketsSection} id="markets"><div className={styles.darkTopGrid}/><SectionHeading title="Two venues. One workspace.">testnet markets &amp; illustrative asset examples</SectionHeading><MarketRows/><div className={styles.darkBottomGrid}/></section>

    <section className={styles.convictionSection} id="agent"><div className={styles.convictionContainer}><SectionHeading title="You bring the conviction">Orcus brings a personal agent, connected tools, and a permission layer for your trading accounts</SectionHeading><div className={styles.infraFrame}><Infrastructure/></div></div></section>

    <section className={styles.controlSection} id="control"><div className={styles.controlContainer}><SectionHeading title="An agent. Not a blank check.">the decisions that matter stay with you</SectionHeading><div className={styles.controlGrid}>{[
      ["Your scope", "Choose what your agent is allowed to do."], ["Your budget", "Set limits before authorizing execution."], ["Your accounts", "Trade manually or with your personal agent."], ["Your call", "Pause the agent. Take back control."],
    ].map(([title, text]) => <article className={styles.controlCard} key={title}><h3>{title}</h3><p>{text}</p></article>)}</div></div></section>

    <section className={styles.workspaceSection} id="workspace"><div className={styles.workspaceHeading}><SectionHeading title="One place for your next move">your terminal, your agent, your trading accounts</SectionHeading></div><div className={styles.workspaceStage}><div className={styles.desktopDevice}><div className={styles.browserBar}><div><i/><i/><i/></div><span><LockKeyhole size={10}/> Orcus trading workspace</span><Plus size={12}/></div><TerminalPreview/></div><div className={styles.phoneDevice}><div className={styles.phoneNotch}/><TerminalPreview phone/></div><div className={styles.takeoverNote}><span className={styles.noteIcon}><MousePointer2 size={21}/></span><div><strong>You&apos;re always in the loop.</strong><span>Review. Authorize. Take over.</span></div><ShieldCheck size={23}/></div></div><div className={styles.workspaceLinks}><a href="/"><Globe2 size={25}/><span>Open in your browser</span><ArrowUpRight size={18}/></a><span><Wallet size={25}/>Same accounts, shared control</span></div></section>

    <section className={styles.strategySection}><div className={styles.strategyPanel}><div className={styles.strategyPanelCopy}><h2>Your strategy.<br/><em>Your boundaries.</em></h2><p>Give your personal agent a direction. Define the permissions and budget. Keep the final say.</p><EnterButton secondary/></div><div className={styles.strategyStack} aria-label="Agent controls">{[
      { label: "Personal agent", Icon: Cpu, color: "pink" }, { label: "Scoped permissions", Icon: ShieldCheck, color: "mint" }, { label: "Spending limits", Icon: SlidersHorizontal, color: "purple" }, { label: "Encrypted memory", Icon: LockKeyhole, color: "blue" }, { label: "Manual takeover", Icon: MousePointer2, color: "olive" },
    ].map(({ label, Icon, color }) => <div className={styles.stackCard} key={label}><span className={`${styles.stackIcon} ${styles[color]}`}><Icon size={27}/></span><span>{label}</span></div>)}</div></div></section>

    <footer className={styles.footer}><picture className={styles.footerFlowers}><source media="(max-width: 767px)" srcSet="/landing/floral-mobile.webp"/><img src="/landing/floral-desktop.webp" alt="" loading="lazy" width="2560" height="600"/></picture><div className={styles.footerContent}><div className={styles.footerMain}><div className={styles.footerIntro}><a href="#top" aria-label="Orcus home"><Brand footer/></a><p>Your decisions. Your personal agent. Your accounts.<br/>A more intentional way to trade.</p><EnterButton/></div><div className={styles.footerNav}><div><h3>Explore</h3><a href="#about">The idea</a><a href="#agent">The agent</a><a href="#control">Your control</a></div><div><h3>Start here</h3><a href="/">Open app <ArrowUpRight size={14}/></a><a href="#scope">Prototype scope</a><a href="#markets">Trading venues</a></div></div></div><details className={styles.footerScope} id="scope"><summary>Prototype scope<Plus size={17}/></summary><div className={styles.questions}>{questions.map(({ question, answer }) => <details key={question}><summary>{question}<Plus size={19}/></summary><p>{answer}</p></details>)}</div></details><div className={styles.footerBottom}><span>Built with 0G, Uniswap, Hyperliquid &amp; Chainlink CRE.</span><div><span>Twenty&apos;26 <b>Orcus</b></span><span>Testnet prototype. Trading involves risk.</span><a href="#top">Back to top <ArrowUp size={13}/></a></div></div></div></footer>
  </main>;
}
