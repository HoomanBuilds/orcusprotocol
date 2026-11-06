# Orcus narrated walkthrough

Seven real UI recordings alternate with restrained product chapter cards. The nominal cut is 156 seconds, 1920 x 1080 at 30 fps. Sarah narrates; there is no music, subtitle stream, or burned-in caption layer. The research recording is disclosed as prerecorded, strategy work ends at review, and the wallet stays unfunded. No trades are submitted.

The scripts use the product's existing Inter font and Orcus mark, Chromium for title cards, and FFmpeg with two threads. No Remotion dependency is needed. Run capture and render serially with other resource-intensive tasks.

## Inputs

Review `story.mjs` before any paid generation. The capture directory must contain `01-landing.mp4`, `02-onboarding.mp4`, `03-hyperliquid.mp4`, `04-uniswap.mp4`, `05-research.mp4`, `06-strategy.mp4`, and `07-control-history.mp4`. Captures must show the stated controls and actual result, not synthetic executions. Preserve the capture manifest beside these original recordings.

Use an absolute output directory outside the repository. Install Chromium, FFmpeg and ffprobe locally if absent. Existing repository dependencies cover the focused tests. Do not start another heavy render in parallel.

## Voice approval and cache

One approved Sarah pass is capped at 4,000 total text characters. `generate-voice.mjs` uses the verified `eleven_v4` model and Sarah voice with the reference settings. It reads only `ELEVENLABS_API_KEY` from the explicitly supplied env file and never prints it. No voice request occurs without the paid flag.

```sh
node scripts/film/generate-voice.mjs --output-dir /absolute/output/orcus-film --env-file /absolute/private/tts.env --allow-paid-tts
```

The ledger reserves each segment's character cost before sending it. Verified completed audio is reused by exact text/voice/settings fingerprint and audio hash. A timeout, malformed response, interruption after submission, or missing completed cache stops the run. Pending attempts are not automatically retried, and changed story text cannot start a second pass in that ledger. Inspect billing and obtain new approval before any manual recovery. Keep this same output directory and ledger throughout the approved pass.

## Render

Render cards first for a visual check without voice generation:

```sh
node scripts/film/render.mjs --output-dir /absolute/output/orcus-film --cards-only
```

Then create the complete film from approved narration and actual captures:

```sh
systemd-run --user --scope --slice=orcus-ui-preview.slice -p MemoryMax=1536M -p MemorySwapMax=128M node scripts/film/render.mjs --output-dir /absolute/output/orcus-film --source-dir /absolute/output/capture
```

Pass `--browser /path/to/chromium` if needed. Shot pacing remains at the recorded speed; a final frame can hold when narration needs more time. The renderer refuses a cut of 180 seconds or longer for editorial review rather than accelerating speech or footage. Matching rendered parts are cached. Never point a new edition at an approved film's output directory.

Outputs are `silent-master.mkv`, `narrated-master.mkv`, `orcus-walkthrough-sarah.mp4`, `poster.png`, `timeline.json`, `narration-manifest.json`, chapter metadata, and `verification.json` with ffprobe results. The MP4 has navigation chapters and AAC narration; the narrated master keeps PCM audio. Originals and separate voice segments remain available.

Review the full film at normal speed and inspect transition frames. Verify screen legibility, narration synchronization, genuine click results, truthful demo labels, source confidentiality, duration, codecs and audio streams before sharing. No render alone proves that a trading transaction completed.
