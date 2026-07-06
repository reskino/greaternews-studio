// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { clampText, decodeEntities, normalizeWhitespace, stripHtml } from '../text';

describe('decodeEntities', () => {
  it('decodes single-encoded entities', () => {
    expect(decodeEntities('It&#39;s here')).toBe("It's here");
  });

  it('decodes double-encoded entities (the GhanaWeb case)', () => {
    expect(decodeEntities('It&amp;#39;s here')).toBe("It's here");
  });

  it('strips embedded tags', () => {
    expect(decodeEntities('<b>Bold</b> claim')).toBe('Bold claim');
  });

  it('leaves plain text untouched', () => {
    expect(decodeEntities('Black Stars win 1-0')).toBe('Black Stars win 1-0');
  });
});

describe('clampText', () => {
  it('returns short text unchanged', () => {
    expect(clampText('short', 20)).toBe('short');
  });

  it('clamps long text to the limit with an ellipsis', () => {
    const clamped = clampText('a'.repeat(100), 50);
    expect(clamped.length).toBeLessThanOrEqual(50);
    expect(clamped.endsWith('…')).toBe(true);
  });
});

describe('normalizeWhitespace / stripHtml', () => {
  it('collapses runs of whitespace', () => {
    expect(normalizeWhitespace('a  b\n\tc')).toBe('a b c');
  });

  it('extracts text content from HTML', () => {
    expect(stripHtml('<p>Hello <a href="#">world</a></p>')).toBe('Hello world');
  });
});
