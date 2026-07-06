// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildClaudeBrief, buildFacebookPost, buildInstagramCaption, buildXPost, parsePackFields } from '../outputs';
import type { StoryDraft } from '../types';

function makeDraft(overrides: Partial<StoryDraft> = {}): StoryDraft {
  return {
    id: 'test',
    title: 'Test story',
    category: 'Ghana business & economy',
    status: 'READY',
    headline: 'Cedi opens the second half of 2026 around GH¢12.30 on the forex market',
    primarySource: 'Modern Ghana',
    backupSources: 'Pulse Ghana, TradingEconomics',
    sourcesSearched: 'Modern Ghana, Pulse',
    verificationNotes: 'Figures cross-checked.',
    keyFacts: 'The cedi began July selling at about GH¢12.35 to the dollar before settling near GH¢12.25.',
    angle: 'What this does to prices in your pocket this month.',
    quote: 'Reserves remain strong',
    cta: 'How is this affecting you?',
    imageSuggestion: 'Stat card with the number GH¢12.30 large.',
    menuNote: 'Cedi rates for early July.',
    isLive: true,
    ...overrides,
  };
}

describe('buildXPost', () => {
  it('never exceeds 280 characters, even with very long inputs', () => {
    const draft = makeDraft({
      headline: 'A very long headline that goes on and on '.repeat(5),
      keyFacts: 'Extremely detailed facts about the economy that keep going. '.repeat(10),
    });
    expect(buildXPost(draft).length).toBeLessThanOrEqual(280);
  });

  it('includes the source attribution', () => {
    expect(buildXPost(makeDraft())).toContain('(Source: Modern Ghana)');
  });

  it('prefixes DEVELOPING stories', () => {
    expect(buildXPost(makeDraft({ status: 'DEVELOPING' }))).toMatch(/^DEVELOPING: /);
  });
});

describe('buildFacebookPost', () => {
  it('uppercases the hook headline and ends with the engagement question', () => {
    const post = buildFacebookPost(makeDraft());
    expect(post).toContain('CEDI OPENS THE SECOND HALF');
    expect(post.trim().endsWith('How is this affecting you?')).toBe(true);
  });

  it('always carries the brand hashtags', () => {
    const post = buildFacebookPost(makeDraft());
    expect(post).toContain('#GreaterNews');
    expect(post).toContain('#Ghana');
  });
});

describe('buildInstagramCaption', () => {
  it('caps hashtags at 12', () => {
    const caption = buildInstagramCaption(makeDraft());
    const lines = caption.split('\n');
    const hashtags = lines[lines.length - 1].split(/\s+/).filter((word: string) => word.startsWith('#'));
    expect(hashtags.length).toBeLessThanOrEqual(12);
  });

  it('includes an image suggestion line', () => {
    expect(buildInstagramCaption(makeDraft())).toContain('[IMAGE SUGGESTION]');
  });
});

describe('buildClaudeBrief', () => {
  it('embeds the article excerpt when provided', () => {
    const brief = buildClaudeBrief(makeDraft(), 'First paragraph of the article.');
    expect(brief).toContain('ARTICLE EXCERPT');
    expect(brief).toContain('First paragraph of the article.');
  });

  it('omits the excerpt section when empty', () => {
    expect(buildClaudeBrief(makeDraft())).not.toContain('ARTICLE EXCERPT');
  });

  it('states the verification rules', () => {
    const brief = buildClaudeBrief(makeDraft());
    expect(brief).toContain('at least 2 independent');
    expect(brief).toContain('under 15 words');
  });
});

describe('parsePackFields', () => {
  it('parses a well-formed fields block including multi-line values', () => {
    const reply = [
      'Here is your pack…',
      '===FIELDS===',
      'HEADLINE: Cedi steadies at GH¢12.25',
      'KEYFACTS: The cedi traded at GH¢12.25 on Friday.',
      'That was slightly stronger than the GH¢12.35 open.',
      'ANGLE: What it means for import prices.',
      'QUOTE: ',
      'CTA: How is this affecting you?',
      'IMAGE: Stat card with GH¢12.25.',
      'SOURCES: Modern Ghana, Pulse',
      'STATUS: READY',
      '===END===',
    ].join('\n');

    const fields = parsePackFields(reply);
    expect(fields?.headline).toBe('Cedi steadies at GH¢12.25');
    expect(fields?.keyFacts).toContain('slightly stronger');
    expect(fields?.status).toBe('READY');
    expect(fields?.sourcesSearched).toBe('Modern Ghana, Pulse');
  });

  it('returns null when no block is present', () => {
    expect(parsePackFields('just some prose with no block')).toBeNull();
  });

  it('rejects invalid status values', () => {
    const fields = parsePackFields('===FIELDS===\nHEADLINE: x\nSTATUS: MAYBE\n===END===');
    expect(fields?.status).toBeUndefined();
    expect(fields?.headline).toBe('x');
  });
});
