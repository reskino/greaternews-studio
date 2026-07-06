// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { dedupeResults, extractEntities } from '../imageSearch';
import type { ImageResult } from '../imageSearch';

describe('extractEntities', () => {
  it('extracts multi-word capitalized runs as entities', () => {
    const entities = extractEntities('Ashanti Regional Coordinating Council, Zoomlion launch intensified sanitation campaign');
    expect(entities).toContain('Ashanti Regional Coordinating Council Zoomlion');
  });

  it('expands Ghana acronyms so BoG never matches the swamp', () => {
    const entities = extractEntities('Number of jobs advertised falls in quarter one 2026 - BoG');
    expect(entities).toContain('Bank of Ghana');
    expect(entities).not.toContain('BoG');
  });

  it('caps at three entities', () => {
    const entities = extractEntities('Kwame Nkrumah met Yaa Asantewaa near Accra Sports Stadium with John Mahama and Nana Addo');
    expect(entities.length).toBeLessThanOrEqual(3);
  });

  it('returns nothing useful for all-lowercase headlines', () => {
    const entities = extractEntities('the quick brown fox jumps over the lazy dog');
    expect(entities).toEqual([]);
  });
});

describe('dedupeResults', () => {
  it('drops results with duplicate full URLs', () => {
    const make = (id: string, url: string): ImageResult => ({
      id,
      title: id,
      thumbUrl: url,
      fullUrl: url,
      license: 'CC0',
      author: 'test',
      sourcePage: '',
      provider: 'Wikimedia Commons',
    });
    const deduped = dedupeResults([make('a', 'https://x/1.jpg'), make('b', 'https://x/1.jpg'), make('c', 'https://x/2.jpg')]);
    expect(deduped.map((result) => result.id)).toEqual(['a', 'c']);
  });
});
