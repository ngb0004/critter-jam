export interface SaveData {
  version: 1;
  /** Next level to play (1-based). */
  level: number;
  coins: number;
  /** Consecutive days with a win. */
  streak: number;
  /** YYYY-MM-DD of the last day that counted. */
  lastDay: string;
  freezes: number;
  sound: boolean;
  /** Levels completed, for stats. */
  wins: number;
}

const KEY = 'critter-jam.save.v1';

export function freshSave(): SaveData {
  return { version: 1, level: 1, coins: 300, streak: 0, lastDay: '', freezes: 1, sound: true, wins: 0 };
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return freshSave();
    const data = JSON.parse(raw) as SaveData;
    if (data.version !== 1) return freshSave();
    return { ...freshSave(), ...data };
  } catch {
    return freshSave();
  }
}

export function writeSave(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* storage blocked: progress just isn't kept */
  }
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Day arithmetic on YYYY-MM-DD strings. */
export function daysBetween(a: string, b: string): number {
  if (!a || !b) return Infinity;
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/**
 * Streak rules (Duolingo-style): a win today extends it; missing one day
 * spends a freeze if you have one; longer gaps reset it.
 */
export function recordWin(s: SaveData): { extended: boolean; frozeDay: boolean } {
  const d = today();
  const gap = daysBetween(s.lastDay, d);
  if (gap === 0) return { extended: false, frozeDay: false };
  let frozeDay = false;
  if (gap === 1 || s.lastDay === '') s.streak++;
  else if (gap === 2 && s.freezes > 0) {
    s.freezes--;
    s.streak++;
    frozeDay = true;
  } else s.streak = 1;
  s.lastDay = d;
  return { extended: true, frozeDay };
}
