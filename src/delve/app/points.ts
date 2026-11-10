/**
 * Daily points from survival time (UI/app), spec 9.1: linear per second between the anchors
 * (1:00 50, 2:00 150, ... 5:00 400, 7:00 600, 9:00 800, 11:00+ 1000). Paid on run end, topped up on a new best.
 * Day normalisation: t_adj = t x clamp(360 / p50_bot, 0.92, 1.08); the slice has no nightly gate, so p50_bot
 * defaults to 360 (k = 1) until BOT publishes a per-day median.
 */
import { POINT_ANCHORS } from '../core/constants';

export const POINTS_MAX = POINT_ANCHORS[POINT_ANCHORS.length - 1][1];

const normK = (p50Bot: number): number => Math.min(1.08, Math.max(0.92, 360 / p50Bot));

/** Points for a run of `sec` seconds. */
export function pointsFor(sec: number, p50Bot = 360): number {
  const t = Math.max(0, sec) * normK(p50Bot);
  const A = POINT_ANCHORS;
  if (t >= A[A.length - 1][0]) return A[A.length - 1][1];
  for (let i = 1; i < A.length; i++) {
    if (t < A[i][0]) {
      const [t0, p0] = A[i - 1];
      const [t1, p1] = A[i];
      return Math.floor(p0 + ((p1 - p0) * (t - t0)) / (t1 - t0));
    }
  }
  return 0;
}

/** Points paid for a run given today's previous best: the top-up (never negative). */
export function topUp(newSec: number, prevBestSec: number, p50Bot = 360): number {
  return Math.max(0, pointsFor(newSec, p50Bot) - pointsFor(prevBestSec, p50Bot));
}

/** The day's par: survival seconds that pay the full 1000 ("1000 pts at 11:00 today"). */
export function parSeconds(p50Bot = 360): number {
  return Math.ceil(POINT_ANCHORS[POINT_ANCHORS.length - 1][0] / normK(p50Bot));
}

/** Next anchor above `sec` (for "next: 500 pts at 6:00"), or null at the cap. */
export function nextMilestone(sec: number, p50Bot = 360): { sec: number; points: number } | null {
  const k = normK(p50Bot);
  for (const [t, p] of POINT_ANCHORS) if (t / k > sec + 1e-9 && p > 0) return { sec: Math.ceil(t / k), points: p };
  return null;
}
