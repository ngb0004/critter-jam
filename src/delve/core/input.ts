/** Input frame encoding helpers (CORE). The byte layout is defined in types.ts. */
import { dir64 } from './fmath';
import type { InputFrame } from './types';
import { IN_DASH, IN_DIR_MASK, IN_MOVE } from './types';

/** Encode a move vector (any length; zero = standing) and a dash flag into one input byte. */
export function encodeInput(dx: number, dy: number, dash: boolean): InputFrame {
  const d = dir64(dx, dy);
  let f = d < 0 ? 0 : (d & IN_DIR_MASK) | IN_MOVE;
  if (dash) f |= IN_DASH;
  return f;
}

export const inputDir = (f: InputFrame): number => f & IN_DIR_MASK;
export const inputMoving = (f: InputFrame): boolean => (f & IN_MOVE) !== 0;
export const inputDash = (f: InputFrame): boolean => (f & IN_DASH) !== 0;
