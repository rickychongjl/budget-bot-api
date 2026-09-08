/**
 * Merchants that commonly span categories (M6 "Merchant memory": "never force a
 * mapping for merchants that commonly span categories (Amazon, etc.)"). A hit here
 * means the pipeline never *proposes* a permanent mapping and never *auto-applies*
 * one, so each purchase is categorised on its own merits.
 *
 * Matching is on whole words in the normalised description, so `amazon prime` and
 * `amazon au` match while `bunnings` (a hardware chain that is not in the list) does
 * not. Expand from eval findings, not from guesses.
 */
const MULTI_CATEGORY_MERCHANTS: readonly string[] = [
  'amazon',
  'amzn',
  'ebay',
  'kmart',
  'target',
  'big w',
  'bigw',
  'costco',
  'myer',
  'david jones',
  'catch',
  'temu',
  'shein',
  'aliexpress',
  'paypal',
  'afterpay',
  'zip',
  'zip pay',
  'apple',
  'google',
  'officeworks',
  'the reject shop',
  'reject shop',
  'harvey norman',
  'jb hi-fi',
  'jb hifi',
  'westfield',
  'the iconic',
  'gumtree',
  'facebook marketplace',
  'marketplace',
];

const PATTERNS: readonly RegExp[] = MULTI_CATEGORY_MERCHANTS.map(
  (m) => new RegExp(`(?:^|\\s)${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`),
);

/** `true` if any known multi-category merchant appears in the (already lowercased) text. */
export function isMultiCategoryMerchant(normalizedText: string | null | undefined): boolean {
  if (!normalizedText) return false;
  const padded = ` ${normalizedText.toLowerCase().trim()} `;
  return PATTERNS.some((p) => p.test(padded));
}
