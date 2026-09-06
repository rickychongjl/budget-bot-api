import type { CurrencyCode, LocalDate } from '../core/ports/common';
import { addDays, daysInMonth, isValidLocalDate, splitLocalDate, toLocalDate, weekday } from './dates';
import type { IMessageNormalizer } from './normalizer';
import type {
  ExtractedAmount,
  ExtractedDate,
  IntentMarker,
  MechanicalCandidate,
  NormalizedMessage,
} from './types';

/**
 * Stage 3 (M6 "End-to-end flow"): amounts, explicit signs, currency tokens,
 * recognisable dates — pure rules, no model. Everything it can't state with
 * certainty it leaves for the LLM or a clarification; it never guesses a category.
 *
 * `today` is passed in (derived by the pipeline from the injected `Clock` + the
 * user's timezone) — nothing here reads the wall clock.
 */
export interface IMechanicalTransactionParser {
  parse(normalized: NormalizedMessage, today: LocalDate): MechanicalCandidate;
}

interface Span {
  start: number;
  end: number;
}

const overlaps = (a: Span, spans: readonly Span[]): boolean =>
  spans.some((s) => a.start < s.end && s.start < a.end);

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Readonly<Record<string, number>> = {
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
};
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tues: 2, tue: 2,
  wednesday: 3, weds: 3, wed: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};
const WEEKDAY_FULL = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday';
const WEEKDAY_ABBR = 'sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat';

/** `null` = date-shaped but impossible (flag it); `'skip'` = not a date attempt at all. */
type DateResolution = LocalDate | null | 'skip';

interface DateRule {
  pattern: RegExp;
  resolve: (m: RegExpExecArray, today: LocalDate) => DateResolution;
}

/** Year-less day/month: this year, unless that lands in the future — then last year. */
function resolveDayMonth(day: number, month: number, yearText: string | undefined, today: LocalDate): LocalDate | null {
  if (month < 1 || month > 12 || day < 1) return null;
  const t = splitLocalDate(today);
  let year: number;
  if (yearText !== undefined) {
    year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
  } else {
    year = t.year;
    if (month > t.month || (month === t.month && day > t.day)) year -= 1;
  }
  if (day > daysInMonth(year, month)) return null;
  return toLocalDate(year, month, day);
}

function mostRecentWeekday(target: number, today: LocalDate, strictlyBefore: boolean): LocalDate {
  const diff = (weekday(today) - target + 7) % 7;
  const back = diff === 0 && strictlyBefore ? 7 : diff;
  return addDays(today, -back);
}

const DATE_RULES: readonly DateRule[] = [
  { pattern: /\bday before yesterday\b/g, resolve: (_m, today) => addDays(today, -2) },
  {
    pattern: /\b(?:yesterday|yesty|yest|yday|last night|last nite|last evening)\b/g,
    resolve: (_m, today) => addDays(today, -1),
  },
  {
    pattern: /\b(?:today|tonight|this (?:morning|morn|arvo|afternoon|evening|eve|lunch|lunchtime)|just now|earlier)\b/g,
    resolve: (_m, today) => today,
  },
  // Future-tense words resolve to a real (future) date so the validator rejects them
  // with a clear question instead of silently recording "today".
  { pattern: /\b(?:tomorrow|tmrw|tmr|next week|next month)\b/g, resolve: (_m, today) => addDays(today, 1) },
  { pattern: /\b(\d{1,2}) days? ago\b/g, resolve: (m, today) => addDays(today, -Number(m[1])) },
  { pattern: /\b(?:a|1|one) week ago\b/g, resolve: (_m, today) => addDays(today, -7) },
  { pattern: /\b(\d) weeks? ago\b/g, resolve: (m, today) => addDays(today, -7 * Number(m[1])) },
  { pattern: /\b(?:a|1|one) fortnight ago\b/g, resolve: (_m, today) => addDays(today, -14) },
  {
    pattern: new RegExp(`\\b(last|on|this)\\s+(${WEEKDAY_FULL}|${WEEKDAY_ABBR})\\b`, 'g'),
    resolve: (m, today) => mostRecentWeekday(WEEKDAYS[m[2] ?? ''] ?? 0, today, m[1] === 'last'),
  },
  {
    // Full weekday names stand alone; abbreviations need a prefix (rule above) —
    // "sat", "sun", "mon" are too easily ordinary words.
    pattern: new RegExp(`\\b(${WEEKDAY_FULL})\\b`, 'g'),
    resolve: (m, today) => mostRecentWeekday(WEEKDAYS[m[1] ?? ''] ?? 0, today, false),
  },
  {
    pattern: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    resolve: (m) => {
      const iso = `${m[1]}-${m[2]}-${m[3]}`;
      return isValidLocalDate(iso) ? iso : null;
    },
  },
  {
    // Day-first (AU): 3/9, 03/09/26, 3/9/2026, 3-9-2026, 3.9.2026 ('.' and '-' need a year:
    // "2.5" is an amount and "3-9" could be a range).
    pattern: /\b(\d{1,2})(?:\/(\d{1,2})(?:\/(\d{2}|\d{4}))?|[.-](\d{1,2})[.-](\d{2}|\d{4}))\b/g,
    resolve: (m, today) => {
      const day = Number(m[1]);
      const month = Number(m[2] ?? m[4]);
      const year = m[3] ?? m[5];
      return resolveDayMonth(day, month, year, today);
    },
  },
  {
    pattern: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})\\b(?:,?\\s+(\\d{4}))?`, 'g'),
    // "45 sept 1st" — 45 is an amount sitting next to a month-first date, not a bad day.
    resolve: (m, today) =>
      Number(m[1]) > 31 ? 'skip' : resolveDayMonth(Number(m[1]), MONTHS[m[2] ?? ''] ?? 0, m[3], today),
  },
  {
    pattern: new RegExp(`\\b(${MONTH_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'g'),
    resolve: (m, today) => resolveDayMonth(Number(m[2]), MONTHS[m[1] ?? ''] ?? 0, m[3], today),
  },
  {
    // "on the 3rd" — this month, or last month if that is in the future.
    pattern: /\bon the (\d{1,2})(?:st|nd|rd|th)\b/g,
    resolve: (m, today) => {
      const day = Number(m[1]);
      const t = splitLocalDate(today);
      let { year, month } = t;
      if (day > t.day) {
        month -= 1;
        if (month === 0) {
          month = 12;
          year -= 1;
        }
      }
      return day >= 1 && day <= daysInMonth(year, month) ? toLocalDate(year, month, day) : null;
    },
  },
];

interface InvalidDate extends Span {
  token: string;
}

function extractDates(text: string, today: LocalDate): { dates: ExtractedDate[]; invalid: InvalidDate[] } {
  const found: ExtractedDate[] = [];
  const invalid: InvalidDate[] = [];
  for (const rule of DATE_RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      const span = { start: m.index, end: m.index + m[0].length };
      if (overlaps(span, found) || overlaps(span, invalid)) continue;
      const localDate = rule.resolve(m, today);
      if (localDate === 'skip') continue;
      if (localDate === null) {
        // Only the unambiguous numeric/month forms count as "date-shaped but wrong".
        if (/\d/.test(m[0]) && /[/\-.]|[a-z]/.test(m[0])) invalid.push({ token: m[0], ...span });
        continue;
      }
      found.push({ localDate, token: m[0], ...span });
    }
  }
  return { dates: found.sort((a, b) => a.start - b.start), invalid };
}

// ---------------------------------------------------------------------------
// Amounts & currency
// ---------------------------------------------------------------------------

const CURRENCY_WORDS: Readonly<Record<string, CurrencyCode>> = {
  aud: 'AUD',
  usd: 'USD',
  nzd: 'NZD',
  gbp: 'GBP',
  eur: 'EUR',
  jpy: 'JPY',
  yen: 'JPY',
  euro: 'EUR',
  euros: 'EUR',
  pound: 'GBP',
  pounds: 'GBP',
  quid: 'GBP',
  'us$': 'USD',
  'nz$': 'NZD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
};
const CURRENCY_CODE_ALT = 'aud|usd|nzd|gbp|eur|jpy';
const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?`;
/** Bare integers immediately followed by one of these are quantities/units, not money. */
const NON_MONEY_SUFFIX =
  /^\s?(?:%|x\b|st\b|nd\b|rd\b|th\b|am\b|pm\b|kg\b|kgs\b|g\b|km\b|kms\b|m\b|l\b|ltr\b|ml\b|pcs?\b|hrs?\b|hours?\b|mins?\b|minutes?\b|people\b|ppl\b|pax\b|days?\b|weeks?\b|months?\b|nights?\b|yrs?\b|years?\b|of\b|coffees?\b|beers?\b|drinks?\b|tickets?\b|items?\b|bags?\b|packs?\b|boxes\b|slices?\b|pieces?\b|serves?\b|rounds?\b|eleven\b|x\d)/;
/** Bare integers immediately preceded by one of these are quantities/identifiers. */
const NON_MONEY_PREFIX = /(?:x|#|no\.?|number|order|ref|invoice|inv|table|seat|bus|route|platform|unit|apt|level)\s?$/;

interface AmountRule {
  pattern: RegExp;
  build: (m: RegExpExecArray) => { decimal: string; currencyCode: CurrencyCode | null; explicit: boolean } | null;
}

function normaliseDecimal(whole: string, fraction: string | undefined, thousands: boolean): string {
  const w = whole.replace(/,/g, '');
  const base = fraction !== undefined && fraction.length > 0 ? `${w}.${fraction}` : w;
  if (!thousands) return base;
  // "2k" / "1.5k": shift by three places without touching a float.
  const [i = '0', f = ''] = base.split('.');
  const digits = (i + f.padEnd(3, '0')).replace(/^0+(?=\d)/, '');
  const rest = f.length > 3 ? '.' + f.slice(3) : '';
  return digits + rest;
}

const AMOUNT_RULES: readonly AmountRule[] = [
  {
    // us$50, nz$50, €50, £50, ¥500
    pattern: new RegExp(String.raw`(us\$|nz\$|€|£|¥)\s?${NUMBER}(k\b)?`, 'g'),
    build: (m) => ({
      decimal: normaliseDecimal(m[2] ?? '0', m[3], m[4] !== undefined),
      currencyCode: CURRENCY_WORDS[m[1] ?? ''] ?? null,
      explicit: true,
    }),
  },
  {
    // $82.40, $1,200, $2k
    pattern: new RegExp(String.raw`\$${NUMBER}(k\b)?`, 'g'),
    build: (m) => ({ decimal: normaliseDecimal(m[1] ?? '0', m[2], m[3] !== undefined), currencyCode: null, explicit: true }),
  },
  {
    // 50 aud, 50 usd, 50 dollars, 50 bucks, 2k bucks, 50 euros
    pattern: new RegExp(
      String.raw`\b${NUMBER}\s?(k\b)?\s?(${CURRENCY_CODE_ALT}|dollars?|bucks?|euros?|pounds?|quid|yen)\b`,
      'g',
    ),
    build: (m) => ({
      decimal: normaliseDecimal(m[1] ?? '0', m[2], m[3] !== undefined),
      currencyCode: CURRENCY_WORDS[m[4] ?? ''] ?? null,
      explicit: true,
    }),
  },
  {
    // aud 50, usd 12.50
    pattern: new RegExp(String.raw`\b(${CURRENCY_CODE_ALT})\s?${NUMBER}(k\b)?`, 'g'),
    build: (m) => ({
      decimal: normaliseDecimal(m[2] ?? '0', m[3], m[4] !== undefined),
      currencyCode: CURRENCY_WORDS[m[1] ?? ''] ?? null,
      explicit: true,
    }),
  },
  {
    // 50c, 80 cents
    pattern: /\b(\d{1,2})\s?(?:c|cents?)\b/g,
    build: (m) => ({ decimal: `0.${(m[1] ?? '0').padStart(2, '0')}`, currencyCode: null, explicit: true }),
  },
  {
    // bare decimal: 82.40, 4.5, 1,200.00
    pattern: /\b(\d{1,3}(?:,\d{3})+|\d+)\.(\d+)\b/g,
    build: (m) => ({ decimal: normaliseDecimal(m[1] ?? '0', m[2], false), currencyCode: null, explicit: true }),
  },
  {
    // 2k / 1.5k with no other marker
    pattern: /\b(\d+)(?:\.(\d+))?k\b/g,
    build: (m) => ({ decimal: normaliseDecimal(m[1] ?? '0', m[2], true), currencyCode: null, explicit: true }),
  },
  {
    // bare integer — only money if nothing more explicit exists (decided later)
    pattern: /\b(\d{1,3}(?:,\d{3})+|\d+)\b/g,
    build: (m) => ({ decimal: normaliseDecimal(m[1] ?? '0', undefined, false), currencyCode: null, explicit: false }),
  },
];

function isGluedToWord(text: string, span: Span): boolean {
  const letter = (i: number): boolean => i >= 0 && i < text.length && /[a-z]/.test(text[i] ?? '');
  const before = text[span.start - 1];
  const after = text[span.end];
  if (letter(span.start - 1) || letter(span.end)) return true;
  if (after === '-' && letter(span.end + 1)) return true;
  if (before === '-' && letter(span.start - 2)) return true;
  return false;
}

function blankSpans(text: string, spans: readonly Span[]): string {
  const chars = [...text];
  for (const s of spans) for (let i = s.start; i < s.end && i < chars.length; i++) chars[i] = ' ';
  return chars.join('');
}

function extractAmounts(text: string, reserved: readonly Span[]): ExtractedAmount[] {
  const found: ExtractedAmount[] = [];
  // Quantity/unit checks look at the neighbouring words with date tokens blanked,
  // so "70 day before yesterday" is $70 on a date, not "70 days".
  const context = blankSpans(text, reserved);
  for (const rule of AMOUNT_RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      const span = { start: m.index, end: m.index + m[0].length };
      if (overlaps(span, reserved) || overlaps(span, found)) continue;
      const built = rule.build(m);
      if (built === null) continue;
      if (!built.explicit) {
        if (NON_MONEY_SUFFIX.test(context.slice(span.end))) continue;
        if (NON_MONEY_PREFIX.test(context.slice(0, span.start))) continue;
        // Digits glued to letters ("7eleven", "h2o", "7-eleven", "covid-19") are not amounts.
        if (isGluedToWord(text, span)) continue;
      }
      found.push({ ...built, ...span });
    }
  }
  found.sort((a, b) => a.start - b.start);
  // Bare integers are only money when nothing more explicit was found — otherwise
  // they're quantities ("2 coffees $9").
  const explicit = found.filter((a) => a.explicit);
  return explicit.length > 0 ? explicit : found;
}

const STANDALONE_CURRENCY = new RegExp(
  String.raw`(us\$|nz\$|€|£|¥)|\b(${CURRENCY_CODE_ALT}|yen|euros?|pounds?|quid)\b`,
  'g',
);

function extractCurrencyTokens(text: string, amounts: readonly ExtractedAmount[]): { codes: CurrencyCode[]; spans: Span[] } {
  const codes = new Set<CurrencyCode>();
  const spans: Span[] = [];
  for (const a of amounts) if (a.currencyCode !== null) codes.add(a.currencyCode);
  STANDALONE_CURRENCY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STANDALONE_CURRENCY.exec(text)) !== null) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (overlaps(span, amounts)) continue;
    const code = CURRENCY_WORDS[m[1] ?? m[2] ?? ''];
    if (code !== undefined) {
      codes.add(code);
      spans.push(span);
    }
  }
  return { codes: [...codes], spans };
}

// ---------------------------------------------------------------------------
// Intent markers
// ---------------------------------------------------------------------------

const INCOME_PATTERN =
  /\b(?:salary|wages?|payday|pay ?day|paycheck|pay ?cheque|payslip|income|got paid|been paid|just got paid|centrelink|dividends?|tax return|tax refund|earned|pay (?:came|went) in|bonus|got my pay|paid me)\b/;
const REFUND_PATTERN =
  /\b(?:refund(?:ed|s)?|reimburse(?:d|ment|s)?|money back|cash ?back|returned|return of|got back|gave me back|paid me back|sent me back)\b/;
const CORRECTION_PATTERN =
  /^(?:cancel|delete|remove|undo|scrap|scratch that|nvm|never ?mind|actually|oops|whoops|change|edit|fix|update|wrong|correction|ignore)\b|\b(?:delete|cancel|remove|undo|scrap|ignore)\s+(?:the|that|my|last|previous|it|this)\b|\b(?:should(?:'ve| have)? ?be(?:en)?|was (?:actually|meant|supposed)|meant to be|make (?:it|that)|not \$?\d|change (?:it|that|the))\b/;
const EXPENSE_PATTERN = /\b(?:spent|paid|bought|purchased?|cost|owe|pay|buy)\b/;

function extractMarkers(text: string): IntentMarker[] {
  const markers: IntentMarker[] = [];
  const isTaxRefund = /\btax refund\b/.test(text);
  if (INCOME_PATTERN.test(text) || /^\+/.test(text) || /\+\$?\d/.test(text)) markers.push('income');
  if (REFUND_PATTERN.test(text) && !isTaxRefund) markers.push('refund');
  if (CORRECTION_PATTERN.test(text)) markers.push('correction');
  if (EXPENSE_PATTERN.test(text)) markers.push('expense');
  return markers;
}

// ---------------------------------------------------------------------------
// Residual description
// ---------------------------------------------------------------------------

const FILLER = new Set([
  'spent', 'paid', 'bought', 'purchased', 'got', 'on', 'at', 'for', 'from', 'in', 'the', 'a', 'an', 'some',
  'of', 'my', 'to', 'with', 'i', 'just', 'and', 'then', 'today', 'was', 'is', 'it', 'this', 'that', 'cost',
  'me', 'we', 'about', 'around', 'roughly', 'approx', 'like', 'total', 'cash', 'card', 'eftpos', 'via', 'using',
  'transaction', 'purchase', 'txn', 'so', 'hey', 'hi', 'pls', 'please', 'add', 'log', 'record', 'note', 'expense', 'expenses',
]);

function residualDescription(text: string, blanked: readonly Span[], normalizer: IMessageNormalizer): string {
  let cleaned = blankSpans(text, blanked);
  // A sign or currency symbol left dangling next to a blanked amount.
  cleaned = cleaned.replace(/(^|\s)[+\-$]+(?=\s|$)/g, ' ');
  const tokens = normalizer
    .merchantKey(cleaned)
    .split(' ')
    .filter((t) => t.length > 0);
  while (tokens.length > 0 && FILLER.has(tokens[0] ?? '')) tokens.shift();
  while (tokens.length > 0 && FILLER.has(tokens[tokens.length - 1] ?? '')) tokens.pop();
  return tokens.join(' ');
}

// ---------------------------------------------------------------------------

export class MechanicalTransactionParser implements IMechanicalTransactionParser {
  constructor(private readonly normalizer: IMessageNormalizer) {}

  parse(normalized: NormalizedMessage, today: LocalDate): MechanicalCandidate {
    const text = normalized.text;
    const { dates, invalid: invalidDates } = extractDates(text, today);
    const reserved: Span[] = [...dates, ...invalidDates];
    const amounts = extractAmounts(text, reserved);
    const currency = extractCurrencyTokens(text, amounts);
    const markers = extractMarkers(text);

    const distinctDates = new Set(dates.map((d) => d.localDate));
    const hasAmbiguousDecimalComma = /\b\d+,\d{1,2}\b/.test(text);
    const hasQuantityMultiplier =
      /\b\d+\s?x\s?\d|\bx\s?\d+\b|\b\d+\s?x\b|\beach\b|\bapiece\b|\bper (?:person|head|item|ticket)\b/.test(text);

    const blanked: Span[] = [...amounts, ...reserved, ...currency.spans];
    // Marker phrases are part of the description only when they're all there is
    // ("salary" alone is a fine income note); otherwise strip the verb-y ones.
    for (const p of [INCOME_PATTERN, REFUND_PATTERN]) {
      const m = p.exec(text);
      if (m !== null && m[0] !== text.trim()) blanked.push({ start: m.index, end: m.index + m[0].length });
    }
    const description = residualDescription(text, blanked, this.normalizer);
    const fallback = residualDescription(text, [...amounts, ...reserved, ...currency.spans], this.normalizer);

    const isCorrection = markers.includes('correction');
    const isExplicitIncome = markers.includes('income') && !markers.includes('refund') && !isCorrection;

    return {
      normalized,
      amounts,
      dates,
      currencyTokens: currency.codes,
      markers,
      normalizedDescription: description.length > 0 ? description : fallback,
      hasExactlyOneAmount: amounts.length === 1 && !hasQuantityMultiplier,
      hasMultipleAmounts: amounts.length >= 2 || (amounts.length >= 1 && hasQuantityMultiplier),
      isExplicitIncome,
      isCorrection,
      hasConflictingDates: distinctDates.size > 1,
      invalidDateTokens: invalidDates.map((d) => d.token),
      hasAmbiguousDecimalComma,
    };
  }
}
