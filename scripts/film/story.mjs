export const promise = 'Your trading workspace. Your personal agent. You stay in control.';
export const chapters = [
  {id: 'landing', file: '01-landing.mp4', title: 'Your trading workspace.', accent: 'Your personal agent.', duration: 10,
    narration: 'Meet Orcus. A trading workspace where you can act yourself, or ask your personal agent to help. You stay in control.'},
  {id: 'onboarding', file: '02-onboarding.mp4', title: 'Connect your wallet.', accent: 'Keep control.', duration: 18,
    narration: 'Start by connecting your wallet. Your accounts stay organized by venue. Connecting does not give the agent permission to trade. Agent access requires a separate, explicit authorization, and your private key is never handed to the agent.'},
  {id: 'terminal', file: '03-hyperliquid.mp4', title: 'Trade on your terms.', accent: 'See the whole position.', duration: 22,
    narration: 'Open the terminal to inspect Hyperliquid testnet markets, charts, and the order book. Place your own orders from the trading controls. With the required permissions, your agent can help manage positions in that same venue account. Positions always remain with their original venue.'},
  {id: 'swap', file: '04-uniswap.mp4', title: 'Spot, in the', accent: 'same workspace.', duration: 16,
    narration: 'For spot trading, open Swap. Choose the input and output assets, enter an amount, and review the swap inputs before requesting a quote. This is the Uniswap execution path. Here, we use an unfunded test wallet and do not submit a swap.'},
  {id: 'research', file: '05-research.mp4', title: 'Ask. Investigate.', accent: 'Review the evidence.', duration: 25,
    narration: 'The agent uses zero G inference to work through market questions, inspect available data, and prepare proposals. This is a prerecorded zero G research response, shown with its sources and tool activity. Research is not permission to trade. Review the answer and its limits before deciding what to do.'},
  {id: 'strategy', file: '06-strategy.mp4', title: 'A rule you', accent: 'can inspect.', duration: 22,
    narration: 'Turn an idea into a typed strategy draft. Review the market, price condition, execution mode, and limit before acceptance. Chainlink Runtime Environment provides conditional checks against that typed rule. This recording stops at review. No strategy is activated, and no trades are submitted.'},
  {id: 'control-history', file: '07-control-history.mp4', title: 'Pick up where', accent: 'you left off.', duration: 18,
    narration: 'Return to your workspace to review request status and activity. This request is queued, not completed. Agent controls keep operating limits visible, and let you pause the agent. Manual actions and agent proposals belong in one place, with their actual status clearly separated.'},
];
export const segments = [
  ...chapters.flatMap((chapter, index) => [
    {id: `chapter-${index + 1}`, type: 'card', chapter: index + 1, title: chapter.title, accent: chapter.accent, duration: 2.8, narration: ''},
    {...chapter, type: 'shot', chapter: index + 1},
  ]),
  {id: 'closing', type: 'card', title: 'Your trading workspace.', accent: 'You stay in control.', duration: 5, narration: 'Orcus. Your trading workspace. Your personal agent. You stay in control.'},
];
export const narrationCharacters = () => segments.reduce((total, segment) => total + [...segment.narration].length, 0);
