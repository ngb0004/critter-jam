/**
 * Copy-text share card (UI/app), spec 2.4. No spoilers: time, estimated rank, spec and the keyword glyphs of the
 * top three spells only:  DELVE #312 | 7:42 | Top 18% est. | Ember | [fire][storm][poison]
 * Below the bot median the rank is replaced by a depth milestone ("Reached Layer 3").
 */
import { SPECS } from '../content/specs';
import { SPELLS } from '../content/spells';
import type { SpecId } from '../core/types';
import { fmtTime } from './format';
import { shareRank } from './percentile';

export interface ShareInput {
  day: number;
  seconds: number;
  specId: SpecId;
  /** Keywords of the top three spells (see topKeywords). */
  keywords: readonly string[];
  /** Optional page link appended on its own line. */
  url?: string;
}

export function shareText(s: ShareInput): string {
  const glyphs = s.keywords.slice(0, 3).map((k) => `[${k}]`).join('');
  const line = `DELVE #${s.day} | ${fmtTime(s.seconds)} | ${shareRank(s.seconds)} | ${SPECS[s.specId]?.name ?? s.specId} | ${glyphs || '[-]'}`;
  return s.url ? `${line}\n${s.url}` : line;
}

/**
 * Keywords of the run's top three spells: slots ordered by rank (fusions first, they sit at 5 with 2 keywords),
 * ties by slot order; unique keywords, at most 3.
 */
export function topKeywords(slotSpell: ArrayLike<number>, slotRank: ArrayLike<number>): string[] {
  const slots: number[] = [];
  for (let s = 0; s < slotSpell.length; s++) if (slotSpell[s] >= 0 && SPELLS[slotSpell[s]]) slots.push(s);
  slots.sort((a, b) => {
    const fa = SPELLS[slotSpell[a]].fusion ? 1 : 0;
    const fb = SPELLS[slotSpell[b]].fusion ? 1 : 0;
    return fb - fa || slotRank[b] - slotRank[a] || a - b;
  });
  const out: string[] = [];
  for (const s of slots.slice(0, 3)) for (const k of SPELLS[slotSpell[s]].keywords) if (!out.includes(k) && out.length < 3) out.push(k);
  return out;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea trick */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export const canNativeShare = (): boolean => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

/** Native share sheet; resolves false if unavailable or cancelled. */
export async function nativeShare(text: string): Promise<boolean> {
  if (!canNativeShare()) return false;
  try {
    await navigator.share({ text });
    return true;
  } catch {
    return false;
  }
}
