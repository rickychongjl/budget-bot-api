import type { NormalizedMessage } from './types';

/**
 * Stage 2 of the pipeline (M6 "End-to-end flow"): trim whitespace, standardise
 * symbols/case/currency forms. Conservative in v1 — this stage never merges
 * merchants or guesses meaning, it only makes the mechanical extractors' regexes
 * simpler and the merchant-memory key stable.
 */
export interface MessageNormalizer {
  normalize(original: string): NormalizedMessage;
  /**
   * The merchant-memory key for a residual description: lowercase, collapsed,
   * identity-preserving punctuation stripped. Exact match only — `WOOLWORTHS 1234
   * BRISBANE` does NOT become `woolworths` here (M6 "Normalisation").
   */
  deriveMerchantKey(description: string): string;
}

/** Symbol/wording forms that mean the same thing to the extractors. */
const SYMBOL_REPLACEMENTS: readonly [RegExp, string][] = [
  [/[‘’‚‛]/g, "'"], // curly single quotes
  [/[“”„‟]/g, '"'], // curly double quotes
  [/[–—−]/g, '-'], // en/em dash, minus sign
  [/ /g, ' '], // nbsp
  [/\bau\$|\ba\$|\baud\$/g, '$'], // A$ / AU$ -> $ (the user's own currency, resolved later)
  [/\bus\$/g, 'usd '], // US$25 -> usd 25 (explicit foreign code)
  [/\bnz\$/g, 'nzd '],
  [/\bdollarydoos?\b/g, 'dollars'],
];

/** Punctuation that carries no meaning for our purposes; kept: $ . , / - + : % ' */
const NOISE_PUNCTUATION = /[!?;"()[\]{}<>*_~`|\\]/g;

export class DefaultMessageNormalizer implements MessageNormalizer {
  normalize(original: string): NormalizedMessage {
    let text = original.normalize('NFKC').toLowerCase();
    for (const [pattern, replacement] of SYMBOL_REPLACEMENTS) text = text.replace(pattern, replacement);
    text = text
      .replace(NOISE_PUNCTUATION, ' ')
      // "spent$50" / "$ 50" -> "$50"
      .replace(/\$\s+(?=\d)/g, '$')
      .replace(/(?<=[a-z])\$/g, ' $')
      // trailing sentence punctuation
      .replace(/[.,]+(?=\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { original, text };
  }

  deriveMerchantKey(description: string): string {
    return description
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s&'-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
