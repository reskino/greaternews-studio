// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dedupeResults, extractEntities, searchWikipediaImages, titleMatchesQuery } from '../imageSearch';
import type { ImageResult } from '../imageSearch';

// The real 2026-11-25 API responses for "Pete Edochie", trimmed. Pages are keyed by id, so
// object iteration order is by id — Yul's Commons file (lower id) used to win over Pete's.
const EDOCHIE_SEARCH = {
  query: {
    pages: {
      '70172862': { title: 'Edochie', index: 4 },
      '15023453': { title: 'Pete Edochie', index: 1, pageimage: 'Pete-edochie.jpg' },
      '67423111': { title: 'Rita Edochie', index: 3, pageimage: 'Chioma_Toplis,_Rita_Edochie_and_Patience_Ozokwor.jpg' },
      '47817493': { title: 'Yul Edochie', index: 2, pageimage: 'Yul_Edochie.JPG' },
    },
  },
};
const commonsFile = (title: string) => ({
  title,
  imageinfo: [{ url: `https://upload/${encodeURIComponent(title)}`, extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } } }],
});
const EDOCHIE_COMMONS = {
  query: {
    pages: {
      '43885420': commonsFile('File:Yul Edochie.JPG'),
      '90000000': commonsFile('File:Chioma Toplis, Rita Edochie and Patience Ozokwor.jpg'),
      '117399589': commonsFile('File:Pete-edochie.jpg'),
    },
  },
};

function stubWikiFetch(search: object, commons: object) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({ ok: true, json: async () => (url.includes('en.wikipedia.org') ? search : commons) })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchWikipediaImages', () => {
  it('returns lead images in search-rank order, not page-id order', async () => {
    stubWikiFetch(EDOCHIE_SEARCH, EDOCHIE_COMMONS);
    const results = await searchWikipediaImages('Pete Edochie');
    expect(results.map((result) => result.title)).toEqual([
      'Pete Edochie (Wikipedia lead image)',
      'Yul Edochie (Wikipedia lead image)',
      'Rita Edochie (Wikipedia lead image)',
    ]);
  });

  it('topOnly returns only the best-matching article', async () => {
    stubWikiFetch(EDOCHIE_SEARCH, EDOCHIE_COMMONS);
    const results = await searchWikipediaImages('Pete Edochie', { topOnly: true });
    expect(results.map((result) => result.title)).toEqual(['Pete Edochie (Wikipedia lead image)']);
  });

  it('topOnly returns nothing (not a runner-up) when the top article has no free image', async () => {
    const commonsWithoutPete = { query: { pages: { '43885420': commonsFile('File:Yul Edochie.JPG'), '-1': { title: 'File:Pete-edochie.jpg', missing: '' } } } };
    stubWikiFetch(EDOCHIE_SEARCH, commonsWithoutPete);
    expect(await searchWikipediaImages('Pete Edochie', { topOnly: true })).toEqual([]);
  });
});

describe('titleMatchesQuery', () => {
  it('requires every query word in the title', () => {
    expect(titleMatchesQuery('Pete-edochie.jpg', 'Pete Edochie')).toBe(true);
    expect(titleMatchesQuery('Yul Edochie.JPG', 'Pete Edochie')).toBe(false);
    expect(titleMatchesQuery('Court of Arbitration for Sport - Lausanne.jpg', 'Court of Arbitration for Sport')).toBe(true);
    expect(titleMatchesQuery('Olympic Stadium (London) illuminated, 3 August 2012.jpg', 'Court of Arbitration for Sport')).toBe(false);
  });

  it('rejects lookalikes and impersonators even when the name matches', () => {
    expect(titleMatchesQuery("Kingsley Abasili (Pete Edochie's Lookalike).jpg", 'Pete Edochie')).toBe(false);
    expect(titleMatchesQuery('Pete Edochie impersonator.jpg', 'Pete Edochie')).toBe(false);
  });

  it('ignores accents and punctuation', () => {
    expect(titleMatchesQuery('Brahim_Díaz_2023.jpg', 'Brahim Diaz')).toBe(true);
  });
});

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
