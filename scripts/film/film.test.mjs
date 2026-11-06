import {describe, expect, it} from 'vitest';
import {segments, narrationCharacters} from './story.mjs';
import {reserveSegment, fingerprintFor, validateCachedAudio, digest} from './generate-voice.mjs';
import {timelineFor, cardHtml} from './render.mjs';

describe('chaptered walkthrough', () => {
  it('keeps the approved narration below its single-pass cap', () => {
    expect(narrationCharacters()).toBeGreaterThan(1000);
    expect(narrationCharacters()).toBeLessThanOrEqual(4000);
    expect(segments.filter(segment => segment.type === 'shot')).toHaveLength(7);
    expect(segments.find(segment => segment.id === 'research').narration).toContain('prerecorded');
    expect(segments.find(segment => segment.id === 'strategy').narration).toContain('No strategy is activated');
  });
  it('reserves before dispatch and refuses a second attempt even if its outcome is unknown', () => {
    const segment = segments.find(item => item.narration), fingerprint = fingerprintFor(segment.narration);
    const ledger = reserveSegment({reservedCharacters: 0, entries: {}}, segment, fingerprint);
    expect(ledger.entries[segment.id].status).toBe('pending');
    expect(ledger.reservedCharacters).toBe([...segment.narration].length);
    expect(() => reserveSegment(ledger, segment, fingerprint)).toThrow('already attempted');
    expect(() => reserveSegment({reservedCharacters: 3999, entries: {}}, segment, fingerprint)).toThrow('ceiling');
  });
  it('fingerprints the exact text and keeps the base cut under three minutes', () => {
    expect(fingerprintFor('One')).not.toBe(fingerprintFor('Two'));
    expect(timelineFor({}, {}).durationSeconds).toBeCloseTo(155.6);
  });
  it('only reuses completed audio whose payload and bytes match the cache', () => {
    const audio = Buffer.from('cached audio'), fingerprint = fingerprintFor('Approved text');
    const entry = {status: 'completed', fingerprint}, metadata = {fingerprint, audioHash: digest(audio)};
    expect(() => validateCachedAudio(entry, metadata, fingerprint, audio)).not.toThrow();
    expect(() => validateCachedAudio({...entry, status: 'pending'}, metadata, fingerprint, audio)).toThrow('Unverified');
    expect(() => validateCachedAudio(entry, metadata, fingerprintFor('Changed text'), audio)).toThrow('Unverified');
    expect(() => validateCachedAudio(entry, metadata, fingerprint, Buffer.from('changed bytes'))).toThrow('Unverified');
  });
  it('leaves room for complete narration and never silently speeds up footage', () => {
    const timeline = timelineFor({landing: {duration: 12}}, {landing: {duration: 14}});
    expect(timeline.segments.find(segment => segment.id === 'landing').durationSeconds).toBe(15);
    expect(() => timelineFor({landing: {duration: 200}}, {})).toThrow('review timing');
  });
  it('uses local product branding, escapes copy and creates no subtitle overlay', () => {
    const html = cardHtml({title: '<script>', accent: 'A & B', chapter: 1});
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A &amp; B');
    expect(html).toContain('data:font/woff2');
    expect(html).not.toContain('Lori');
    expect(html).not.toContain('http');
  });
});
