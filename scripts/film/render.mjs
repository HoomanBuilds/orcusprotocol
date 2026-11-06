import {createHash} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync, mkdirSync, createReadStream} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {segments, promise, narrationCharacters} from './story.mjs';
import {fingerprintFor} from './generate-voice.mjs';
import {prepareEditedVoice, removedSentences} from './edit-voice.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = (program, args) => {
  const result = spawnSync(program, args, {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  if (result.status !== 0) throw new Error(`${program} failed: ${result.stderr || result.error || result.stdout}`);
  return result.stdout;
};
const probe = file => JSON.parse(run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const escapeHtml = value => value.replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const hashFile = async file => {const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');};
export function cardHtml(segment) {
  const font = readFileSync(resolve(project, 'web/public/landing/fonts/inter-regular.woff2')).toString('base64');
  return `<!doctype html><html><head><meta charset="utf-8"><style>@font-face{font-family:Inter;src:url(data:font/woff2;base64,${font})}*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#171518;color:#f7f4f6;font-family:Inter,sans-serif}main{height:100%;padding:100px 132px;display:flex;flex-direction:column}.brand{font-size:46px;font-weight:700;line-height:.9;letter-spacing:-3.8px}.brand span{color:#ff99d6}.copy{margin:auto 0}h1{font-size:104px;font-weight:400;line-height:1.15;letter-spacing:-5px;margin:0}h1 span{color:#ffa4d4}.footer{font-size:20px;color:#a7a1a6;text-align:right}</style></head><body><main><div class="brand">orcus<span>.</span></div><div class="copy"><h1>${escapeHtml(segment.title)}<br><span>${escapeHtml(segment.accent)}</span></h1></div><div class="footer">${segment.chapter ? `${String(segment.chapter).padStart(2, '0')} / 07` : ''}</div></main></body></html>`;
}
export function timelineFor(sourceInfo, voiceInfo) {
  let cursor = 0;
  const timeline = segments.map(segment => {
    const lead = segment.narration ? 0.35 : 0;
    const audioSeconds = voiceInfo[segment.id]?.duration ?? 0;
    const sourceSeconds = sourceInfo[segment.id]?.duration ?? 0;
    const minimum = voiceInfo[segment.id]?.text ? Math.min(segment.duration, audioSeconds + 2) : segment.duration;
    const durationSeconds = Math.ceil(Math.max(minimum, sourceSeconds, audioSeconds + lead + (segment.id === 'closing' ? 2 : 0.65)) * 30) / 30;
    const entry = {...segment, narration: voiceInfo[segment.id]?.text ?? segment.narration, startSeconds: cursor, durationSeconds, audioSeconds, voiceOffset: lead};
    cursor += durationSeconds;
    return entry;
  });
  if (cursor >= 180) throw new Error(`Cut would be ${cursor.toFixed(1)} seconds; review timing before rendering. Do not accelerate speech or invent shorter footage.`);
  return {durationSeconds: cursor, segments: timeline};
}
export async function main() {
  const {values} = parseArgs({options: {'output-dir': {type: 'string'}, 'source-dir': {type: 'string'}, browser: {type: 'string', default: '/usr/bin/chromium'}, 'cards-only': {type: 'boolean', default: false}}});
  if (!values['output-dir']) throw new Error('Pass --output-dir outside the repository.');
  const output = resolve(values['output-dir']);
  if (output === project || output.startsWith(`${project}/`)) throw new Error('Generated film assets must stay outside Git.');
  const cards = resolve(output, 'cards'), parts = resolve(output, 'parts');
  mkdirSync(cards, {recursive: true}); mkdirSync(parts, {recursive: true});
  for (const segment of segments.filter(item => item.type === 'card')) {
    const html = resolve(cards, `${segment.id}.html`), image = resolve(cards, `${segment.id}.png`);
    writeFileSync(html, cardHtml(segment));
    run(values.browser, ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--disable-background-networking', '--force-device-scale-factor=1', '--window-size=1920,1080', '--virtual-time-budget=1000', `--screenshot=${image}`, pathToFileURL(html).href]);
  }
  if (values['cards-only']) return;
  if (!values['source-dir']) throw new Error('Pass --source-dir containing the seven actual UI recordings.');
  const sourceInfo = {}, voiceInfo = {};
  for (const segment of segments) {
    if (segment.type === 'shot') {
      const file = resolve(values['source-dir'], segment.file), info = probe(file), video = info.streams.find(stream => stream.codec_type === 'video');
      if (!video || Number(info.format.duration) <= 0) throw new Error(`Invalid source: ${segment.id}`);
      sourceInfo[segment.id] = {file, hash: await hashFile(file), duration: Number(info.format.duration), width: video.width, height: video.height};
    }
    if (segment.narration) {
      const file = resolve(output, 'voice', `${segment.id}.mp3`), meta = resolve(output, 'voice', `${segment.id}.json`);
      if (!existsSync(meta)) throw new Error(`Generate the approved narration first: ${segment.id}`);
      const metadata = JSON.parse(readFileSync(meta, 'utf8'));
      if (metadata.fingerprint !== fingerprintFor(segment.narration) || metadata.audioHash !== await hashFile(file)) throw new Error(`Narration cache mismatch: ${segment.id}`);
      voiceInfo[segment.id] = {file, hash: metadata.audioHash, duration: Number(probe(file).format.duration)};
      if (removedSentences[segment.id]) {
        const edited = prepareEditedVoice(output, segment.id);
        voiceInfo[segment.id] = {file: edited.file, hash: edited.audioHash, duration: edited.duration, text: edited.text, sourceHash: edited.sourceHash, retainedSpans: edited.spans};
      }
      if (!Number.isFinite(voiceInfo[segment.id].duration) || voiceInfo[segment.id].duration <= 0) throw new Error('Invalid narration duration.');
    }
  }
  const timeline = timelineFor(sourceInfo, voiceInfo);
  json(resolve(output, 'timeline.json'), {...timeline, promise, resolution: '1920x1080', fps: 30, sourceInfo, voiceInfo, music: false, subtitles: false});
  json(resolve(output, 'narration-manifest.json'), {originalApprovedCharacters: narrationCharacters(), editorialCharacters: timeline.segments.reduce((total, segment) => total + [...segment.narration].length, 0), provenance: {research: 'Previously recorded 0G response displayed in the interface, not a new inference call during capture.', trading: 'Unfunded wallet; no trades submitted. Strategy review only, no activation. Native status labels remain visible.'}, segments: timeline.segments.filter(segment => segment.narration).map(({id, narration, startSeconds, voiceOffset, audioSeconds}) => ({id, text: narration, startSeconds: startSeconds + voiceOffset, audioSeconds, sourceHash: voiceInfo[id]?.sourceHash ?? voiceInfo[id]?.hash, retainedSpans: voiceInfo[id]?.retainedSpans}))});
  const rendererHash = await hashFile(fileURLToPath(import.meta.url));
  for (const segment of timeline.segments) {
    const file = resolve(parts, `${segment.id}.mkv`), silent = resolve(parts, `${segment.id}-silent.mkv`), cache = resolve(parts, `${segment.id}.json`);
    const input = segment.type === 'card' ? resolve(cards, `${segment.id}.png`) : sourceInfo[segment.id].file;
    const fingerprint = createHash('sha256').update(JSON.stringify({segment, rendererHash, source: await hashFile(input), voice: voiceInfo[segment.id]?.hash})).digest('hex');
    if (existsSync(cache) && existsSync(file) && existsSync(silent) && JSON.parse(readFileSync(cache, 'utf8')).fingerprint === fingerprint) {console.log(`Cached render: ${segment.id}`); continue;}
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2'];
    if (segment.type === 'card') args.push('-loop', '1', '-framerate', '30');
    args.push('-i', input, '-an', '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x171518,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=180,format=yuv420p', '-filter_threads', '2', '-t', String(segment.durationSeconds), '-r', '30', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-threads', '2', silent);
    run('ffmpeg', args);
    const mux = ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-i', silent];
    if (voiceInfo[segment.id]) mux.push('-i', voiceInfo[segment.id].file);
    else mux.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    mux.push('-filter_complex_threads', '2', '-filter_complex', `[1:a]loudnorm=I=-18:TP=-2:LRA=7,aresample=48000,adelay=${Math.round(segment.voiceOffset * 1000)}:all=1,apad,atrim=duration=${segment.durationSeconds}[a]`, '-map', '0:v', '-map', '[a]', '-t', String(segment.durationSeconds), '-c:v', 'copy', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-threads', '2', file);
    run('ffmpeg', mux); json(cache, {fingerprint}); console.log(`Rendered ${segment.id}: ${segment.durationSeconds.toFixed(2)}s`);
  }
  for (const [name, suffix] of [['silent-master', '-silent'], ['narrated-master', '']]) {
    const list = resolve(parts, `${name}.txt`);
    writeFileSync(list, timeline.segments.map(segment => `file '${segment.id}${suffix}.mkv'`).join('\n') + '\n');
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', resolve(output, `${name}.mkv`)]);
  }
  const chapters = timeline.segments.filter(segment => segment.type === 'card');
  const metadata = resolve(output, 'chapters.ffmeta');
  writeFileSync(metadata, ';FFMETADATA1\ntitle=Orcus product walkthrough\n' + chapters.map((chapter, index) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(chapter.startSeconds * 1000)}\nEND=${Math.round((chapters[index + 1]?.startSeconds ?? timeline.durationSeconds) * 1000)}\ntitle=${chapter.title} ${chapter.accent}\n`).join(''));
  const share = resolve(output, 'orcus-walkthrough-sarah.mp4');
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-i', resolve(output, 'narrated-master.mkv'), '-i', metadata, '-map', '0:v', '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-threads', '2', '-movflags', '+faststart', share]);
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-ss', '1', '-i', share, '-frames:v', '1', '-threads', '2', resolve(output, 'poster.png')]);
  json(resolve(output, 'verification.json'), {silent: probe(resolve(output, 'silent-master.mkv')), narrated: probe(resolve(output, 'narrated-master.mkv')), share: probe(share)});
  console.log(`Complete: ${share} (${timeline.durationSeconds.toFixed(2)}s)`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
