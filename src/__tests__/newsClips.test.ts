import { describe, expect, it } from 'vitest';
import { clipLabel, clipNames, pickClip } from '../newsClips';
import type { ClipResult } from '../newsClips';

const year = new Date().getFullYear();
const clip = (over: Partial<ClipResult>): ClipResult => ({
  title: 'U S Forces Conduct Precision Strikes in Iran (998347)',
  description: 'U.S. forces conduct precision strikes in Iran, targeting command and control facilities.',
  src: 'https://upload.wikimedia.org/x.webm', poster: '', durationS: 24, year, license: 'Public domain',
  by: 'U.S. Dept. of Defense (DVIDS)', sourcePage: 'https://commons.wikimedia.org/wiki/File:X.webm',
  ...over,
});

describe('news clip picking', () => {
  it('reads the named subjects from a query (dropping "Ghana" when something more specific is named)', () => {
    expect(clipNames('U.S. forces strikes Iran')).toEqual(['iran']);
    expect(clipNames('Mahama speech Accra Ghana')).toEqual(['mahama', 'accra']);
  });

  it('picks a recent clip that names the subject and matches the words', () => {
    expect(pickClip([clip({})], 'U.S. forces strikes Iran', { strict: true })?.title).toContain('Strikes in Iran');
  });

  it('refuses clips that do not name the subject', () => {
    const other = clip({ title: 'Precision strikes training exercise', description: 'Forces train for strikes.' });
    expect(pickClip([other], 'U.S. forces strikes Iran')).toBeNull();
  });

  it('refuses old footage (it would mislead under today\'s narration)', () => {
    expect(pickClip([clip({ year: year - 5 })], 'U.S. forces strikes Iran')).toBeNull();
  });

  it('never reuses a clip already used in the same video', () => {
    const used = new Set(['U S Forces Conduct Precision Strikes in Iran (998347)']);
    expect(pickClip([clip({})], 'U.S. forces strikes Iran', { used })).toBeNull();
  });

  it('automatic (strict) picks need a named subject', () => {
    const oil = clip({ title: 'Oil prices rise', description: 'Oil prices rise on markets.' });
    expect(pickClip([oil], 'oil prices', { strict: true })).toBeNull();
  });

  it('labels the credit, marking older footage as FILE', () => {
    expect(clipLabel(clip({}))).toBe(`VIDEO: U.S. Dept. of Defense (DVIDS) · ${year} · Public domain`);
    expect(clipLabel(clip({ year: year - 1 }))).toMatch(/^FILE · VIDEO:/);
  });
});
