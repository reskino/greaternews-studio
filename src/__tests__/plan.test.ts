import { describe, expect, it } from 'vitest';
import { buildHeuristicPlan, filterByExcludeTerms } from '../imageSearch';
import type { ImageResult } from '../imageSearch';

function fakeResult(title: string, author = ''): ImageResult {
  return {
    id: title,
    title,
    thumbUrl: '',
    fullUrl: title,
    license: 'CC',
    author,
    sourcePage: '',
    provider: 'Wikimedia Commons',
  };
}

describe('buildHeuristicPlan', () => {
  it('reads "DVLA CEO" as the Ghana authority and excludes the UK matches', () => {
    const plan = buildHeuristicPlan('DVLA CEO');
    expect(plan.country).toBe('Ghana');
    expect(plan.entity).toContain('Driver and Vehicle Licensing Authority');
    // no free portrait guaranteed, so it should not invent a person
    expect(plan.person).toBe('');
    // org-led queries, best first
    expect(plan.searchQueries[0]).toContain('Driver and Vehicle Licensing Authority');
    // the UK DVLA junk gets filtered
    expect(plan.excludeTerms).toContain('Swansea');
    expect(plan.excludeTerms).toContain('United Kingdom');
  });

  it('expands a bare acronym without a role', () => {
    const plan = buildHeuristicPlan('GRA');
    expect(plan.entity).toBe('Ghana Revenue Authority');
    expect(plan.searchQueries).toContain('Ghana Revenue Authority');
  });

  it('treats a leading role word as a name, not an org+role', () => {
    const plan = buildHeuristicPlan('President Mahama');
    // "President" leads, so it is not stripped as an org role
    expect(plan.searchQueries[0].toLowerCase()).toContain('mahama');
  });

  it('flags sensitive queries', () => {
    expect(buildHeuristicPlan('Accra market fire victims').sensitive).toBe(true);
    expect(buildHeuristicPlan('Bank of Ghana').sensitive).toBe(false);
  });
});

describe('filterByExcludeTerms', () => {
  it('drops results whose title or author matches an exclude term', () => {
    const results = [
      fakeResult('DVLA Swansea headquarters'),
      fakeResult('Driver and Vehicle Licensing Authority Accra'),
      fakeResult('Old car', 'photo by DVLA Dundee office'),
    ];
    const kept = filterByExcludeTerms(results, ['Swansea', 'Dundee', 'United Kingdom']);
    expect(kept).toHaveLength(1);
    expect(kept[0].title).toContain('Accra');
  });

  it('returns everything when there are no exclude terms', () => {
    const results = [fakeResult('a'), fakeResult('b')];
    expect(filterByExcludeTerms(results, [])).toHaveLength(2);
  });
});
