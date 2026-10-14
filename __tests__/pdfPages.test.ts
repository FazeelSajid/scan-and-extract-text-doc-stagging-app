import {
  extractExpirationDate,
  isConclusiveExtraction,
  pickBestPageExtraction,
} from '../src/expirationExtractor';
import type { MlKitBlock, PageExtraction } from '../src/expirationExtractor';

const NOW = new Date(2026, 9, 13);

function page(pageIndex: number, rows: [string, number][]): PageExtraction {
  const blocks: MlKitBlock[] = [
    { lines: rows.map(([text, top]) => ({ text, frame: { top, left: 50, width: 300, height: 30 } })) },
  ];
  return { ...extractExpirationDate(blocks, { now: NOW }), pageIndex };
}

describe('pickBestPageExtraction', () => {
  test('empty list gives null', () => {
    expect(pickBestPageExtraction([])).toBeNull();
  });

  test('a labelled date on page 2 beats a cover page with no expiry', () => {
    const best = pickBestPageExtraction([
      page(0, [['INSURANCE POLICY', 50], ['Date: 01/10/2026', 100]]),
      page(1, [['Expiry Date: 30/09/2027', 100]]),
    ]);
    expect(best?.pageIndex).toBe(1);
    expect(best?.iso).toBe('2027-09-30');
  });

  test('high confidence on a later page beats low confidence on an earlier one', () => {
    const best = pickBestPageExtraction([
      page(0, [['Renewal reminder', 50], ['15/12/2030', 100]]),
      page(1, [['Valid until 31/12/2027', 100]]),
    ]);
    expect(best?.strategy).toBe('label-same-line');
    expect(best?.pageIndex).toBe(1);
  });

  test('equal confidence: the earlier page wins', () => {
    const best = pickBestPageExtraction([
      page(0, [['EXP 31/12/2028', 100]]),
      page(1, [['EXP 31/12/2029', 100]]),
    ]);
    expect(best?.pageIndex).toBe(0);
  });

  test('equal confidence: an unambiguous date beats an ambiguous one', () => {
    const best = pickBestPageExtraction([
      page(0, [['EXP 05/03/2030', 100]]),
      page(1, [['EXP 25/03/2030', 100]]),
    ]);
    expect(best?.pageIndex).toBe(1);
    expect(best?.ambiguous).toBe(false);
  });

  test('no page has an expiry: returns the first page with strategy none', () => {
    const best = pickBestPageExtraction([
      page(0, [['Receipt', 50], ['Date: 12/10/2026', 100]]),
      page(1, [['Total Rs. 12.30', 100]]),
    ]);
    expect(best?.strategy).toBe('none');
    expect(best?.pageIndex).toBe(0);
  });
});

describe('isConclusiveExtraction', () => {
  test('high and unambiguous stops the page loop', () => {
    expect(isConclusiveExtraction(page(0, [['EXP 31/12/2028', 100]]))).toBe(true);
  });
  test('ambiguous or lower confidence keeps reading', () => {
    expect(isConclusiveExtraction(page(0, [['EXP 05/03/2030', 100]]))).toBe(false);
    expect(isConclusiveExtraction(page(0, [['Expiry', 100], ['31/12/2028', 140]]))).toBe(false);
  });
});
