import {createHash} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {segments, narrationCharacters} from './story.mjs';

export const voice = 'EXAVITQu4vr4xnSDxMaL';
export const model = 'eleven_v4';
export const settings = {stability: 0.5, similarity_boost: 0.8, speed: 1};
export const digest = value => createHash('sha256').update(value).digest('hex');
export const payloadFor = text => ({text, model_id: model, seed: 30102026, voice_settings: settings});
export const fingerprintFor = text => digest(JSON.stringify({voice, payload: payloadFor(text)}));
export function validateCachedAudio(entry, metadata, fingerprint, audio) {
  if (entry?.status !== 'completed' || entry.fingerprint !== fingerprint || metadata?.fingerprint !== fingerprint || metadata.audioHash !== digest(audio)) throw new Error('Unverified voice cache; stopping without regeneration.');
}
export function reserveSegment(ledger, segment, fingerprint) {
  if (ledger.entries[segment.id]) throw new Error(`Segment already attempted: ${segment.id}. No automatic retry is allowed.`);
  const characters = [...segment.narration].length;
  if (ledger.reservedCharacters + characters > 4000) throw new Error('Approved 4000 character ceiling exceeded.');
  return {...ledger, reservedCharacters: ledger.reservedCharacters + characters, entries: {...ledger.entries, [segment.id]: {fingerprint, characters, status: 'pending', reservedAt: new Date().toISOString()}}};
}
export function readScopedKey(file) {
  const match = readFileSync(file, 'utf8').match(/^\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*(.*?)\s*$/m);
  const key = match?.[1]?.replace(/^(['"])(.*)\1$/, '$2');
  if (!key || /\s/.test(key)) throw new Error('ELEVENLABS_API_KEY is absent or invalid in the supplied env file.');
  return key;
}
const save = (path, data) => {writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2) + '\n', {mode: 0o600}); renameSync(`${path}.tmp`, path);};
export function audioDuration(file) {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], {encoding: 'utf8'});
  const duration = Number(probe.stdout);
  if (probe.status !== 0 || !Number.isFinite(duration) || duration <= 0) throw new Error('Audio verification failed. No automatic regeneration is allowed.');
  return duration;
}
export async function main() {
  const {values} = parseArgs({options: {'output-dir': {type: 'string'}, 'env-file': {type: 'string'}, 'allow-paid-tts': {type: 'boolean', default: false}}});
  if (!values['output-dir']) throw new Error('Pass --output-dir outside the repository.');
  if (narrationCharacters() > 4000) throw new Error('Story exceeds the approved character cap.');
  const output = resolve(values['output-dir']), directory = resolve(output, 'voice');
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (output === project || output.startsWith(`${project}/`)) throw new Error('Generated audio must stay outside Git.');
  mkdirSync(directory, {recursive: true});
  const ledgerPath = resolve(directory, 'ledger.json'), lockPath = resolve(directory, 'generation.lock');
  const storyHash = digest(JSON.stringify(segments.map(segment => ({id: segment.id, text: segment.narration, fingerprint: fingerprintFor(segment.narration)}))));
  const lock = openSync(lockPath, 'wx', 0o600);
  try {
    let ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {storyHash, voice, model, maximumCharacters: 4000, reservedCharacters: 0, entries: {}};
    if (ledger.storyHash !== storyHash) throw new Error('Approved story or voice settings changed. Use existing narration or request fresh approval.');
    for (const segment of segments.filter(item => item.narration)) {
      const file = resolve(directory, `${segment.id}.mp3`), metaPath = resolve(directory, `${segment.id}.json`), fingerprint = fingerprintFor(segment.narration);
      const entry = ledger.entries[segment.id];
      if (entry?.status === 'completed' && existsSync(file) && existsSync(metaPath)) {
        const metadata = JSON.parse(readFileSync(metaPath, 'utf8'));
        validateCachedAudio(entry, metadata, fingerprint, readFileSync(file));
        audioDuration(file);
        console.log(`Verified cache: ${segment.id}`);
        continue;
      }
      if (!values['allow-paid-tts'] || !values['env-file']) throw new Error('Paid generation requires --allow-paid-tts and --env-file. No request was sent.');
      const key = readScopedKey(values['env-file']);
      ledger = reserveSegment(ledger, segment, fingerprint);
      save(ledgerPath, ledger);
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
        method: 'POST', headers: {'xi-api-key': key, 'Content-Type': 'application/json'}, body: JSON.stringify(payloadFor(segment.narration)), signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error(`TTS ${segment.id} returned HTTP ${response.status}; reserved attempt remains blocked, no retry.`);
      const data = await response.json(), alignment = data.normalized_alignment ?? data.alignment;
      if (typeof data.audio_base64 !== 'string' || !data.audio_base64 || !Array.isArray(alignment?.character_end_times_seconds) || !alignment.character_end_times_seconds.length) throw new Error(`Incomplete TTS response for ${segment.id}; no retry.`);
      const audio = Buffer.from(data.audio_base64, 'base64');
      writeFileSync(file, audio, {flag: 'wx', mode: 0o600});
      const duration = audioDuration(file);
      save(metaPath, {fingerprint, audioHash: digest(audio), voice, model, settings, text: segment.narration, alignment, duration});
      ledger.entries[segment.id] = {...ledger.entries[segment.id], status: 'completed', duration, completedAt: new Date().toISOString()};
      save(ledgerPath, ledger);
      console.log(`Generated ${segment.id}: ${duration.toFixed(2)}s, ${ledger.reservedCharacters}/4000 characters reserved`);
    }
  } finally {closeSync(lock); unlinkSync(lockPath);}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
