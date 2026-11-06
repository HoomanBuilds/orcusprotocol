import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {segments} from './story.mjs';
import {digest, fingerprintFor, audioDuration} from './generate-voice.mjs';

export const removedSentences = {
  swap: ['Here, we use an unfunded test wallet and do not submit a swap.'],
  research: ['This is a prerecorded zero G research response, shown with its sources and tool activity.', 'Research is not permission to trade.'],
  strategy: ['This recording stops at review.', 'No strategy is activated, and no trades are submitted.'],
  'control-history': ['This request is queued, not completed.'],
};
export function retainedText(id, text) {
  for (const sentence of removedSentences[id] ?? []) {
    if (text.split(sentence).length !== 2) throw new Error(`Editorial sentence must occur exactly once: ${id}`);
    text = text.replace(sentence, '');
  }
  return text.replace(/\s+/g, ' ').trim();
}
export function editPlan(id, metadata, sourceDuration) {
  const {text, alignment} = metadata;
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0 || !Array.isArray(alignment?.characters) || alignment.characters.join('') !== text) throw new Error('Alignment must exactly match the approved source text.');
  const starts = alignment.character_start_times_seconds, ends = alignment.character_end_times_seconds;
  if (starts?.length !== text.length || ends?.length !== text.length || starts.some((time, index) => !Number.isFinite(time) || time < 0 || (index && time < starts[index - 1])) || ends.some((time, index) => !Number.isFinite(time) || time < starts[index])) throw new Error('Invalid character alignment.');
  const removed = (removedSentences[id] ?? []).map(sentence => {
    const start = text.indexOf(sentence);
    if (start < 0 || text.indexOf(sentence, start + 1) >= 0) throw new Error(`Editorial sentence must occur exactly once: ${id}`);
    return {start, end: start + sentence.length};
  }).sort((a, b) => a.start - b.start);
  const ranges = [];
  let cursor = 0;
  for (const interval of removed) {if (interval.start > cursor) ranges.push({start: cursor, end: interval.start}); cursor = interval.end;}
  if (cursor < text.length) ranges.push({start: cursor, end: text.length});
  const spans = ranges.flatMap(range => {
    let {start, end} = range;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (start === end) return [];
    let previous = start - 1, next = end;
    while (previous >= 0 && /\s/.test(text[previous])) previous--;
    while (next < text.length && /\s/.test(text[next])) next++;
    const startSeconds = Math.max(0, starts[start] - 0.025, previous >= 0 ? ends[previous] : 0);
    const endSeconds = Math.min(sourceDuration, ends[end - 1] + 0.04, next < text.length ? starts[next] : sourceDuration);
    if (endSeconds <= startSeconds) throw new Error('Editorial span has no audio.');
    return [{text: text.slice(start, end), characterStart: start, characterEnd: end, startSeconds, endSeconds}];
  });
  const editedText = spans.map(span => span.text).join(' ');
  if (!spans.length || editedText !== retainedText(id, text)) throw new Error('Editorial text reconstruction failed.');
  return {id, text: editedText, sourceDuration, spans};
}
export function prepareEditedVoice(output, id, dryRun = false) {
  const original = resolve(output, 'voice', `${id}.mp3`), metadata = JSON.parse(readFileSync(resolve(output, 'voice', `${id}.json`), 'utf8'));
  const sourceHash = digest(readFileSync(original));
  if (metadata.audioHash !== sourceHash || metadata.fingerprint !== fingerprintFor(metadata.text)) throw new Error(`Original narration cache mismatch: ${id}`);
  const plan = editPlan(id, metadata, audioDuration(original));
  const editHash = digest(JSON.stringify({sourceHash, plan, version: 1}));
  if (dryRun) return {...plan, sourceHash, editHash};
  const directory = resolve(output, 'voice-edited');
  mkdirSync(directory, {recursive: true});
  const file = resolve(directory, `${id}.wav`), metaPath = resolve(directory, `${id}.json`);
  if (existsSync(file) && existsSync(metaPath)) {
    const cached = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (cached.editHash === editHash && cached.audioHash === digest(readFileSync(file))) return {...cached, file, duration: audioDuration(file)};
  }
  const filters = plan.spans.map((span, index) => `[0:a]atrim=start=${span.startSeconds}:end=${span.endSeconds},asetpts=PTS-STARTPTS[a${index}]`);
  filters.push(`${plan.spans.map((_span, index) => `[a${index}]`).join('')}concat=n=${plan.spans.length}:v=0:a=1[out]`);
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-i', original, '-filter_complex_threads', '2', '-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-threads', '2', file], {encoding: 'utf8'});
  if (result.status !== 0) throw new Error(`Local voice edit failed: ${result.stderr || result.error}`);
  const edited = {...plan, sourceHash, original, editHash, audioHash: digest(readFileSync(file)), duration: audioDuration(file)};
  writeFileSync(metaPath, JSON.stringify(edited, null, 2) + '\n');
  return {...edited, file};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {values} = parseArgs({options: {'output-dir': {type: 'string'}, 'dry-run': {type: 'boolean', default: false}}});
  if (!values['output-dir']) throw new Error('Pass the existing approved narration output directory.');
  for (const id of Object.keys(removedSentences)) console.log(JSON.stringify(prepareEditedVoice(resolve(values['output-dir']), id, values['dry-run'])));
}
