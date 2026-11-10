/**
 * Sim -> presentation event queue (CORE). Struct-of-arrays, fixed capacity, no allocation.
 *
 * The sim APPENDS events; it never reads them back (events must not influence the simulation,
 * so dropping events on overflow cannot desync a replay). The host (main.ts / bot) consumes
 * them after one or more steps and then calls clear(). Each event carries the tick it happened.
 *
 * Field meaning per kind (unused fields are 0):
 *   kind        a (int)            b (int)            c (int)           x, y            v (float)
 *   HIT         enemy idx          source (SRC/slot)  1 = crit          hit position    damage dealt
 *   KILL        enemy idx          enemy def idx      EF flags          position        xp dropped
 *   GEM_PICKUP  gem idx            gem size tier      -                 position        xp value
 *   LEVEL_UP    new level          -                  -                 player pos      -
 *   OFFER_SHOWN offer kind (OK.*)  card count         -                 -               -
 *   FUSION      result spell idx   slot               fusion count      player pos      -
 *   BOSS_SPAWN  enemy idx          boss def idx       layer             position        max hp
 *   BOSS_KILL   enemy idx          boss def idx       layer             position        seconds alive
 *   TELEGRAPH   telegraph idx      shape              color             position        windup seconds
 *   BURST_HIT   telegraph idx      1 = dodged by dash -                 position        damage taken
 *   PLAYER_HURT DEATH cause kind   -                  -                 player pos      damage taken
 *   HEAL        -                  -                  -                 player pos      amount
 *   DASH        direction 0..63    -                  -                 start pos       -
 *   LAYER_CHANGE new layer 1..5    -                  -                 -               -
 *   CORE_ENTER  -                  -                  -                 -               -
 *   WYRMFALL    phase (0 surface, 1 breath on)       -                 maw position    -
 *   STAGGER     total stagger s    -                  -                 maw position    seconds added
 *   FORMATION   kind (0 ring 1 wall) count            -                 centre          -
 *   CAST        slot               spell idx          -                 origin          -
 *   STATUS      enemy idx          status kind        stacks            position        -
 *   DEATH       DEATH cause        -                  -                 player pos      survival seconds
 *   CHEST       door kind          -                  -                 position        -
 */

export const EV = {
  HIT: 1,
  KILL: 2,
  GEM_PICKUP: 3,
  LEVEL_UP: 4,
  OFFER_SHOWN: 5,
  FUSION: 6,
  BOSS_SPAWN: 7,
  BOSS_KILL: 8,
  TELEGRAPH: 9,
  BURST_HIT: 10,
  PLAYER_HURT: 11,
  HEAL: 12,
  DASH: 13,
  LAYER_CHANGE: 14,
  CORE_ENTER: 15,
  WYRMFALL: 16,
  STAGGER: 17,
  FORMATION: 18,
  CAST: 19,
  STATUS: 20,
  DEATH: 21,
  CHEST: 22,
} as const;
export type EventKind = (typeof EV)[keyof typeof EV];

export class EventQueue {
  readonly cap: number;
  n = 0;
  /** Events dropped since the last clear (cap reached). */
  overflow = 0;
  readonly kind: Uint8Array;
  readonly tick: Int32Array;
  readonly a: Int32Array;
  readonly b: Int32Array;
  readonly c: Int32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly v: Float32Array;

  constructor(cap: number) {
    this.cap = cap;
    this.kind = new Uint8Array(cap);
    this.tick = new Int32Array(cap);
    this.a = new Int32Array(cap);
    this.b = new Int32Array(cap);
    this.c = new Int32Array(cap);
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.v = new Float32Array(cap);
  }

  push(kind: EventKind, tick: number, a = 0, b = 0, c = 0, x = 0, y = 0, v = 0): void {
    const i = this.n;
    if (i >= this.cap) {
      this.overflow++;
      return;
    }
    this.kind[i] = kind;
    this.tick[i] = tick;
    this.a[i] = a;
    this.b[i] = b;
    this.c[i] = c;
    this.x[i] = x;
    this.y[i] = y;
    this.v[i] = v;
    this.n = i + 1;
  }

  clear(): void {
    this.n = 0;
    this.overflow = 0;
  }
}
