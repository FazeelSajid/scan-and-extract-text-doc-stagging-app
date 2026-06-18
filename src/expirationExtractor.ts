/**
 * Expiration-date extraction utilities for ML Kit OCR output.
 *
 * The input is the `blocks` array returned by `react-native-ml-kit/text-recognition`:
 *   blocks[].lines[].text   — line text
 *   blocks[].lines[].frame  — { top|left|x|y, width, height } bounding box
 *
 * The output is a single expiration date, or null if no plausible candidate
 * was found. The strategy field explains how it was found, useful for debugging
 * on real device runs.
 *
 * The strategy has three stages:
 *   1. Label match on the same line as the date (e.g. "EXP 12/05/2027")
 *   2. Label match on a separate line, then take the closest date line
 *      (same row to the right, or the next line down)
 *   3. Fallback: score every date-shaped token in the document
 *      (preferring future dates that are not absurdly far in the future)
 */

export type MlKitFrame = { top?: number; left?: number; x?: number; y?: number };
export type MlKitLine = { text: string; frame?: MlKitFrame };
export type MlKitBlock = { lines?: MlKitLine[] };

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

const MONTH_NAMES: Record<string, number> = {
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
  // Spanish abbreviations (Puerto Rico / Latin America IDs)
  ene: 1, abr: 4, ago: 8, dic: 12,
};

// Words that mark a line as the "expiry" label. Multi-word phrases come first
// so they win over the bare "EXP" match.
export const EXPIRY_LABEL_REGEXES: RegExp[] = [
  /\bex?pirat(ion|e|i)?\s*dat/i,
  /\bex?rat(ion|e|i)?\s*dat/i,
  /\bdats?\s+of\s+expirat/i,
  /\bdate\s*of\s*exp(iry|iration|iration\s*date|\.)?\b/i,
  /\bdate\s+o[xk]p\b/i,
  /\bexp(iry|iration|\.)?\s*date\b/i,
  /\bvalid\s*(thru|through|until|up\s*to)\b/i,
  /\bgood\s*(thru|through|until)\b/i,
  /\bcard\s*expires?\b/i,
  /\bexpires+\b/i,
  /\bexpires?\s*(on)?\b/i,
  /\bexpiration\b/i,
  /\bexpiry\b/i,
  /\bexp(?=\d)/i,
  /\bexp[a-z](?=\d)/i,
  /\b[eE][dD](?=\s*\d)/i,
  /\b4b\s*exp/i,
  /\dexp\b/i,
  /\bexp\.?\b/i,
];

// Words that mark a line we should explicitly penalize when picking a date
// (date of birth, issue date, etc.).
export const NEGATIVE_LABEL_REGEXES: RegExp[] = [
  /\b(date\s*of\s*birth|dob|born|birth\s*date)\b/i,
  /\b(date\s*of\s*issue|issued|issue\s*date|issued\s*on)\b/i,
  /\b[i1l]?sue\b/i,
  /\b(issue|iss\.?|cae)\s*dat/i,
  /\b[i1l]ssue\s*dat/i,
  /\biss\/?emi/i,
  /\b[i1]ss\b/i,
  /\b4a\b/i,
  /\biss\b/i,
  /\b(from|issued\s*on|valid\s*from)\b/i,
];

// Numeric date: M/D/Y or M/Y. The long form is tried first by being the
// first alternative in the alternation.
const NUMERIC_DATE_REGEX =
  /(?:(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4}))|(?:(\d{1,2})[\/\-\.](\d{2,4}))/g;
// Alpha month with strict 4-digit year and clear separators. Without `\s+`
// between day and year we get false matches like "DEC 20 27" from "DEC 2027".
const ALPHA_DATE_REGEX = /\b([A-Za-z]{3,9})\s+(\d{1,2})(?:\s+|,\s+)(\d{4})\b/g;
const ALPHA_DATE_REGEX_2 = /\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/g;
// Compact form without separators: 14NOV2014, 12DIC2011 (common on PR IDs).
const COMPACT_ALPHA_DATE_REGEX = /\b(\d{1,2})([A-Za-z]{3,9})(\d{4})\b/g;

export type ParsedDate = {
  year: number;
  month: number;
  day: number;
  raw: string;
};

function parseNumericDate(match: RegExpExecArray): ParsedDate | null {
  // Two capture groups: (m,d,y) for long form, (m,y) for short form.
  if (match[1] !== undefined) {
    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);
    let year = parseInt(match[3], 10);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > 31) return null;
    if (year < 1900 || year > 2200) return null;
    return { year, month, day, raw: match[0] };
  }
  // Short form M/Y: day defaults to 1 (start of month). Most bank cards
  // expire at the END of the month, but for an "is this plausible" check
  // the start of the month is a fine approximation.
  const month = parseInt(match[4], 10);
  const yearStr = match[5];
  // Customer IDs like "11-087-0" produce a false 3-digit year fragment.
  if (yearStr.length === 3) return null;
  let year = parseInt(yearStr, 10);
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  if (month < 1 || month > 12) return null;
  if (year < 1900 || year > 2200) return null;
  return { year, month, day: 1, raw: match[0] };
}

/** Fix common OCR confusions in month tokens (e.g. "0CT" where O was read as zero). */
export function normalizeOcrMonthToken(token: string): string {
  if (token.length >= 3 && token[0] === '0') {
    const fixed = `O${token.slice(1)}`;
    if (MONTH_NAMES[fixed.toLowerCase()]) return fixed;
  }
  return token;
}

/** Normalize OCR text so alpha-month date regexes can match misread month names. */
export function normalizeOcrForDateParsing(text: string): string {
  return text
    .replace(
      /(\D|^)(\d{2})(\d{2})([\/\-\.]\d{4}\b)/g,
      (match, prefix, mm, dd, rest) => {
        const m = parseInt(mm, 10);
        const d = parseInt(dd, 10);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
          return `${prefix}${mm}/${dd}${rest}`;
        }
        return match;
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
      (match, mm, dd, yPart) => {
        const m = parseInt(mm, 10);
        const d = parseInt(dd, 10);
        const yp = parseInt(yPart, 10);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && yp >= 200 && yp <= 209) {
          return `${mm}${dd}/${yPart}0`;
        }
        return match;
      },
    )
    .replace(/(\bEXP)(\d)/gi, '$1 $2')
    .replace(/(\bISS)(\d)/gi, '$1 $2')
    .replace(/(\bExp)[QO0Il](\d)/gi, '$1 0$2');
}

function resolveMonthToken(token: string): number | undefined {
  return MONTH_NAMES[normalizeOcrMonthToken(token).toLowerCase()];
}

function parseAlphaDate(match: RegExpExecArray, monthFirst: boolean): ParsedDate | null {
  // 4-digit year is required by the regex, so no century-fix needed.
  const a = match[1];
  const b = match[2];
  const yStr = match[3];
  const monthName = monthFirst ? a : b;
  const dayStr = monthFirst ? b : a;
  const month = resolveMonthToken(monthName);
  if (!month) return null;
  const day = parseInt(dayStr, 10);
  const year = parseInt(yStr, 10);
  if (day < 1 || day > 31) return null;
  if (year < 1900 || year > 2200) return null;
  return { year, month, day, raw: match[0] };
}

function parseCompactAlphaDate(match: RegExpExecArray): ParsedDate | null {
  const day = parseInt(match[1], 10);
  const month = resolveMonthToken(match[2]);
  const year = parseInt(match[3], 10);
  if (!month) return null;
  if (day < 1 || day > 31) return null;
  if (year < 1900 || year > 2200) return null;
  return { year, month, day, raw: match[0] };
}

export function findDatesInText(text: string): ParsedDate[] {
  const normalized = normalizeOcrForDateParsing(text);
  const out: ParsedDate[] = [];
  const numRe = new RegExp(NUMERIC_DATE_REGEX.source, 'g');
  const alphaRe = new RegExp(ALPHA_DATE_REGEX.source, 'g');
  const alphaRe2 = new RegExp(ALPHA_DATE_REGEX_2.source, 'g');
  const compactRe = new RegExp(COMPACT_ALPHA_DATE_REGEX.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = numRe.exec(normalized))) {
    // OCR may leave "=YYYY" after a false M/Y fragment (e.g. "2-01=1971").
    if (m[1] === undefined) {
      const after = normalized.slice(m.index + m[0].length);
      if (/^=\d{4}/.test(after)) continue;
      // Customer IDs like "11-087-0" yield a false M/Y before the next segment.
      if (/^-\d/.test(after)) continue;
      // Mangled long dates like "06/15l2016" (OCR reads / as l).
      if (/^[lI|]\d{4}/.test(after)) continue;
    }
    const d = parseNumericDate(m);
    if (d) out.push(d);
  }
  while ((m = alphaRe.exec(normalized))) {
    const d = parseAlphaDate(m, true);
    if (d) out.push(d);
  }
  while ((m = alphaRe2.exec(normalized))) {
    const d = parseAlphaDate(m, false);
    if (d) out.push(d);
  }
  while ((m = compactRe.exec(normalized))) {
    const d = parseCompactAlphaDate(m);
    if (d) out.push(d);
  }
  return out;
}

function isLikelyNotExpiration(d: ParsedDate, now: Date): boolean {
  // Expiration dates for IDs/cards are within ~20 years. Bank cards ~5y,
  // DL 4-8y, passport 10y. If the date is more than 25y out it's almost
  // certainly not what we want.
  const future = new Date(d.year, d.month - 1, d.day).getTime() - now.getTime();
  const yearsOut = future / (1000 * 60 * 60 * 24 * 365.25);
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
  const future = new Date(d.year, d.month - 1, d.day).getTime() - now.getTime();
  const yearsOut = future / (1000 * 60 * 60 * 24 * 365.25);

  if (yearsOut >= 0 && yearsOut <= 12) score += 50;
  else if (yearsOut > 12 && yearsOut <= 25) score += 20;
  else if (yearsOut < 0 && yearsOut >= -1) score += 5;
  else if (yearsOut < -1) score -= 30;

  if (nearbyHasExpiryLabel) score += 80;
  if (nearbyHasNegativeLabel) score -= 60;

  return score;
}

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
  if (/\b(visa|mastercard|amex|discover|debit|credit\s*card|reliacard)\b/i.test(all)) {
    return true;
  }
  if (/\b\d{3,4}(?:\s+\d{3,4}){2,3}\b/.test(all)) return true;
  return false;
}

function markImpliedCardExpiryLines(
  hits: { text: string; expiry: boolean }[],
): void {
  if (!hasCardContext(hits)) return;
  for (const h of hits) {
    if (!h.expiry && isImpliedCardExpiryLine(h.text)) {
      h.expiry = true;
    }
  }
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

function markSplitExpiryLabels(hits: { line: MlKitLine; text: string; expiry: boolean }[]): void {
  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const h1 = hits[i];
      const h2 = hits[j];
      const vDist = Math.abs(
        getFrameTop(h1.line.frame) - getFrameTop(h2.line.frame),
      );
      if (vDist > 40) continue;
      if (isValidThruSplitPair(h1.text, h2.text)) {
        h1.expiry = true;
        h2.expiry = true;
      }
    }
  }
}

/** Index just past the last expiry-label match in the line, or -1 if none. */
export function getExpiryMarkerEnd(text: string): number {
  let end = -1;
  for (const r of EXPIRY_LABEL_REGEXES) {
    const flags = r.flags.includes('g') ? r.flags : `${r.flags}g`;
    const re = new RegExp(r.source, flags);
    for (const m of text.matchAll(re)) {
      end = Math.max(end, m.index! + m[0].length);
    }
  }
  return end;
}

export function isDateAfterExpiryMarker(text: string, dateRaw: string): boolean {
  const markerEnd = getExpiryMarkerEnd(text);
  if (markerEnd < 0) return true;
  const normalized = normalizeOcrForDateParsing(text);
  const dateIdx = normalized.indexOf(dateRaw);
  if (dateIdx >= 0) return dateIdx >= markerEnd;
  return text.indexOf(dateRaw) >= markerEnd;
}

function isFullNumericDate(d: ParsedDate): boolean {
  return /^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}$/.test(d.raw);
}

function isAlignedUnderNegativeLabel(
  hits: { line: MlKitLine; negative: boolean }[],
  expiryLine: MlKitLine,
  dateLine: MlKitLine,
): boolean {
  const topExp = getFrameTop(expiryLine.frame);
  const leftExp = getFrameLeft(expiryLine.frame);
  const leftDate = getFrameLeft(dateLine.frame);
  for (const h of hits) {
    if (!h.negative) continue;
    const topNeg = getFrameTop(h.line.frame);
    const leftNeg = getFrameLeft(h.line.frame);
    if (Math.abs(topNeg - topExp) > 30) continue;
    const distToNeg = Math.abs(leftDate - leftNeg);
    const distToExp = Math.abs(leftDate - leftExp);
    if (distToNeg < distToExp) return true;
  }
  return false;
}

function isBetterDateCandidate(
  d: ParsedDate,
  score: number,
  best: ParsedDate | null,
  bestScore: number,
): boolean {
  if (!best || score > bestScore) return true;
  if (score < bestScore) return false;
  const dFull = isFullNumericDate(d);
  const bFull = isFullNumericDate(best);
  if (dFull && !bFull) return true;
  if (!dFull && bFull) return false;
  return (
    d.year > best.year ||
    (d.year === best.year && d.month > best.month) ||
    (d.year === best.year && d.month === best.month && d.day > best.day)
  );
}

export type ExpirationExtraction = {
  date: ParsedDate | null;
  iso: string | null;
  display: string | null;
  sourceLine: string | null;
  strategy: 'label-same-line' | 'label-nearby' | 'fallback-score' | 'none';
};

export function formatIso(d: ParsedDate): string {
  const mm = String(d.month).padStart(2, '0');
  const dd = String(d.day).padStart(2, '0');
  return `${d.year}-${mm}-${dd}`;
}

/** Numeric DD/MM/YYYY for UI when raw has alpha month; keeps numeric OCR text otherwise. */
export function formatDisplay(d: ParsedDate): string {
  if (/[A-Za-z]{3,}/.test(d.raw)) {
    const mm = String(d.month).padStart(2, '0');
    const dd = String(d.day).padStart(2, '0');
    return `${dd}/${mm}/${d.year}`;
  }
  return d.raw;
}

export function extractExpirationDate(blocks: MlKitBlock[]): ExpirationExtraction {
  const lines = getMlKitLinesTopToBottom(blocks);
  const now = new Date();

  type LineHit = {
    line: MlKitLine;
    index: number;
    text: string;
    dates: ParsedDate[];
    expiry: boolean;
    negative: boolean;
  };
  const hits: LineHit[] = lines.map((line, index) => {
    const text = line.text ?? '';
    return {
      line,
      index,
      text,
      dates: findDatesInText(text),
      expiry: isExpiryLabel(text),
      negative: isNegativeLabel(text),
    };
  });
  markSplitExpiryLabels(hits);
  markImpliedCardExpiryLines(hits);

  // Stage 1: same-line label + date.
  for (const h of hits) {
    if (h.expiry && h.dates.length > 0) {
      const afterMarker = h.dates.filter(d =>
        isDateAfterExpiryMarker(h.text, d.raw),
      );
      const candidateDates =
        afterMarker.length > 0 ? afterMarker : h.dates;
      let best: ParsedDate | null = null;
      let bestScore = -Infinity;
      for (const d of candidateDates) {
        if (isLikelyNotExpiration(d, now)) continue;
        const penalizeNegative =
          h.negative && !isDateAfterExpiryMarker(h.text, d.raw);
        const s = scoreDateCandidate(d, now, penalizeNegative, true);
        if (s > bestScore) {
          bestScore = s;
          best = d;
        }
      }
      if (best && bestScore > 0) {
        return {
          date: best,
          iso: formatIso(best),
          display: formatDisplay(best),
          sourceLine: h.text,
          strategy: 'label-same-line',
        };
      }
    }
  }

  // Stage 2: label on its own line, find the nearest date.
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (!h.expiry) continue;
    const candidates: { hit: LineHit; dist: number; rightDist?: number }[] = [];
    for (let j = 0; j < hits.length; j++) {
      if (i === j) continue;
      const other = hits[j];
      if (other.dates.length === 0) continue;
      const topA = getFrameTop(h.line.frame);
      const topB = getFrameTop(other.line.frame);
      const leftA = getFrameLeft(h.line.frame);
      const leftB = getFrameLeft(other.line.frame);
      const vDist = Math.abs(topA - topB);
      if (vDist < 30 && leftB > leftA) {
        candidates.push({ hit: other, dist: vDist, rightDist: leftB - leftA });
      } else if (vDist < 150) {
        candidates.push({ hit: other, dist: vDist });
      }
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => {
      if (a.rightDist != null && b.rightDist != null) return a.rightDist - b.rightDist;
      if (a.rightDist != null) return -1;
      if (b.rightDist != null) return 1;
      return a.dist - b.dist;
    });
    let stage2Best: ParsedDate | null = null;
    let stage2BestScore = -Infinity;
    let stage2BestSource: string | null = null;
    for (const c of candidates) {
      let lineBest: ParsedDate | null = null;
      let lineBestScore = -Infinity;
      for (const d of c.hit.dates) {
        if (isLikelyNotExpiration(d, now)) continue;
        const underNegative = c.hit.negative ||
          isAlignedUnderNegativeLabel(hits, h.line, c.hit.line);
        const s = scoreDateCandidate(d, now, underNegative, true);
        if (s > lineBestScore) {
          lineBestScore = s;
          lineBest = d;
        }
      }
      if (
        lineBest &&
        lineBestScore > 0 &&
        isBetterDateCandidate(lineBest, lineBestScore, stage2Best, stage2BestScore)
      ) {
        stage2Best = lineBest;
        stage2BestScore = lineBestScore;
        stage2BestSource = c.hit.text;
      }
    }
    if (stage2Best && stage2BestScore > 0) {
      return {
        date: stage2Best,
        iso: formatIso(stage2Best),
        display: formatDisplay(stage2Best),
        sourceLine: stage2BestSource,
        strategy: 'label-nearby',
      };
    }
  }

  // Stage 3: fallback scoring over all dates.
  let best: ParsedDate | null = null;
  let bestScore = -Infinity;
  let bestSource: string | null = null;
  for (const h of hits) {
    if (h.dates.length === 0) continue;
    for (const d of h.dates) {
      if (isLikelyNotExpiration(d, now)) continue;
      const s = scoreDateCandidate(d, now, h.negative, h.expiry);
      if (s > bestScore) {
        bestScore = s;
        best = d;
        bestSource = h.text;
      }
    }
  }
  if (best && bestScore > 0) {
    return {
      date: best,
      iso: formatIso(best),
      display: formatDisplay(best),
      sourceLine: bestSource,
      strategy: 'fallback-score',
    };
  }

  return { date: null, iso: null, display: null, sourceLine: null, strategy: 'none' };
}
