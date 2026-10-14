/**
 * Expiration-date extraction utilities for ML Kit OCR output.
 *
 * The input is the `blocks` array returned by `@react-native-ml-kit/text-recognition`:
 *   blocks[].lines[].text   — line text
 *   blocks[].lines[].frame  — { top|left|x|y, width, height } bounding box
 *
 * One extractor for every kind of document (ID cards, driving licences,
 * passports, bank cards, certificates, receipts) and every common date style:
 * DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, "15 Mar 2030", "Mar 15, 2030",
 * "15-MAR-2030", "June 2028", bank-card "12/27" and passport MRZ lines.
 *
 * Day-first vs month-first is worked out per document, in this order:
 *   1. evidence — another numeric date on the document has a part above 12
 *                 (e.g. "DOB 25/04/1990" proves the document is day-first)
 *   2. country  — country words: PAKISTAN, UNITED KINGDOM, ... (day-first),
 *                 USA or a US state name (month-first)
 *   3. default  — day-first, which most of the world uses. Dates read this way
 *                 are flagged `ambiguous` so the UI can ask the user.
 *
 * Pipeline (the first stage that finds something wins):
 *   1. mrz             — passport / ID machine-readable zone, check digits verified
 *   2. label-same-line — expiry label and date on one line ("EXP 12/05/2027")
 *   3. lifetime        — the expiry label says LIFETIME / UNLIMITED / ...
 *   4. label-nearby    — label on its own line; take the value that belongs to it
 *                        (the nearest line that isn't closer to an issue/birth label)
 *   5. fallback-score  — no label: the best future date on an unlabelled line
 *   6. none            — nothing plausible (receipts, certificates, ...)
 */

export type MlKitFrame = {
  top?: number;
  left?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};
export type MlKitLine = { text: string; frame?: MlKitFrame };
export type MlKitBlock = { lines?: MlKitLine[] };

export type DateOrder = 'DMY' | 'MDY';
export type DateOrderSource = 'evidence' | 'country' | 'default' | 'option';
export type DatePrecision = 'day' | 'month';

export type ParsedDate = {
  year: number;
  month: number;
  day: number;
  raw: string;
  /** 'month' for month/year-only dates such as bank cards; `day` is then the last day of that month. */
  precision: DatePrecision;
  /** True when a numeric date reads validly as both D/M and M/D and the document gave no clue which. */
  ambiguous: boolean;
  /** The other reading of an ambiguous date. */
  alternative?: { year: number; month: number; day: number };
};

export type ExtractOptions = {
  /** Reference "today". Defaults to the current date; pass a fixed date in tests. */
  now?: Date;
  /** Force a date order. Normally leave this unset so it is detected from the document. */
  dateOrder?: DateOrder;
};

export type ExpirationStrategy =
  | 'mrz'
  | 'label-same-line'
  | 'lifetime'
  | 'label-nearby'
  | 'fallback-score'
  | 'none';

export type ExpirationConfidence = 'high' | 'medium' | 'low';

export type ExpirationExtraction = {
  date: ParsedDate | null;
  /** YYYY-MM-DD, or null when no date was found or the document never expires. */
  iso: string | null;
  /** Unambiguous text for the UI: "05 Mar 2036", "Dec 2027" or "Lifetime". */
  display: string | null;
  sourceLine: string | null;
  strategy: ExpirationStrategy;
  /** high: MRZ or label on the same line; medium: nearby label; low: no label. Null when nothing was found. */
  confidence: ExpirationConfidence | null;
  /** True when the document says it never expires (LIFETIME, UNLIMITED, ...). */
  noExpiry: boolean;
  /** True when the date could also be read the other way round. Show both readings to the user. */
  ambiguous: boolean;
  /** The other reading of an ambiguous date, as YYYY-MM-DD. */
  alternativeIso: string | null;
  dateOrder: DateOrder;
  dateOrderSource: DateOrderSource;
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function getFrameTop(frame?: MlKitFrame): number {
  return frame?.top ?? frame?.y ?? 0;
}

export function getFrameLeft(frame?: MlKitFrame): number {
  return frame?.left ?? frame?.x ?? 0;
}

export function getMlKitLinesTopToBottom(blocks: MlKitBlock[]): MlKitLine[] {
  return blocks
    .flatMap(block => block.lines ?? [])
    .sort((a, b) => {
      const topDiff = getFrameTop(a.frame) - getFrameTop(b.frame);
      return topDiff !== 0
        ? topDiff
        : getFrameLeft(a.frame) - getFrameLeft(b.frame);
    });
}

/**
 * Distances between lines are measured in "line units" (the median text
 * height in the image), so a 4000px phone photo and a 600px crop of the same
 * card give the same answer. Without heights we fall back to 30px, which
 * matches the fixed thresholds this file used before.
 */
const FALLBACK_LINE_UNIT = 30;
/** Two lines are on the same row when their vertical centres are this close. */
const SAME_ROW_CENTER_UNITS = 0.5;
const SPLIT_LABEL_UNITS = 1.4;
const NEARBY_UNITS = 5;
const MAX_COLUMN_OFFSET_UNITS = 12;

function getLineUnit(lines: MlKitLine[]): number {
  const heights = lines
    .map(l => l.frame?.height ?? 0)
    .filter(h => h > 0)
    .sort((a, b) => a - b);
  if (heights.length === 0) return FALLBACK_LINE_UNIT;
  const mid = Math.floor(heights.length / 2);
  return heights.length % 2
    ? heights[mid]
    : (heights[mid - 1] + heights[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const MONTH_NAMES: Record<string, number> = {
  // English
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
  // Spanish (Puerto Rico / Latin America IDs)
  ene: 1, enero: 1, febrero: 2, marzo: 3, abr: 4, abril: 4, mayo: 5,
  junio: 6, julio: 7, ago: 8, agosto: 8, septiembre: 9, setiembre: 9,
  octubre: 10, noviembre: 11, dic: 12, diciembre: 12,
  // Portuguese
  janeiro: 1, fevereiro: 2, março: 3, marco: 3, maio: 5, junho: 6,
  julho: 7, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  // French (bilingual passports print e.g. "MAR /MARS")
  janv: 1, janvier: 1, fev: 2, fév: 2, fevr: 2, févr: 2, fevrier: 2,
  février: 2, mars: 3, avr: 4, avril: 4, mai: 5, juin: 6, juil: 7,
  juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11,
  decembre: 12, décembre: 12,
  // German
  jän: 1, januar: 1, februar: 2, mrz: 3, märz: 3, maerz: 3, juni: 6,
  juli: 7, okt: 10, oktober: 10, dez: 12, dezember: 12,
};

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Words that mark a line as the "expiry" label. Multi-word phrases come first
// so they win over the bare "EXP" match.
export const EXPIRY_LABEL_REGEXES: RegExp[] = [
  /\bex?pirat(ion|e|i)?\s*dat/i,
  /\bex?rat(ion|e|i)?\s*dat/i,
  /\bdats?\s+of\s+expirat/i,
  /\bdate\s*of\s*exp(iry|iration|iration\s*date|\.)?\b/i,
  /\bdate\s+o[xk]p\b/i,
  /\bexp(iry|iration|\.)?\s*date\b/i,
  /\bvalid\s*from\b.*?\bto\b/i,
  /\bvalid\s*(thru|through|until|till|to|up\s*to|upto)\b/i,
  /\bvalidity\b/i,
  /\bvalidade\b/i,
  /\bgood\s*(thru|through|until|till)\b/i,
  /\bcard\s*expires?\b/i,
  /\bexpires+\b/i,
  /\bexpires?\s*(on)?\b/i,
  /\bexpiration\b/i,
  /\bexpiry\b/i,
  /\b(best\s*before|best\s*by|use\s*by)\b/i,
  /\brenew(al)?\s*(date|due|by|on)\b/i,
  /\b(vence|vencimiento|vencimento|caduca|caducidad)\b/i,
  /\bf(echa)?\.?\s*(de\s*)?venc/i,
  /\bvalable\s*jusqu/i,
  /\bfin\s*de\s*validit/i,
  /\bg[uü]ltig\s*bis\b/i,
  /\bablaufdatum\b/i,
  /\bexp(?=\d)/i,
  /\bexp[a-z](?=\d)/i,
  /\b[eE][dD](?=\s*\d)/i,
  /\b4b\s*exp/i,
  /\b4b\b\.?(?=\s*\d)/i,
  /\dexp\b/i,
  /\bexp\.?\b/i,
];

// Words that mark a date as NOT the expiry (birth, issue, transaction dates).
export const NEGATIVE_LABEL_REGEXES: RegExp[] = [
  /\b(date\s*of\s*birth|dob|born|birth\s*date)\b/i,
  /\bd\.\s*o\.\s*b\b/i,
  /\b(date\s*of\s*issue|issued|issue\s*date|issued\s*on)\b/i,
  /\b[i1l]?sue\b/i,
  /\b(issue|iss\.?|cae)\s*dat/i,
  /\b[i1l]ssue\s*dat/i,
  /\biss\/?emi/i,
  /\b[i1]ss\b/i,
  /\b4a\b/i,
  /\biss\b/i,
  /\b(from|issued\s*on|valid\s*from)\b/i,
  /\b(issuance|date\s*of\s*(registration|enrol?ment|admission|award|completion|joining|payment|purchase))\b/i,
  /\b(invoice|bill|billing|receipt|transaction|txn|order|payment|purchase|statement)\s*(date|dt)\b/i,
  /\b(paid|printed|generated|enrolled|registered|awarded|conferred)\s*(on|date)\b/i,
  // A bare "Date:" is the transaction / issue date on receipts and certificates.
  /(^|\s)dated?\s*[:\-]/i,
  /\b(fecha\s*de\s*)?(nacimiento|expedici[oó]n|emisi[oó]n)\b/i,
  /\b(naissance|d[ée]livr)/i,
  /\b(geburtsdatum|ausstellungsdatum|ausgestellt)\b/i,
];

/** Wording for documents that never expire (e.g. lifetime CNICs). */
const LIFETIME_REGEX =
  /\b(life\s*-?\s*time|life\s*long|unlimited|indefinite(ly)?|no\s*expiry|no\s*expiration|non[\s-]*expiring|does\s*not\s*expire|never\s*expires?|vitalici[oa]|unbefristet)\b|\billimit/i;
/** "Permanent" is only trusted right after an expiry label ("Permanent Address" / "Permanent Resident" are not). */
const PERMANENT_REGEX = /\bpermanente?\b/i;

/** Month-first countries. Matching any of these makes MM/DD the reading for ambiguous dates. */
const MDY_COUNTRY_REGEX =
  /\b(USA|UNITED\s+STATES|DRIVER'?S?\s+LICENSE|STATE\s+OF\s+[A-Z]|DEPARTMENT\s+OF\s+(MOTOR|PUBLIC\s+SAFETY|TRANSPORTATION)|DMV|REAL\s*ID|PERMANENT\s+RESIDENT|ALABAMA|ALASKA|ARIZONA|ARKANSAS|CALIFORNIA|COLORADO|CONNECTICUT|DELAWARE|FLORIDA|HAWAII|IDAHO|ILLINOIS|INDIANA|IOWA|KANSAS|KENTUCKY|LOUISIANA|MAINE|MARYLAND|MASSACHUSETTS|MICHIGAN|MINNESOTA|MISSISSIPPI|MISSOURI|MONTANA|NEBRASKA|NEVADA|NEW\s+HAMPSHIRE|NEW\s+JERSEY|NEW\s+MEXICO|NEW\s+YORK|NORTH\s+CAROLINA|NORTH\s+DAKOTA|OHIO|OKLAHOMA|OREGON|PENNSYLVANIA|RHODE\s+ISLAND|SOUTH\s+CAROLINA|SOUTH\s+DAKOTA|TENNESSEE|TEXAS|UTAH|VERMONT|VIRGINIA|WASHINGTON|WISCONSIN|WYOMING|PUERTO\s+RICO|DISTRICT\s+OF\s+COLUMBIA)\b/i;

/** Day-first countries and spellings. */
const DMY_COUNTRY_REGEX =
  /\b(PAKISTAN|NADRA|ISLAMIC\s+REPUBLIC|INDIA|BHARAT|BANGLADESH|SRI\s+LANKA|NEPAL|AFGHANISTAN|UNITED\s+KINGDOM|GREAT\s+BRITAIN|DVLA|EUROPEAN\s+UNION|UNITED\s+ARAB\s+EMIRATES|SAUDI|QATAR|KUWAIT|OMAN|BAHRAIN|EGYPT|TURKEY|AUSTRALIA|NEW\s+ZEALAND|SOUTH\s+AFRICA|NIGERIA|KENYA|MALAYSIA|SINGAPORE|INDONESIA|IRELAND|FRANCE|GERMANY|DEUTSCHLAND|ITALIA|ITALY|SPAIN|PORTUGAL|BRASIL|BRAZIL|MEXICO|LICENCE)\b/i;

// ---------------------------------------------------------------------------
// Date patterns. Tried in this order on each line; matched text is blanked
// out so a later, looser pattern can't re-read part of it.
// ---------------------------------------------------------------------------

const LETTER = 'A-Za-z\\u00C0-\\u00FF';

/** 2030-03-15, 2030/03/15, 2030.03.15 */
const YMD_DATE_REGEX = /\b((?:19|20)\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?!\d)/g;
/** 15 MAR 2030, 15-Mar-2030, 15/MAR/30, 14NOV2014, 5th June 2028, 15 MAR /MARS 2030 */
const D_MON_Y_REGEX = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-\\/.]*([${LETTER}]{3,9})\\.?(?:\\s*\\/\\s*[${LETTER}]{3,9}\\.?)?[\\s\\-\\/.,]*((?:19|20)\\d{2}|\\d{2})(?!\\d)`,
  'g',
);
/** MAR 15 2030, March 15, 2030 (4-digit year required, so "DEC 2027" is never read as DEC 20 '27) */
const MON_D_Y_REGEX = new RegExp(
  `\\b([${LETTER}]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+((?:19|20)\\d{2})(?!\\d)`,
  'g',
);
/** 15/03/2030, 03-15-2030, 15.03.30 — day/month order decided per document */
const NUMERIC_DATE_REGEX = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/g;
/** 12/27, 12/2027, 12.2027 — a dot is only accepted with a 4-digit year, so prices like 2.50 aren't dates */
const NUMERIC_MONTH_YEAR_REGEX = /(\d{1,2})(?:[\/\-](\d{4}|\d{2})|\.((?:19|20)\d{2}))(?!\d)/g;
/** June 2028, DEC 2027, Dec-2027 */
const ALPHA_MONTH_YEAR_REGEX = new RegExp(
  `\\b([${LETTER}]{3,9})\\.?[\\s\\-\\/,]*((?:19|20)\\d{2})(?!\\d)`,
  'g',
);

/** Runs a global regex; when `onMatch` returns false the search resumes one character later. */
function scan(
  source: string,
  re: RegExp,
  onMatch: (m: RegExpExecArray) => boolean,
): void {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = r.exec(source))) {
    const consumed = onMatch(m);
    if (!consumed) r.lastIndex = m.index + 1;
    else if (m[0].length === 0) r.lastIndex++;
  }
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function makeDate(
  year: number,
  month: number,
  day: number,
  raw: string,
  precision: DatePrecision,
): ParsedDate | null {
  if (year < 1900 || year > 2200) return null;
  if (month < 1 || month > 12) return null;
  const dayValue = precision === 'month' ? daysInMonth(year, month) : day;
  if (dayValue < 1 || dayValue > daysInMonth(year, month)) return null;
  return { year, month, day: dayValue, raw, precision, ambiguous: false };
}

function expandYear(yearStr: string): number | null {
  if (yearStr.length === 3) return null;
  const year = parseInt(yearStr, 10);
  if (yearStr.length === 2) return year + (year >= 70 ? 1900 : 2000);
  return year;
}

/** Fix common OCR confusions in month tokens (e.g. "0CT" where O was read as zero). */
export function normalizeOcrMonthToken(token: string): string {
  if (token.length >= 3 && token[0] === '0') {
    const fixed = `O${token.slice(1)}`;
    if (MONTH_NAMES[fixed.toLowerCase()]) return fixed;
  }
  return token;
}

function resolveMonthToken(token: string): number | undefined {
  return MONTH_NAMES[normalizeOcrMonthToken(token).toLowerCase()];
}

/** a/b could be a day and a month in some order. */
function isDayMonthPair(a: number, b: number): boolean {
  return (a >= 1 && a <= 12 && b >= 1 && b <= 31) || (a >= 1 && a <= 31 && b >= 1 && b <= 12);
}

/** Normalize OCR text so the date regexes can match misread dates. */
export function normalizeOcrForDateParsing(text: string): string {
  return text
    // Unicode dashes and slashes -> ASCII
    .replace(/[‐-―−－]/g, '-')
    .replace(/[⁄∕／]/g, '/')
    // OCR drops the first separator (0504/2027 -> 05/04/2027). A leading 19/20
    // is a year range like "2012-2016", so it is left alone.
    .replace(
      /(\D|^)(\d{2})(\d{2})([\/\-\.]\d{4}\b)/g,
      (match, prefix, a, b, rest) => {
        if (a === '19' || a === '20') return match;
        return isDayMonthPair(parseInt(a, 10), parseInt(b, 10))
          ? `${prefix}${a}/${b}${rest}`
          : match;
      },
    )
    .replace(
      /(\b\d{1,2}\s+)0([A-Za-z]{2,8})(\s+\d{4}\b)/g,
      '$1O$2$3',
    )
    .replace(
      /(\b)0([A-Za-z]{2,8})(\s+\d{1,2}\s+\d{4}\b)/g,
      '$1O$2$3',
    )
    .replace(
      /(\d{1,2}[\/\-\.]\d{1,2})[lI|](\d{4}\b)/g,
      '$1/$2',
    )
    // OCR inserts spurious digit between MMDD before /YYYY (e.g. 01112/2022 -> 01/12/2022).
    .replace(
      /(\d{2})\d(\d{2})([\/\-\.]\d{4}\b)/g,
      '$1/$2$3',
    )
    // OCR drops slash and trailing year digit (e.g. 01/07203 -> 01/07/2030).
    .replace(
      /(\d{2}\/)(\d{2})(\d{3})\b/g,
      (match, first, second, yPart) => {
        const a = parseInt(first, 10);
        const b = parseInt(second, 10);
        const yp = parseInt(yPart, 10);
        if (isDayMonthPair(a, b) && yp >= 200 && yp <= 209) {
          return `${first}${second}/${yPart}0`;
        }
        return match;
      },
    )
    .replace(/(\bEXP)(\d)/gi, '$1 $2')
    .replace(/(\bISS)(\d)/gi, '$1 $2')
    .replace(/(\bExp)[QO0Il](\d)/gi, '$1 0$2');
}

// ---------------------------------------------------------------------------
// Day-first vs month-first
// ---------------------------------------------------------------------------

type DateContext = { order: DateOrder; source: DateOrderSource };

/**
 * Decide whether ambiguous numeric dates on this document are day-first or
 * month-first. Takes the document's lines (already normalized or raw).
 */
export function detectDateOrder(texts: string[]): DateContext {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const t of texts) {
    const withoutYearFirst = t.replace(
      new RegExp(YMD_DATE_REGEX.source, 'g'),
      m => ' '.repeat(m.length),
    );
    scan(withoutYearFirst, NUMERIC_DATE_REGEX, m => {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (a > 12 && a <= 31 && b >= 1 && b <= 12) dayFirst++;
      else if (b > 12 && b <= 31 && a >= 1 && a <= 12) monthFirst++;
      return true;
    });
  }
  if (dayFirst > monthFirst) return { order: 'DMY', source: 'evidence' };
  if (monthFirst > dayFirst) return { order: 'MDY', source: 'evidence' };

  const all = texts.join(' ');
  const us = MDY_COUNTRY_REGEX.test(all);
  const dm = DMY_COUNTRY_REGEX.test(all.replace(/\bnew\s+mexico\b/gi, ' '));
  if (us && !dm) return { order: 'MDY', source: 'country' };
  if (dm && !us) return { order: 'DMY', source: 'country' };
  return { order: 'DMY', source: 'default' };
}

function parseNumericDate(m: RegExpExecArray, ctx: DateContext): ParsedDate | null {
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  const year = expandYear(m[3]);
  if (year === null) return null;

  const asDayFirst = makeDate(year, b, a, m[0], 'day');
  const asMonthFirst = makeDate(year, a, b, m[0], 'day');
  if (asDayFirst && asMonthFirst) {
    if (a === b) return asDayFirst;
    const primary = ctx.order === 'DMY' ? asDayFirst : asMonthFirst;
    const other = ctx.order === 'DMY' ? asMonthFirst : asDayFirst;
    if (ctx.source !== 'default') return primary;
    return {
      ...primary,
      ambiguous: true,
      alternative: { year: other.year, month: other.month, day: other.day },
    };
  }
  return asDayFirst ?? asMonthFirst;
}

// ---------------------------------------------------------------------------
// Finding dates in a line
// ---------------------------------------------------------------------------

type FoundDate = ParsedDate & { index: number };

/** Public copy of a date without the internal position field. */
function toParsedDate(d: ParsedDate): ParsedDate {
  const out: ParsedDate = {
    year: d.year,
    month: d.month,
    day: d.day,
    raw: d.raw,
    precision: d.precision,
    ambiguous: d.ambiguous,
  };
  if (d.alternative) out.alternative = d.alternative;
  return out;
}

function parseDatesInLine(normalized: string, ctx: DateContext): FoundDate[] {
  let s = normalized;
  const out: FoundDate[] = [];
  const blank = (start: number, length: number) => {
    s = s.slice(0, start) + ' '.repeat(length) + s.slice(start + length);
  };
  const add = (d: ParsedDate | null, index: number): boolean => {
    if (!d) return false;
    out.push({ ...d, index });
    return true;
  };

  // 1. Year first: always year-month-day.
  scan(s, YMD_DATE_REGEX, m => {
    add(makeDate(+m[1], +m[2], +m[3], m[0], 'day'), m.index);
    blank(m.index, m[0].length);
    return true;
  });

  // 2. Day, month name, year.
  scan(s, D_MON_Y_REGEX, m => {
    const month = resolveMonthToken(m[2]);
    const year = expandYear(m[3]);
    if (!month || year === null) return false;
    if (!add(makeDate(year, month, +m[1], m[0], 'day'), m.index)) return false;
    blank(m.index, m[0].length);
    return true;
  });

  // 3. Month name, day, year.
  scan(s, MON_D_Y_REGEX, m => {
    const month = resolveMonthToken(m[1]);
    if (!month) return false;
    if (!add(makeDate(+m[3], month, +m[2], m[0], 'day'), m.index)) return false;
    blank(m.index, m[0].length);
    return true;
  });

  // 4. Numeric D/M/Y or M/D/Y.
  scan(s, NUMERIC_DATE_REGEX, m => {
    add(parseNumericDate(m, ctx), m.index);
    blank(m.index, m[0].length);
    return true;
  });

  // 5. Numeric month/year (bank cards).
  scan(s, NUMERIC_MONTH_YEAR_REGEX, m => {
    const after = s.slice(m.index + m[0].length);
    // OCR may leave "=YYYY" after a false M/Y fragment (e.g. "2-01=1971").
    if (/^=\d{4}/.test(after)) return true;
    // Customer IDs like "11-087-0" yield a false M/Y before the next segment.
    if (/^-\d/.test(after)) return true;
    // Mangled long dates like "06/15l2016" (OCR reads / as l).
    if (/^[lI|]\d{4}/.test(after)) return true;
    const year = expandYear(m[2] ?? m[3]);
    if (year !== null) add(makeDate(year, +m[1], 1, m[0], 'month'), m.index);
    blank(m.index, m[0].length);
    return true;
  });

  // 6. Month name and year only.
  scan(s, ALPHA_MONTH_YEAR_REGEX, m => {
    const month = resolveMonthToken(m[1]);
    if (!month) return false;
    if (!add(makeDate(+m[2], month, 1, m[0], 'month'), m.index)) return false;
    blank(m.index, m[0].length);
    return true;
  });

  return out.sort((x, y) => x.index - y.index);
}

/**
 * Parse all dates from one piece of text. Without `dateOrder`, day/month
 * order is detected from the text itself (and defaults to day-first).
 */
export function findDatesInText(text: string, dateOrder?: DateOrder): ParsedDate[] {
  const normalized = normalizeOcrForDateParsing(text);
  const ctx: DateContext = dateOrder
    ? { order: dateOrder, source: 'option' }
    : detectDateOrder([normalized]);
  return parseDatesInLine(normalized, ctx).map(toParsedDate);
}

// ---------------------------------------------------------------------------
// MRZ (passports TD3, visas/IDs TD2, ID cards TD1)
// ---------------------------------------------------------------------------

// Shared by TD1/TD2/TD3: birth date, check digit, sex, expiry date, check digit.
const MRZ_DATES_REGEX = /(\d{6})(\d)([MFX<])(\d{6})(\d)/g;

function mrzCharValue(c: string): number {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55;
  return 0; // '<'
}

/** ICAO 9303 check digit (weights 7, 3, 1). */
export function mrzCheckDigit(value: string): number {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < value.length; i++) {
    sum += mrzCharValue(value[i]) * weights[i % 3];
  }
  return sum % 10;
}

/** Expiry date from MRZ lines, only when both date check digits are correct. */
export function findMrzExpiryDate(
  texts: string[],
  now: Date = new Date(),
): { date: ParsedDate; line: string } | null {
  for (const text of texts) {
    const cleaned = text.toUpperCase().replace(/\s+/g, '').replace(/[«‹]/g, '<');
    if (cleaned.length < 28 || !cleaned.includes('<')) continue;
    if (!/^[A-Z0-9<]+$/.test(cleaned)) continue;
    // OCR reads the MRZ font's 0 as O and 1 as I. Only the digit fields are
    // read below and both check digits must match, so this is safe.
    const digits = cleaned.replace(/O/g, '0').replace(/I/g, '1');
    const re = new RegExp(MRZ_DATES_REGEX.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(digits))) {
      re.lastIndex = m.index + 1; // overlapping matches: retry one character later
      if (mrzCheckDigit(m[1]) !== +m[2] || mrzCheckDigit(m[4]) !== +m[5]) continue;
      let year = 2000 + +m[4].slice(0, 2);
      if (year > now.getFullYear() + 50) year -= 100;
      const d = makeDate(year, +m[4].slice(2, 4), +m[4].slice(4, 6), m[4], 'day');
      if (d) return { date: d, line: text };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function yearsFromNow(d: ParsedDate, now: Date): number {
  const ms = new Date(d.year, d.month - 1, d.day).getTime() - now.getTime();
  return ms / (1000 * 60 * 60 * 24 * 365.25);
}

function isLikelyNotExpiration(d: ParsedDate, now: Date): boolean {
  // Expiration dates for IDs/cards are within ~20 years. Bank cards ~5y,
  // DL 4-8y, passport 10y. If the date is more than 25y out it's almost
  // certainly not what we want.
  const yearsOut = yearsFromNow(d, now);
  if (yearsOut > 25) return true;
  if (yearsOut < -100) return true;
  return false;
}

function scoreDateCandidate(
  d: ParsedDate,
  now: Date,
  nearbyHasNegativeLabel: boolean,
  nearbyHasExpiryLabel: boolean,
): number {
  let score = 0;
  const yearsOut = yearsFromNow(d, now);

  if (yearsOut >= 0 && yearsOut <= 12) score += 50;
  else if (yearsOut > 12 && yearsOut <= 25) score += 20;
  else if (yearsOut < 0 && yearsOut >= -1) score += 5;
  else if (yearsOut < -1) score -= 30;

  if (nearbyHasExpiryLabel) score += 80;
  if (nearbyHasNegativeLabel) score -= 60;

  return score;
}

/** Higher score wins; then a full date over month/year; then the later date (ranges like "01/2025 - 12/2026"). */
function isBetterDateCandidate(
  d: ParsedDate,
  score: number,
  best: ParsedDate | null,
  bestScore: number,
): boolean {
  if (!best || score > bestScore) return true;
  if (score < bestScore) return false;
  const dFull = d.precision === 'day';
  const bFull = best.precision === 'day';
  if (dFull && !bFull) return true;
  if (!dFull && bFull) return false;
  return (
    d.year > best.year ||
    (d.year === best.year && d.month > best.month) ||
    (d.year === best.year && d.month === best.month && d.day > best.day)
  );
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export function isExpiryLabel(text: string): boolean {
  return EXPIRY_LABEL_REGEXES.some(r => r.test(text));
}

export function isNegativeLabel(text: string): boolean {
  return NEGATIVE_LABEL_REGEXES.some(r => r.test(text));
}

/** OCR merges THRU/VALID glyphs with MM/YY on bank cards (e.g. "%01/09"). */
export function isImpliedCardExpiryLine(text: string): boolean {
  const t = text.trim();
  if (/^[^A-Za-z0-9]{0,3}\d{1,2}[\/\-\.]\d{2,4}$/.test(t)) return true;
  if (/^(thru|valid|good)\W*\d{1,2}[\/\-\.]\d{2,4}$/i.test(t)) return true;
  return false;
}

function hasCardContext(hits: { text: string }[]): boolean {
  const all = hits.map(h => h.text).join(' ');
  if (/\b(visa|mastercard|amex|discover|debit|credit\s*card|reliacard|unionpay|paypak)\b/i.test(all)) {
    return true;
  }
  // 16-digit card number (first group may lose a digit to OCR) or Amex 4-6-5.
  if (/\b\d{3,4}(?:\s+\d{4}){3}\b/.test(all)) return true;
  if (/\b\d{4}\s+\d{6}\s+\d{5}\b/.test(all)) return true;
  return false;
}

/** OCR often splits "VALID THRU" across two lines on bank cards. */
function splitLabelToken(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z]/g, '');
}

export function isValidThruSplitPair(a: string, b: string): boolean {
  const tokens = [a, b].map(splitLabelToken);
  const hasThru = tokens.some(
    t => t === 'thru' || t === 'through' || t.startsWith('thru'),
  );
  if (!hasThru) return false;
  return tokens.some(t => t === 'valid' || t.startsWith('valid')) ||
    tokens.some(t => t === 'good' || t.startsWith('good'));
}

type LabelSpan = { start: number; end: number; kind: 'expiry' | 'negative' };

function findAllSpans(text: string, regexes: RegExp[], kind: LabelSpan['kind']): LabelSpan[] {
  const spans: LabelSpan[] = [];
  for (const r of regexes) {
    const flags = r.flags.includes('g') ? r.flags : `${r.flags}g`;
    for (const m of text.matchAll(new RegExp(r.source, flags))) {
      spans.push({ start: m.index!, end: m.index! + m[0].length, kind });
    }
  }
  return spans;
}

/**
 * Label positions in a line. A negative label that overlaps an expiry label is
 * part of it ("Expiry Date:" contains "Date:"), so it is dropped.
 */
function getLabelSpans(text: string): LabelSpan[] {
  const expiry = findAllSpans(text, EXPIRY_LABEL_REGEXES, 'expiry');
  const negative = findAllSpans(text, NEGATIVE_LABEL_REGEXES, 'negative').filter(
    n => !expiry.some(e => n.start < e.end && e.start < n.end),
  );
  return [...expiry, ...negative];
}

/** Index just past the last expiry-label match in the line, or -1 if none. */
export function getExpiryMarkerEnd(text: string): number {
  let end = -1;
  for (const s of findAllSpans(text, EXPIRY_LABEL_REGEXES, 'expiry')) {
    end = Math.max(end, s.end);
  }
  return end;
}

export function isDateAfterExpiryMarker(text: string, dateRaw: string): boolean {
  const normalized = normalizeOcrForDateParsing(text);
  const markerEnd = getExpiryMarkerEnd(normalized);
  if (markerEnd < 0) return true;
  const dateIdx = normalized.indexOf(dateRaw);
  if (dateIdx >= 0) return dateIdx >= markerEnd;
  return text.indexOf(dateRaw) >= markerEnd;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

export function formatIso(d: { year: number; month: number; day: number }): string {
  const mm = String(d.month).padStart(2, '0');
  const dd = String(d.day).padStart(2, '0');
  return `${d.year}-${mm}-${dd}`;
}

/** Unambiguous text for the UI: "05 Mar 2036", or "Mar 2036" for month/year dates. */
export function formatDisplay(d: ParsedDate): string {
  const month = MONTH_ABBR[d.month - 1];
  if (d.precision === 'month') return `${month} ${d.year}`;
  return `${String(d.day).padStart(2, '0')} ${month} ${d.year}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

type LineHit = {
  line: MlKitLine;
  text: string;
  norm: string;
  top: number;
  left: number;
  dates: FoundDate[];
  expiry: boolean;
  negative: boolean;
  lifetime: boolean;
};

function markSplitExpiryLabels(hits: LineHit[], unit: number): void {
  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const h1 = hits[i];
      const h2 = hits[j];
      if (Math.abs(h1.top - h2.top) > SPLIT_LABEL_UNITS * unit) continue;
      if (isValidThruSplitPair(h1.text, h2.text)) {
        h1.expiry = true;
        h2.expiry = true;
      }
    }
  }
}

function markImpliedCardExpiryLines(hits: LineHit[], cardContext: boolean): void {
  if (!cardContext) return;
  for (const h of hits) {
    if (!h.expiry && isImpliedCardExpiryLine(h.text)) {
      h.expiry = true;
    }
  }
}

/**
 * How strongly a value belongs to a label (smaller = closer), or null when
 * it's out of reach. Same row to the right is preferred, then directly
 * below; values above the label are allowed but penalised.
 *
 * Rows are compared by vertical centre, not top edge: on compact ID cards the
 * value sits right under its label (less than one line height between the
 * tops), and a small label above a bigger bold value must still count as
 * "below", not "same row".
 */
type Spot = { top: number; left: number; height: number };
function labelToValueDistance(label: Spot, value: Spot, unit: number): number | null {
  const labelCenter = label.top + (label.height || unit) / 2;
  const valueCenter = value.top + (value.height || unit) / 2;
  const dy = (valueCenter - labelCenter) / unit;
  const dx = (value.left - label.left) / unit;
  if (Math.abs(dy) < SAME_ROW_CENTER_UNITS) return dx > 0 ? dx * 0.1 : null;
  if (Math.abs(dx) > MAX_COLUMN_OFFSET_UNITS) return null;
  if (dy > 0 && dy < NEARBY_UNITS) return dy + Math.abs(dx) * 0.5;
  if (dy < 0 && -dy < NEARBY_UNITS) return 1 + -dy * 2 + Math.abs(dx) * 0.5;
  return null;
}

export function extractExpirationDate(
  blocks: MlKitBlock[],
  options: ExtractOptions = {},
): ExpirationExtraction {
  const now = options.now ?? new Date();
  const lines = getMlKitLinesTopToBottom(blocks);
  const unit = getLineUnit(lines);
  const norms = lines.map(l => normalizeOcrForDateParsing(l.text ?? ''));
  const ctx: DateContext = options.dateOrder
    ? { order: options.dateOrder, source: 'option' }
    : detectDateOrder(norms);

  const hits: LineHit[] = lines.map((line, i) => {
    const text = line.text ?? '';
    return {
      line,
      text,
      norm: norms[i],
      top: getFrameTop(line.frame),
      left: getFrameLeft(line.frame),
      dates: parseDatesInLine(norms[i], ctx),
      expiry: isExpiryLabel(text),
      negative: isNegativeLabel(text),
      lifetime: LIFETIME_REGEX.test(text),
    };
  });
  const cardContext = hasCardContext(hits);
  markSplitExpiryLabels(hits, unit);
  markImpliedCardExpiryLines(hits, cardContext);

  const base = { dateOrder: ctx.order, dateOrderSource: ctx.source };
  const found = (
    d: ParsedDate,
    sourceLine: string,
    strategy: ExpirationStrategy,
    confidence: ExpirationConfidence,
  ): ExpirationExtraction => {
    const date = toParsedDate(d);
    return {
      date,
      iso: formatIso(date),
      display: formatDisplay(date),
      sourceLine,
      strategy,
      confidence,
      noExpiry: false,
      ambiguous: date.ambiguous,
      alternativeIso: date.alternative ? formatIso(date.alternative) : null,
      ...base,
    };
  };
  const lifetime = (sourceLine: string, confidence: ExpirationConfidence): ExpirationExtraction => ({
    date: null,
    iso: null,
    display: 'Lifetime',
    sourceLine,
    strategy: 'lifetime',
    confidence,
    noExpiry: true,
    ambiguous: false,
    alternativeIso: null,
    ...base,
  });

  // Stage 1: machine-readable zone (passports, many ID cards).
  const mrz = findMrzExpiryDate(lines.map(l => l.text ?? ''), now);
  if (mrz) return found(mrz.date, mrz.line, 'mrz', 'high');

  // Stage 2: expiry label and date on the same line. Each date belongs to the
  // label just before it, so "ISS 01/03/2026 EXP 31/03/2036" picks the EXP date.
  for (const h of hits) {
    if (!h.expiry || h.dates.length === 0) continue;
    const spans = getLabelSpans(h.norm);
    const ownedByExpiry = h.dates.filter(d => {
      let owner: LabelSpan | null = null;
      for (const s of spans) {
        if (s.end <= d.index && (!owner || s.end > owner.end)) owner = s;
      }
      return owner?.kind === 'expiry';
    });
    const hasNegativeSpan = spans.some(s => s.kind === 'negative');
    // Dates before any label only count when no issue/birth label is on the line
    // (e.g. "%01/09" on a bank card, or "12/05/2027 EXP").
    const candidates = ownedByExpiry.length > 0 ? ownedByExpiry : hasNegativeSpan ? [] : h.dates;
    let best: FoundDate | null = null;
    let bestScore = -Infinity;
    for (const d of candidates) {
      if (isLikelyNotExpiration(d, now)) continue;
      const s = scoreDateCandidate(d, now, false, true);
      if (isBetterDateCandidate(d, s, best, bestScore)) {
        best = d;
        bestScore = s;
      }
    }
    if (best && bestScore > 0) return found(best, h.text, 'label-same-line', 'high');
  }

  // Stage 3: "Date of Expiry: LIFETIME" on the label line itself.
  for (const h of hits) {
    if (!h.expiry) continue;
    const firstLabel = findAllSpans(h.norm, EXPIRY_LABEL_REGEXES, 'expiry')
      .sort((a, b) => a.start - b.start)[0];
    const rest = firstLabel ? h.norm.slice(firstLabel.end) : h.norm;
    if (LIFETIME_REGEX.test(rest) || PERMANENT_REGEX.test(rest)) {
      return lifetime(h.text, 'high');
    }
  }

  // Stage 4: label on its own line. Every value is assigned to its closest
  // label; values that belong to an issue/birth label are never used.
  //
  // ML Kit often merges a row into one line ("Date of Issue   Date of Expiry"
  // or "15.03.2026   15.03.2036" on a CNIC). Such lines are split into pieces
  // at each label / each date, and each piece gets an estimated left position
  // from where it sits in the text, so the columns can still be matched.
  type LabelPiece = Spot & { expiry: boolean; negative: boolean };
  type DatePiece = Spot & { date: FoundDate };
  const charLeft = (h: LineHit, index: number): number => {
    const width = h.line.frame?.width ?? 0;
    const len = h.norm.length;
    return width > 0 && len > 0 ? h.left + (width * index) / len : h.left;
  };

  const labelPieces: LabelPiece[] = [];
  for (const h of hits) {
    if (!h.expiry && !h.negative) continue;
    const spans = getLabelSpans(h.norm).sort((a, b) => a.start - b.start);
    const mixed = spans.some(s => s.kind === 'expiry') && spans.some(s => s.kind === 'negative');
    if (mixed && (h.line.frame?.width ?? 0) > 0) {
      // Merge overlapping or consecutive spans of one kind into a region:
      // "date of issue" and "issue dat" (from Albanian "data") are one label.
      const regions: { start: number; end: number; kind: LabelSpan['kind'] }[] = [];
      for (const s of spans) {
        const last = regions[regions.length - 1];
        if (last && last.kind === s.kind) last.end = Math.max(last.end, s.end);
        else regions.push({ ...s });
      }
      // Each column starts where the previous label's text ends (at a word
      // start), so local-language words before the English label
      // ("data e skadimit/date of expiry") stay in the right column.
      for (let i = 0; i < regions.length; i++) {
        let start = 0;
        if (i > 0) {
          start = regions[i - 1].end;
          while (start > 0 && /\S/.test(h.norm[start - 1]) && /\S/.test(h.norm[start] ?? ' ')) start--;
          while (start < h.norm.length && /\s/.test(h.norm[start])) start++;
        }
        labelPieces.push({
          top: h.top,
          height: h.line.frame?.height ?? 0,
          left: charLeft(h, start),
          expiry: regions[i].kind === 'expiry',
          negative: regions[i].kind === 'negative',
        });
      }
    } else {
      labelPieces.push({
        top: h.top,
        height: h.line.frame?.height ?? 0,
        left: h.left,
        expiry: h.expiry,
        negative: h.negative,
      });
    }
  }

  const ownerOfSpot = (spot: Spot): { label: LabelPiece; distance: number } | null => {
    let best: { label: LabelPiece; distance: number } | null = null;
    for (const l of labelPieces) {
      const distance = labelToValueDistance(l, spot, unit);
      if (distance === null) continue;
      if (!best || distance < best.distance) best = { label: l, distance };
    }
    return best;
  };

  const values = hits.filter(
    h => !h.expiry && !h.negative && (h.dates.length > 0 || h.lifetime),
  );
  // Owner of every date on a value line (one piece per date).
  const dateOwner = new Map<FoundDate, { label: LabelPiece; distance: number } | null>();
  const lineOwner = new Map<LineHit, { label: LabelPiece; distance: number } | null>();
  for (const v of values) {
    const vHeight = v.line.frame?.height ?? 0;
    lineOwner.set(v, ownerOfSpot({ top: v.top, left: v.left, height: vHeight }));
    const split = v.dates.length > 1 && (v.line.frame?.width ?? 0) > 0;
    for (const d of v.dates) {
      const piece: DatePiece = {
        top: v.top,
        height: vHeight,
        left: split ? charLeft(v, d.index) : v.left,
        date: d,
      };
      dateOwner.set(d, ownerOfSpot(piece));
    }
  }

  let nearby: { value: LineHit; distance: number; date: FoundDate | null; score: number } | null = null;
  for (const v of values) {
    let date: FoundDate | null = null;
    let score = -Infinity;
    let distance = Infinity;
    for (const d of v.dates) {
      const owner = dateOwner.get(d);
      if (!owner || !owner.label.expiry) continue;
      if (isLikelyNotExpiration(d, now)) continue;
      // More than 15 years ago is a birth date that drifted near the label.
      if (yearsFromNow(d, now) < -15) continue;
      const s = scoreDateCandidate(d, now, false, true);
      distance = Math.min(distance, owner.distance);
      if (isBetterDateCandidate(d, s, date, score)) {
        date = d;
        score = s;
      }
    }
    if (!date) {
      const owner = lineOwner.get(v);
      if (!(v.lifetime && v.dates.length === 0 && owner?.label.expiry)) continue;
      distance = owner.distance;
    }
    const better =
      !nearby ||
      distance < nearby.distance ||
      (distance === nearby.distance && score > nearby.score);
    if (better) nearby = { value: v, distance, date, score };
  }
  if (nearby) {
    return nearby.date
      ? found(nearby.date, nearby.value.text, 'label-nearby', 'medium')
      : lifetime(nearby.value.text, 'medium');
  }

  // Stage 5: no usable label. Only a FUTURE date on an unlabelled line counts,
  // so receipts and certificates (which only carry past dates) return nothing.
  let fallback: FoundDate | null = null;
  let fallbackScore = -Infinity;
  let fallbackSource: string | null = null;
  for (const h of hits) {
    if (h.expiry || h.negative) continue;
    for (const d of h.dates) {
      const owner = dateOwner.get(d);
      if (owner && owner.label.negative && !owner.label.expiry) continue;
      if (d.precision === 'month' && !cardContext) continue;
      const yearsOut = yearsFromNow(d, now);
      if (yearsOut <= 0 || yearsOut > 25) continue;
      const s = scoreDateCandidate(d, now, false, false);
      if (isBetterDateCandidate(d, s, fallback, fallbackScore)) {
        fallback = d;
        fallbackScore = s;
        fallbackSource = h.text;
      }
    }
  }
  if (fallback && fallbackSource !== null) {
    return found(fallback, fallbackSource, 'fallback-score', 'low');
  }

  return {
    date: null,
    iso: null,
    display: null,
    sourceLine: null,
    strategy: 'none',
    confidence: null,
    noExpiry: false,
    ambiguous: false,
    alternativeIso: null,
    ...base,
  };
}

// ---------------------------------------------------------------------------
// Multi-page documents (PDFs)
// ---------------------------------------------------------------------------

/** One page's result, with the 0-based page it came from. */
export type PageExtraction = ExpirationExtraction & { pageIndex: number };

const CONFIDENCE_RANK: Record<ExpirationConfidence, number> = { high: 3, medium: 2, low: 1 };

/**
 * True when a page result is good enough to stop reading further pages:
 * high confidence (MRZ, a label on the same line, or LIFETIME on the label
 * line) and not ambiguous.
 */
export function isConclusiveExtraction(e: ExpirationExtraction): boolean {
  return e.confidence === 'high' && !e.ambiguous;
}

/**
 * Picks the best result across the pages of one document. Higher confidence
 * wins; at equal confidence an unambiguous date beats an ambiguous one; then
 * the earlier page wins (the expiry is usually on the first page). Pages where
 * nothing was found only win when no page found anything, so the UI can still
 * say "no expiry date". Returns null for an empty list.
 */
export function pickBestPageExtraction(pages: PageExtraction[]): PageExtraction | null {
  let best: PageExtraction | null = null;
  for (const page of pages) {
    if (!best) {
      best = page;
      continue;
    }
    const rank = page.confidence ? CONFIDENCE_RANK[page.confidence] : 0;
    const bestRank = best.confidence ? CONFIDENCE_RANK[best.confidence] : 0;
    if (rank > bestRank) best = page;
    else if (rank === bestRank && rank > 0 && best.ambiguous && !page.ambiguous) best = page;
  }
  return best;
}
