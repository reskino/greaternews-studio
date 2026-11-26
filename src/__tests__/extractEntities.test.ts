import { describe, expect, it } from 'vitest';
import { extractEntities } from '../imageSearch';

describe('extractEntities (headline -> photo subjects)', () => {
  it('puts the quoted speaker first and expands acronyms (NPP is the party, not a power plant)', () => {
    const got = extractEntities("NPP Collapsed all Banks and Women's Bank must not suffer fate of collapsed banks – Hopeson Adorye");
    expect(got[0]).toBe('Hopeson Adorye');
    expect(got).toContain('New Patriotic Party');
    expect(got).not.toContain('NPP Collapsed');
    expect(got.some((entity) => /^Banks?$/.test(entity))).toBe(false); // "banks" also appears in lowercase
  });

  it('keeps ordinary multi-word names', () => {
    expect(extractEntities('Mahama names new acting CEO for Ghana National Petroleum Corporation')).toContain(
      'Ghana National Petroleum Corporation',
    );
  });

  it('expands a standalone acronym', () => {
    expect(extractEntities('GNPC gets a new boss as Mahama reshuffles')).toContain('Ghana National Petroleum Corporation');
  });

  it('still finds a sentence-case name mid-headline', () => {
    expect(extractEntities('Black Stars coach Otto Addo names squad for Mali clash')).toEqual(
      expect.arrayContaining(['Black Stars', 'Otto Addo']),
    );
  });
});
