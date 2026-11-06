# Orcus narrated walkthrough

Seven real UI recordings alternate with restrained product chapter cards. The nominal cut is 156 seconds, 1920 x 1080 at 30 fps. Sarah narrates; there is no music, subtitle stream, burned-in caption layer, or added warning banner. Provenance belongs here and in the output manifest: research uses a previously recorded 0G response, strategy work ends at review, and the wallet stays unfunded. No trades are submitted. Queued request status is not a completed result. Native product statuses remain visible.

The scripts use the product's existing Inter font and landing-page `orcus.` wordmark, Chromium for title cards, and FFmpeg with two threads. No Remotion dependency is needed. Run capture and render serially with other resource-intensive tasks.

## Inputs

Review `story.mjs` before any paid generation. The capture directory must contain `01-landing.mp4`, `02-onboarding.mp4`, `03-hyperliquid.mp4`, `04-uniswap.mp4`, `05-research.mp4`, `06-strategy.mp4`, and `07-control-history.mp4`. Captures must show the stated controls and actual result, not synthetic executions. Preserve the capture manifest beside these original recordings.

Use an absolute output directory outside the repository. Install Chromium, FFmpeg and ffprobe locally if absent. Existing repository dependencies cover the focused tests. Do not start another heavy render in parallel.

Capture first signs into a fresh unfunded wallet locally, then visibly enters the browser-only Demo account for populated Overview, terminal, and swap inputs. Its native Demo account badge is shown on entry and at the top of each demo scene; ordinary scrolling can briefly move the header offscreen before returning to the top. Sample completed actions are not evidence of real execution. The capture visibly exits demo before restoring prior research, reviewing a strategy on the real unfunded account, and showing actual queued local work and owner controls. Full reloads isolate demo state; the research playback wrapper is installed only after the real session is restored. The capture manifest records both account-mode transitions and per-shot data provenance. Browser-level request interception separately blocks every local write while demo mode is active.

## Voice approval and cache

One approved Sarah pass is capped at 4,000 total text characters. `generate-voice.mjs` uses the verified `eleven_v4` model and Sarah voice with the reference settings. It reads only `ELEVENLABS_API_KEY` from the explicitly supplied env file and never prints it. No voice request occurs without the paid flag.

```sh
node scripts/film/generate-voice.mjs --output-dir /absolute/output/orcus-film --env-file /absolute/private/tts.env --allow-paid-tts
```

The ledger reserves each segment's character cost before sending it. Verified completed audio is reused by exact text/voice/settings fingerprint and audio hash. A timeout, malformed response, interruption after submission, or missing completed cache stops the run. Pending attempts are not automatically retried, and changed story text cannot start a second pass in that ledger. Inspect billing and obtain new approval before any manual recovery. Keep this same output directory and ledger throughout the approved pass.

The approved editorial version removes selected explanatory demo disclaimers from the existing speech, without generating another word. `edit-voice.mjs` validates exact timestamp alignment, retains specified sentence spans, and produces local WAV derivatives in `voice-edited`. Original MP3s, story, approved character ledger, and voice settings remain untouched. Render manifests contain the exact retained narration, source audio hashes, and retained source spans. Preview the edit plan without running FFmpeg using `node scripts/film/edit-voice.mjs --output-dir /absolute/output/orcus-film --dry-run`. The renderer applies this approved edit automatically. Narration describes capabilities and review controls, not an execution that did not happen.

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
