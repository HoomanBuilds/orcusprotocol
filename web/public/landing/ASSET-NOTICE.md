# Landing page assets

The visual reference for this requested local prototype is https://www.suzi.trade/.
Orcus is an independent project and is not affiliated with Suzi or SendAI.

## Reference artwork

Downloaded on November 6, 2026 from the public reference website:

- `hero.webm`: https://www.suzi.trade/videos/hero.webm
- `hero-mobile.webm`: https://www.suzi.trade/videos/hero-mobile.webm
- `hero-poster.webp`: a still extracted at six seconds from `hero.webm` for reduced-motion and initial-load presentation. The reference's video transitions from a city to flowers and loops its floral segment; its city poster does not match that settled state and is not included.
- `paper-grain.png`: https://www.suzi.trade/images/textures/paper-grain.png
- `laurel.svg`: https://www.suzi.trade/images/hero/laurel.svg
- `floral-desktop.webp`: https://www.suzi.trade/images/footer/floral-background-desktop.webp
- `floral-mobile.webp`: https://www.suzi.trade/images/footer/floral-background-mobile.webp
- `cutting-mat.jpg`: https://www.suzi.trade/images/platforms/cutting-mat-background.jpg, downloaded through the reference site's public image optimizer at width 1920 and quality 75.

These decorative assets were reused at the user's request for visual recreation.
Public availability does not establish a redistribution license. Their original
ownership and licensing have not been independently verified. Obtain permission
or replace the artwork before a public release. No reference-site runtime code,
tracking scripts, brand logos, product screenshots, endorsements, or statistics
are included. Product demonstrations are original, explicitly illustrative UI.

## Fonts

The local font files are DM Serif Display regular and italic, and Inter regular,
downloaded from the public reference site's `/_next/static/media/` directory.
Font family names were confirmed from the files. Both families are available
under the SIL Open Font License 1.1. License texts are included in `fonts/` from:

- https://github.com/google/fonts/blob/main/ofl/dmserifdisplay/OFL.txt
- https://github.com/google/fonts/blob/main/ofl/inter/OFL.txt

Interface icons use the project's existing Lucide dependency. The Orcus wordmark,
product diagrams, chart illustrations, and interface previews are original code.

## Official integration marks

The following unmodified marks identify the integrations, not sponsorship,
approval, or affiliation. All are served as local images, preserve their original
colors and aspect ratios, and are not executed or embedded as inline markup.
Downloaded SVGs were checked for scripts, event handlers, foreign objects, and
external resource references; none were found.

- `brands/uniswap.svg`: the pink protocol unicorn from the official [Uniswap brand repository](https://github.com/Uniswap/brand-assets), file [Uniswap_icon_pink.svg](https://raw.githubusercontent.com/Uniswap/brand-assets/main/Uniswap%20Brand%20Assets/Uniswap_icon_pink.svg). The [trademark guidelines](https://support.uniswap.org/hc/en-us/articles/30934762216973-Uniswap-Labs-Trademark-Guidelines) reserve logo use to prior written permission. Inclusion in this local requested prototype does not establish that permission; obtain it before public release.
- `brands/hyperliquid.svg`: `SVG/Hyperliquid_Blob_Green.svg` from the SVG archive linked by the official [Hyperliquid brand kit](https://hyperliquid.gitbook.io/hyperliquid-docs/brand-kit). [Exact source archive](https://2356094849-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FyUdp569E6w18GdfqlGvJ%2Fuploads%2F1d7qVbvxY5oGFQAaaJ3a%2FHyperliquid%20SVG%20format.zip?alt=media&token=b6aef86f-fc26-49f5-af2e-51da21bb1feb). No separate redistribution license was included in the archive; trademark rights are retained by its owner.
- `brands/chainlink.svg`: the blue symbol linked by the official [Chainlink brand assets page](https://chain.link/brand-assets). [Exact SVG](https://cdn.prod.website-files.com/5f6b7190899f41fb70882d08/6aa7fef7f56d1f1d953c589d_Chainlink-Symbol-Blue.svg). Official colors and clearspace are preserved; the brand page's trademark and usage terms apply.
- `brands/0g.svg`: the black logo displayed in the official [0G brand kit](https://0g.ai/brandkit). [Exact SVG](https://0g.ai/assets/681c472ba991e2e4ca164fe6_Black-OG-Logo.svg). Its specified clearspace, proportions, original color, and upright orientation are preserved. No additional redistribution license was found on that page.
- `brands/ethereum.png`: the gray diamond displayed on the official [Ethereum assets page](https://ethereum.org/assets/). [Exact PNG](https://ethereum.org/_next/static/media/eth-diamond-black.31u_5ih2w7osr.png). Used only for the ETH asset, not as a substitute for Uniswap's unicorn. Ethereum's mark and asset usage terms remain applicable.

These marks have not been claimed as Orcus artwork or relicensed under the
repository's code license. Public release requires resolving applicable brand
permissions as well as the decorative artwork licensing described above.

## Cryptocurrency asset examples

`tokens/ETH.svg`, `USDC.svg`, `BTC.svg`, `SOL.svg`, `XRP.svg`, `DOGE.svg`,
`AVAX.svg`, `LINK.svg`, `BNB.svg`, `ADA.svg`, and `DOT.svg` are the original
background variants from [Web3 Icons](https://github.com/0xa3k5/web3icons), whose
published `@web3icons/core` version 4.0.58 identifies upstream commit
`763a55d66a03b21b603eb249f2df7c64a7522089`. The exact source pattern is
`https://raw.githubusercontent.com/0xa3k5/web3icons/763a55d66a03b21b603eb249f2df7c64a7522089/raw-svgs/tokens/background/{SYMBOL}.svg`.
The MIT copyright and permission text is included at `tokens/LICENSE.txt`.
Only these individual image assets were included, with no package installation,
dependency change, or downloaded runtime code. The underlying token marks retain
their respective trademark rights. All SVGs were checked as passive images.

`tokens/WETH.png` is the token icon from the official Uniswap asset repository:
https://raw.githubusercontent.com/Uniswap/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png.
Its original appearance is preserved; no additional trademark permission is
implied. HYPE uses the unmodified official Hyperliquid mark described above.

The marquee is illustrative presentation, not a live token catalog or runtime
trading configuration. A read-only observation of Hyperliquid's public testnet
`info` metadata on November 6, 2026 found BTC, ETH, SOL, BNB, AVAX, ADA, HYPE and
DOGE present and not marked delisted. This observation does not establish ongoing
availability or execution readiness; the trading app remains the source for
current markets and configuration. XRP, LINK and DOT are explicitly illustrative
asset examples, not support claims. USDC is labeled quote/collateral rather than
a standalone perpetual. The spot examples distinguish WETH/USDC from native ETH
input that wraps to WETH. No live prices, volume, yield, or performance are shown.
