# Landing page assets

The visual reference for this requested local prototype is https://www.suzi.trade/.
Orcus is an independent project and is not affiliated with Suzi or SendAI.

## Original blue garden hero

`garden-hero-v2.webm` (VP9), `garden-hero-v2.mp4` (H.264 fallback), and
`garden-hero-v2-poster.webp` contain the new blue-sky garden. Both silent videos
are 1920 x 1080, 24 fps, 240 frames and ten seconds long. The WebP is the actual
first composed frame at 1920 x 1080, encoded locally with libwebp at quality 82
and compression level 6, without resizing or changing its art.

The three still-art layers were regenerated on November 6, 2026 with the built-in
image tool as targeted color/lighting edits of our original v1 artwork. The base
keeps our v1 landscape geometry, tree positions, valley, meadow and open center.
A settled Suzi garden-video frame was supplied only as a color and lighting
reference for that base edit, not for copying its layout. The tree and cloud
edits preserve their own v1 silhouettes, structure and transparent edges. No
reference video frame or Tethra footage is composited into these exported videos.
The original Suzi reference retains its own ownership and unverified
redistribution terms; this description does not relicense its source artwork.

The base is 1672 x 941 pixels, the transparent tree is 1451 x 1084, and the
transparent cloud is 2172 x 724. The base is modestly upsampled during export.
The image tool generated stills, not temporal video. Deterministic native WebGL
then animated the coherent scene with smooth sky advection, independently
drifting clouds, root-anchored canopy wind, subtle ground/parallax motion and
drifting petals. This is 2.5D layered-art shader animation, not full 3D foliage
physics or a single CSS zoom/pan. The site serves the local exports only; it does
not ship the renderer or make image-generation requests.

The corrected representative frame was visually reviewed before export. Saved
source-frame checks show exact equality at zero and ten seconds. The finished
movies were decoded to verify their actual frame count, changing frames and
loop-boundary continuity. Original artwork, exact prompts, deterministic source
and verification records are retained in the local `assets-temp/generated-hero-v2`
source package, separate from runtime assets. The older garden, Tethra and Suzi
media remain independent rollback/reference options, not sources of v2 footage.

SHA-256 and file sizes:

- MP4: `7d932ae837a07297ecfd0c023d8b0ebf9f30cb51317d418daaae35eb363c9edc`, 10,894,832 bytes.
- WebM: `7ee6fcfaf1d127b2a5946bcf2d1d310df043e58ba6f05693d59ef531082295ae`, 4,871,337 bytes.
- WebP poster: `3215d07946bd42d1939aa955d39aa2f2da79be35bdeafe6afa3d303de6ebb2fd`, 344,128 bytes.

## Original garden hero

The previous generated option, retained for rollback, uses `garden-hero-v1.webm` (VP9), `garden-hero-v1.mp4`
(H.264 fallback), and `garden-hero-v1-poster.webp`. Both video exports are
1920 x 1080, 24 fps, 240 frames, and ten seconds long. The WebP is an unchanged
1920 x 1080 still from the exported poster, encoded locally with libwebp at
quality 82 and compression level 6, without resizing or art transformation.

The scenery was created on November 6, 2026 from three original generated still
layers: a 1672 x 941 opaque garden base, a 1451 x 1084 transparent flowering tree,
and a 2172 x 724 transparent cloud. The latter two used only the new garden as
their style and lighting reference. No downloaded reference-site imagery or
third-party artwork was an input to this garden.

The built-in image-generation tool produced still artwork, not temporal video.
Deterministic native WebGL code then animated the coherent layered scene with
cloud motion, anchored canopy wind, subtle ground/parallax motion, and drifting
petals over a periodic ten-second loop. This is 2.5D compositing, not full 3D
foliage physics or a temporal video model. The base is modestly upsampled in the
1920 x 1080 export. The website serves only the resulting local videos and poster;
it does not ship or run that WebGL renderer.

This original garden provenance does not change or relicense any of the separate
reference artwork, fonts, or third-party marks below. The old hero media remain
in the repository for rollback but are not sources of the active hero.

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

## Workspace integration assets

`../workspace/ostium.png` is the unmodified 5.7 KB mark linked by the official
Ostium website footer, downloaded on November 6, 2026 from
https://www.ostium.com/logos/ostium-mark.png. It is a passive local PNG, not a
remote script or SDK. No explicit redistribution license was identified; the
mark remains Ostium's trademark and is used only to identify the integration,
not to imply endorsement or affiliation. No AI-generated or approximate mark is
substituted.

`../workspace/orcus.svg` is the workspace pink variant of this project's own
existing Orcus icon. It does not modify the public landing's original assets.

## Tethra preview hero

The active comparison hero is `tethra-hero-v1.mp4`, copied byte-for-byte at the
user's request from the local Tethra project's `web/public/bg-hero.mp4`, referenced
by its `web/components/landing/hero-section.tsx`. Only that media is reused, not
Tethra's branding, text, interface or runtime code. The clip's original creator
and redistribution license have not been independently verified. This local
reuse does not claim Orcus ownership or grant a new license; resolve permission
before public release.

The 3,313,698-byte clip is H.264, 1920 x 1080, 24 fps, 192 frames and eight seconds.
Its existing AAC audio is retained unchanged, but playback is always muted.
SHA-256: `1ab42316c6f6caf1c5e9a81a343ee8715a2938f4cc4f5e6051c7e9228109ac78`.
`tethra-hero-v1-poster.webp` is its first frame, encoded at the original
1920 x 1080 dimensions with libwebp quality 82 and compression level 6. No
unprovided WebM alternative is implied. The garden exports and earlier reference
media remain separate inactive rollback options with their own provenance above.
