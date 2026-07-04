import { isAllOfTheAbove, pinAllOfTheAboveLast, pinnedIndex1Based } from './all-of-the-above';

describe('isAllOfTheAbove', () => {
  it('matches plain text', () => {
    expect(isAllOfTheAbove('All of the above')).toBe(true);
    expect(isAllOfTheAbove('all of the above')).toBe(true);
  });

  it('ignores trailing punctuation, HTML and extra whitespace', () => {
    expect(isAllOfTheAbove('All of the above.')).toBe(true);
    expect(isAllOfTheAbove('<b>All of the above</b>')).toBe(true);
    expect(isAllOfTheAbove('  All   of the   above  ')).toBe(true);
    expect(isAllOfTheAbove('All of the above&nbsp;')).toBe(true);
  });

  it('rejects non-matches', () => {
    expect(isAllOfTheAbove('None of the above')).toBe(false);
    expect(isAllOfTheAbove('All of these')).toBe(false);
    expect(isAllOfTheAbove('')).toBe(false);
    expect(isAllOfTheAbove(null)).toBe(false);
    expect(isAllOfTheAbove(undefined)).toBe(false);
  });
});

describe('pinAllOfTheAboveLast', () => {
  const get = (o: { text: string }) => o.text;

  it('moves AOTA to the end, preserving other order', () => {
    const items = [{ text: 'A' }, { text: 'All of the above' }, { text: 'B' }, { text: 'C' }];
    expect(pinAllOfTheAboveLast(items, get).map(get)).toEqual(['A', 'B', 'C', 'All of the above']);
  });

  it('is idempotent (already-last stays put, no churn)', () => {
    const items = [{ text: 'A' }, { text: 'B' }, { text: 'All of the above' }];
    const once = pinAllOfTheAboveLast(items, get);
    const twice = pinAllOfTheAboveLast(once, get);
    expect(twice.map(get)).toEqual(['A', 'B', 'All of the above']);
  });

  it('returns the input unchanged when there is no AOTA', () => {
    const items = [{ text: 'A' }, { text: 'B' }];
    expect(pinAllOfTheAboveLast(items, get)).toBe(items);
  });

  it('handles empty / single-item arrays', () => {
    expect(pinAllOfTheAboveLast([], get)).toEqual([]);
    const single = [{ text: 'All of the above' }];
    expect(pinAllOfTheAboveLast(single, get)).toBe(single);
  });
});

describe('pinnedIndex1Based', () => {
  const get = (o: { text: string }) => o.text;

  it('maps a shuffled AOTA position to its pinned (last) position', () => {
    // Shuffled order: AOTA is at canonical Option 2; pinned it becomes Option 4.
    const opts = [{ text: 'X' }, { text: 'All of the above' }, { text: 'Y' }, { text: 'Z' }];
    expect(pinnedIndex1Based(opts, 2, get)).toBe(4);
  });

  it('shifts a non-AOTA option that sat after AOTA up by one', () => {
    const opts = [{ text: 'X' }, { text: 'All of the above' }, { text: 'Y' }, { text: 'Z' }];
    // Y is canonical Option 3, pinned Option 2 (AOTA moved past it to the end).
    expect(pinnedIndex1Based(opts, 3, get)).toBe(2);
  });

  it('leaves options before AOTA unchanged', () => {
    const opts = [{ text: 'X' }, { text: 'All of the above' }, { text: 'Y' }];
    expect(pinnedIndex1Based(opts, 1, get)).toBe(1);
  });

  it('is a no-op when there is no AOTA or index is out of range', () => {
    const opts = [{ text: 'X' }, { text: 'Y' }, { text: 'Z' }];
    expect(pinnedIndex1Based(opts, 2, get)).toBe(2);
    expect(pinnedIndex1Based(opts, 0, get)).toBe(0);
    expect(pinnedIndex1Based(opts, 9, get)).toBe(9);
  });

  it('AOTA already last stays last (unshuffled case)', () => {
    const opts = [{ text: 'X' }, { text: 'Y' }, { text: 'Z' }, { text: 'All of the above.' }];
    expect(pinnedIndex1Based(opts, 4, get)).toBe(4);
  });
});
