# Delve Daily: architecture and contracts

Design: `/home/user/reports/Delve Daily spec v1.md` (section 13 = slice scope, 7 = balance, 3-6 = run/combat/specs/upgrades, 2 = daily).
Page: `/delve/index.html` (vite input `delve` in `vite.config.ts`). Code: `src/delve/**`. Tests: `npx vitest run src/delve`.
Gem Jam (`src/game`, `src/render3d`, `src/main.ts`, `play/`, `index.html`) is off limits.

The skeleton is playable end to end: move (WASD/arrows, or a floating touch joystick), Firebolt / Creeping Rot auto-fire, bats chase,
enemies die and drop gems, gems give XP, a level-up pauses the sim and shows cards, bosses spawn at :40 with slam telegraphs, the Core
and the Wyrmfall breath run, death shows a results screen with points, a "Top N% est." label and a copy-text share card. Every module
is a **stub that works**; owners replace the inside, keeping the exported signatures below.

---

## 1. Golden rules

1. **Deterministic sim.** Fixed 60 Hz tick. The only inputs are one input byte per tick and offer choices. Same `SeedConfig` + spec +
   inputs + choices = same run, bit for bit (`core/replay.test.ts` checks a 3,600-tick hash).
2. **Allowed maths in `sim/`, `content/`, `core/`:** `+ - * /`, `Math.sqrt`, `floor/ceil/round/trunc/abs/min/max/sign/imul/fround`.
   **Banned:** `Math.random`, `Date`, `performance.now`, `Math.sin/cos/tan/exp/log/pow/atan2/hypot/...`, the `**` operator.
   Use `core/fmath.ts` (`fsin fcos sinIdx cosIdx DIR_X DIR_Y fatan2 dir64 fexp fexp2 flog fpow`). `core/lint.test.ts` enforces this
   (only `core/daily.ts` is exempt; it is never called from the sim).
3. **Randomness only from `w.rng.*` streams** (or a `Rng` built from a hash of sim state, like offers). Never share a stream across
   unrelated systems: drawing an extra number from `w.rng.spawn` in a combat system changes everyone's spawns.
4. **Presentation never writes the World.** Renderer, UI, audio and bots read `World` fields and drain `w.events`. The only writes from
   outside the sim are `step(w, inputByte)` and `choose(w, choiceCode)`.
5. **Events are output only.** The sim appends to `w.events` and never reads it. Overflow drops events (counted) and cannot desync.
6. **No allocation in hot loops** (per enemy / projectile / gem per tick). Pools are struct-of-arrays typed arrays allocated once.
   Allocation is fine at level-ups, offers, boss spawns, and in presentation code outside per-instance loops.
7. **Iteration order is part of the contract.** Iterate pools `0..hi` checking `alive[i]`. Grid queries return candidates in a
   deterministic order. Do not iterate `Set`/`Map` in the sim unless insertion order is deterministic (it is in JS, but be careful).
8. **Original IP only.** No franchise names or art.
9. **Coordinates.** Sim plane is (x, y) metres, arena = disc of radius `w.arenaR` (26 m) at the origin. Renderer maps sim (x, y) to
   three.js (x, 0, -y), so **screen up = sim +y**. Input direction d (0..63): angle = d * 2pi/64, d = 0 is +x, d = 16 is +y.
10. **Time.** `w.tick` counts simulated ticks (paused time is not counted). `seconds = tick / 60` (`seconds(w)`, `minutes(w)`).
    Use `secToTicks(s)` for durations. Score = survival ticks, tie-break `w.score.totalDamage`.

---

## 2. Ownership

Each file has exactly one owner. Edit only your files. If you need a contract change (anything in section 4-8 or a file you do
not own), make the smallest change that keeps the old signature working, and list it in **section 11 Changelog**; CORE (integrator)
reconciles. Adding a new file inside your own directory is always fine.

| Owner | Files |
|---|---|
| **CORE** (architect; later the integrator) | `core/rng.ts`, `core/hash.ts`, `core/fmath.ts`, `core/types.ts`, `core/constants.ts`, `core/events.ts`, `core/pool.ts`, `core/grid.ts`, `core/world.ts`, `core/input.ts`, `core/replay.ts`, `core/daily.ts`, `core/*.test.ts`, `ARCHITECTURE.md`, the `delve` line in `vite.config.ts` |
| **COMBAT** | `sim/player.ts` (movement, HP, dash, heal cap), `sim/spawn.ts` (pressure, spawning, queue, clumps), `sim/enemies.ts`, `sim/bosses.ts`, `sim/hazards.ts` (bursts, telegraphs, formations, Wyrmfall + stagger), `content/enemies.ts`, `content/bosses.ts`, `content/layers.ts` |
| **BUILD** | `sim/spells.ts`, `sim/projectiles.ts`, `sim/zones.ts`, `sim/statuses.ts`, `sim/damage.ts`, `sim/xp.ts` (gems, leveling), `sim/build.ts` (slots, ranks, fusions, passive stats, relic/talent hook dispatch), `sim/offers.ts`, `content/spells.ts`, `content/passives.ts`, `content/fusions.ts`, `content/relics.ts`, `content/talents.ts`, `content/omens.ts`, `content/specs.ts` |
| **RENDER** | `render/**` (three.js scene, instancing, particles, damage numbers, fusion reveal visuals, camera, shake) |
| **UI** | `ui/**`, `app/**` (save, daily UI, share, points, audio, percentile), `main.ts`, `style.css`, `/delve/index.html` |
| **BOT** | `bot/**`, `scripts/delve-*.ts` (headless runs, population distribution for the percentile table, gates) |

Tests: each owner adds `*.test.ts` next to their files (vitest picks up `src/**/*.test.ts`).

---

## 3. Module map

```
src/delve/
  core/        CORE: deterministic foundation, World, step order, replay, daily
  sim/         COMBAT + BUILD systems (one file per system, each exports createXState/updateX + helpers)
  content/     data tables (string ids; numeric index = position in the array)
  render/      RENDER: three.js, reads World + events
  ui/          UI: DOM HUD, cards, screens, input sampler
  app/         UI: save, points, share, percentile, audio
  bot/         BOT: headless bots (input bytes + choice codes, replayable)
  main.ts      UI: boot + fixed-step loop
../../delve/index.html, ../../scripts/delve-run.ts
```

Dependency direction: `content` -> `core/types` only. `sim/*` -> `core/*`, `content/*`, other `sim/*` (cycles are fine: only functions
cross, no top-level evaluation uses another sim module). `render`, `ui`, `app`, `bot` -> anything, read-only.

---

## 4. The World (`core/world.ts`)

```ts
createWorld(seed: SeedConfig, specId: SpecId, mods: Modifiers): World
step(w: World, input: InputFrame): boolean     // false = paused (offer open) or over; nothing changed
choose(w: World, code: ChoiceCode): boolean    // apply a choice to the open offer
awaitingChoice(w): boolean; seconds(w); minutes(w)

interface SeedConfig { day; daySeed (uint32); attempt (seeds burst jitter only); omenId; twistId }
```

`World` fields (all owners read; write only what you own):

| Field | Type | Writer |
|---|---|---|
| `cfg, specId, mods` | readonly | CORE at creation |
| `tick, layer` (1..5, 6 = Core) | number | CORE (`updateClock`) |
| `over, deathCause` (`DEATH.*`) | | COMBAT (`hurtPlayer`) |
| `arenaR` | number | CORE at creation (`WORLD.arenaRadius * mods.arenaMul`) |
| `rng.{spawn,hazard,boss,jitter,combat,loot}` | `Rng` | spawn/hazard/boss/jitter = COMBAT; combat/loot = BUILD |
| `en, pr, zn, gm, tg, al` | pools (below) | see pool table |
| `grid` | `Grid` | CORE rebuilds after enemies move; anyone queries |
| `qA, qB` | `Int32Array(512)` scratch for grid queries: `qA` for outer loops, `qB` for nested (splash inside a projectile loop, spread inside a kill) |
| `events` | `EventQueue` | everyone appends |
| `stats` | `PlayerStats` | BUILD (`recomputeStats`) only |
| `score` | `{ totalDamage, kills, bossesKilled, staggerSeconds, fusions }` | damage.ts / bosses.ts / hazards.ts / build.ts |
| `player` | `PlayerState` (sim/player.ts) | COMBAT |
| `spawn` | `SpawnState` (sim/spawn.ts) | COMBAT |
| `boss` | `BossState` (sim/bosses.ts) | COMBAT |
| `hazard` | `HazardState` (sim/hazards.ts) | COMBAT |
| `spells` | `SpellState` (sim/spells.ts) | BUILD |
| `build` | `BuildState` (sim/build.ts) | BUILD |
| `xp` | `XpState` (sim/xp.ts) | BUILD |
| `offer` | `OfferState` (sim/offers.ts) | BUILD |

Module state types live in their own module, so **owners may add fields to their own state freely**. The "stable fields" listed in
each module's header comment are what RENDER/UI read; do not rename those without a changelog entry.

### 4.1 Pools (struct of arrays)

Every pool extends `SlotPool`: `cap`, `alive: Uint8Array`, `uid: Int32Array` (monotonic id per allocation, lets readers notice slot
reuse), `hi` (iterate `0..hi`), `count`, `alloc(): slot | -1`, `release(slot)`. Allocation is a LIFO free stack (deterministic).

| Pool | Cap | Allocated by | Fields |
|---|---|---|---|
| `en` EnemyPool | 512 (400 drawn trash + bosses/elites/Wyrm head) | COMBAT (`spawnEnemy`, bosses) ; released by `releaseEnemy` (via BUILD's `killEnemy`) | `def` (EnemyDef idx, or BossDef idx if `flags & EF.BOSS`), `flags` (`EF.*`), `x y vx vy` (m, m/s), `kx ky` knockback vel, `r` radius, `hp maxHp`, `speed`, `slow` (status speed mult, written by statuses.ts), `dmg` contact, `xp` drop, `armor` flat, `spawnTick`, `flash` hit-flash ticks, `touchCd`, `aux0 aux1 auxI` (COMBAT AI scratch), `hitStamp[i*12+src]` (BUILD), `stStacks/stTicks/stDps/stSrc[i*6+ST.kind]` (BUILD) |
| `pr` ProjectilePool | 512 | BUILD `spawnProjectile` | `spell` (SpellDef idx), `slot` (SRC id), `x y vx vy r`, `dmg`, `splash` radius, `life` ticks, `pierce`, `target targetUid`, `kind` (`PK.*` STRAIGHT/HOMING/ORBIT), `aux0 aux1` |
| `zn` ZonePool | 128 | BUILD `spawnZone` | `spell slot x y r dmg life maxLife period follow aux0`. `dmg = 0` = visual-only aura ring |
| `gm` GemPool | 768 | BUILD `dropGem` | `x y vx vy value tier` (0-3 size, 4 chest, 5 heal orb) `born state` (0 resting, 1 flying) |
| `tg` TelegraphPool | 96 | COMBAT `addTelegraph` | `shape` (`TG_SHAPE` CIRCLE/LANE/CONE/RING), `color` (`TG_COLOR` RED/VIOLET/GOLD), `flags` (`TGF.*`), `x y x2 y2 r arc`, `start impact linger` (ticks), `dmgPct` (of max HP), `owner` (enemy slot or -1), `resolved` |
| `al` AllyPool | 32 | BUILD (summons; stub uses homing projectiles instead) | `spell slot x y vx vy life cd target aux0` |

Hostile attacks are **always telegraphs** (red floor = move). There are no hostile projectiles.

Status slots per enemy: `ST = { BURN 0, POISON 1, CHILL 2, SHOCK 3, SHADOW 4, SPARE 5 }`. Hit-stamp sources: `SRC = { SLOT0..5 = spell
slots 0-5, FUSION 6, RELIC 7, STATUS 8, ALLY 9, WYRM 10, OTHER 11 }` (the chain stub uses `OTHER` to avoid bouncing back).

### 4.2 Spatial hash (`core/grid.ts`)

Uniform 2 m grid over the arena, rebuilt once per tick after `updateEnemies` (step 7). `w.grid.queryCircle(x, y, r, out) -> count`
returns candidate slots (cell overlap only). Callers do the exact distance test **and the alive check** (enemies killed earlier in the
tick are still listed). Enemies spawned after the rebuild are not in the grid until next tick. COMBAT may use it in `updateEnemies`
for separation (it then holds the previous tick's positions).

---

## 5. Step order (`step()`)

Paused (offer open) or over: return false, nothing changes, tick does not advance. Otherwise `tick++`, then:

| # | System | Owner | Does |
|---|---|---|---|
| 1 | `updateClock` | CORE | layer = floor(t/60)+1 (cap 5), 6 from 5:00; emits LAYER_CHANGE / CORE_ENTER |
| 2 | `updatePlayer(w, input)` | COMBAT | decode input, move, dash (charges, burst immunity), clamp to arena, regen via `healPlayer` |
| 3 | `updateSpawning` | COMBAT | pressure curves, trash spawns, render cap queue, Clumps, formations' bodies |
| 4 | `updateBosses` | COMBAT | spawn at layer second 40, AI (sets boss `vx/vy`), patterns -> telegraphs, enrage, carry-over |
| 5 | `updateHazards` | COMBAT | bursts, telegraph resolution (hurtbox 70%, dash immunity), formations, Wyrmfall, rocks, stagger |
| 6 | `updateEnemies` | COMBAT | trash steering, knockback decay, integrate positions (`v + k`), contact damage |
| 7 | `grid.rebuild` | CORE | spatial hash |
| 8 | `updateSpells` | BUILD | cooldowns (Haste), casts per behaviour, orbits, auras, summons |
| 9 | `updateProjectiles` | BUILD | move, collide, pierce, splash, statuses on hit |
| 10 | `updateZones` | BUILD | pulses |
| 11 | `updateStatuses` | BUILD | DoT ticks, chill slow, expiry |
| 12 | `updateGems` | BUILD | magnet, pickup, Core decay, XP, level-ups -> `queueOffer` (may pause from the next step on) |

Deaths happen inline (`killEnemy`), wherever damage is dealt. A level-up mid-tick opens the offer; the rest of the tick still runs and
the next `step` returns false until `choose` closes every queued offer.

---

## 6. Cross-module functions (stable signatures)

COMBAT exports:

```ts
// sim/player.ts
hurtPlayer(w, amount, kind: HURT.CONTACT|BURST|TRUE, cause: DEATH.*): number  // DR, burst half-DR, dash immunity, death
healPlayer(w, amount): number             // ALL healing (regen, lifesteal, Lightburn, Mend, shields) goes through the heal cap
armorDR(w): number                        // A / (A + K0 + 10m), cap 0.75
refreshMaxHp(w)                           // build.recomputeStats calls it
initPlayer(w); createPlayerState(); updatePlayer(w, input)
// sim/spawn.ts
unitHp(w), spawnRate(w), contactDmg(w), coreStep(w)   // spec 7.1 curves incl. Modifiers
// sim/enemies.ts
spawnEnemy(w, enemyDefIdx, x, y, flags): slot | -1   // trash/elite/clump; HP/dmg/XP from the curves
releaseEnemy(w, slot)                                  // only damage.killEnemy (or a despawn) calls it
knockback(w, slot, fromX, fromY, force)               // ignores bosses / NO_KNOCKBACK / Wyrm
// sim/bosses.ts
onBossKilled(w, slot)                     // called by killEnemy BEFORE release: reward, talent offer, chest
// sim/hazards.ts
addTelegraph(w, shape, color, x, y, r, windupSec, dmgPct, flags, owner): slot | -1  // clamps wind-up to 1.2 s / 0.8 s, + Long Fuse
playerInTelegraph(w, slot): boolean
onWyrmDamage(w, dmg)                      // called by dealDamage for EF.WYRM targets: stagger accounting
```

BUILD exports:

```ts
// sim/damage.ts
dealDamage(w, enemy, amount, src, flags: DMG.*): number  // Might bucket, crit, Ironhide, armor, flash, HIT event, kill
killEnemy(w, enemy, src)                  // order: onBossKilled -> statuses.onEnemyDeath -> dropGem -> build.onKill -> KILL event -> releaseEnemy
canHit(w, enemy, src) / stampHit(...)     // one hit per source per target per 0.2 s
DMG = { CAN_CRIT, DOT, IGNORE_ARMOR, NO_STAMP }
// sim/statuses.ts
applyStatus(w, enemy, kind: ST.*, stacks, seconds, dpsPerStack, maxStacks, src)
onEnemyDeath(w, enemy)                    // spreads (Creeping Rot), proc budgets
// sim/xp.ts
dropGem(w, x, y, value); addXp(w, amount); addXpLevels(w, fractionOfLevel); xpNeeded(level)
// sim/offers.ts
queueOffer(w, OK.LEVEL|TALENT|DOOR|RELIC); applyChoice(w, code)   // OK = offer kinds
// sim/build.ts
addSpell, rankUp, rankMult, addPassive, addRelic, addTalent, recomputeStats, eligibleFusions, fuse, slotOf
onKill(w, e, src); onCast(w, slot); onDash(w)   // relic/talent hook dispatch (player.ts calls onDash)
// sim/spells.ts
slotDamage(w, slot); nearestEnemy(w, x, y, maxR); splashAt(w, x, y, r, dmg, slot, spellIdx)
// sim/projectiles.ts
spawnProjectile(w, spellIdx, slot, x, y, vx, vy, r, dmg, lifeTicks, pierce, splash, kind: PK.*)
// sim/zones.ts
spawnZone(w, spellIdx, slot, x, y, r, dmg, lifeTicks, period, follow)
```

**Damage numbers.** Spell base values in `content/spells.ts` are per hit at rank 1, fit 1. Per-hit damage =
`def.damage * slotFit * rankMult(rank)` (`slotDamage`); `dealDamage` then applies `(1 + stats.might)`, crits, and Omen rules.
Statuses deal `stacks * dps * period` per pulse with `DMG.DOT | DMG.NO_STAMP`.

---

## 7. Events (`core/events.ts`)

`EventQueue` is SoA: `kind tick a b c` (ints) and `x y v` (floats), capacity 8192. The host drains after its steps and calls
`w.events.clear()` (main.ts: once per animation frame; bots/tests: before each step or not at all; overflow is harmless).

| Kind | a | b | c | x, y | v |
|---|---|---|---|---|---|
| HIT | enemy slot (-1 for a splash ring) | src | 0 normal, 1 crit, 2 DoT tick, 3 chain segment (x,y = segment start), 4 splash ring | hit position | damage (radius for c = 4) |
| KILL | enemy slot | def idx | EF flags | position | xp dropped |
| GEM_PICKUP | gem slot | tier | | position | xp |
| LEVEL_UP | new level | | | player | |
| OFFER_SHOWN | offer kind (OK) | card count | | | |
| FUSION | result spell idx | slot | fusion count | player | |
| BOSS_SPAWN | enemy slot | boss idx | layer | position | max hp |
| BOSS_KILL | enemy slot | boss idx | layer | position | seconds alive |
| TELEGRAPH | tg slot | shape | color | position | wind-up s |
| BURST_HIT | tg slot | 1 = dashed through | | position | damage taken |
| PLAYER_HURT | death cause | HURT kind | | player | damage |
| HEAL | | | | player | amount |
| DASH | direction | | | start | |
| LAYER_CHANGE | layer | | | | |
| CORE_ENTER | | | | | |
| WYRMFALL | phase | | | maw | |
| STAGGER | total stagger s | | | maw | added s |
| FORMATION | 0 ring, 1 wall | count | | centre | |
| CAST | slot | spell idx | | origin | |
| STATUS | enemy | ST kind | stacks | position | |
| DEATH | cause | | | player | survival s |
| CHEST | door kind | | | position | |

Add new kinds at the end of `EV` (changelog entry). Never read events inside the sim.

---

## 8. Content types (`core/types.ts`)

- `SpellDef { id, name, keywords (1, or 2 for fusions), behavior, target, owner (null | class | spec), rarity, cooldown, damage, count,
  radius, speed, pierce, duration, status?, areaness, fx, desc, fusion? }`.
  `behavior`: `projectile | splash | chain | orbit | aura | zone | summon | dot-spread`. `target`: `nearest | densest | random | self |
  strongest | behind`. Numeric spell id = index in `SPELLS` (`SPELL_IDX`, `spellIndex(id)`).
- `PassiveDef { id: might|haste|area|crit|vitality|armor|regen|magnet, perRank, cap, rarity, desc, icon }`.
- `FusionDef { id, a, b (keywords), result (SpellDef id), name, desc }`. Rule (spec 6.2): one parent rank 5, the other rank 4+,
  different keywords, max 3 per run. Slice: Plasma Arc (fire+storm), Fever Bloom (fire+poison), Nightshade (poison+shadow).
- `RelicDef { id, name, desc, ledger, rarity, hooks: RelicHooks }`, `TalentDef { ..., classId, row, column, hooks }`.
  `RelicHooks { onAcquire, onCast, onKill, onZoneCreate, onDash, onProjectileSpawn, modifyStats }`, all optional, all deterministic.
- `OmenDef` / `TwistDef` = `ModifierDef { id, name, desc, favours?, apply(m: Modifiers) }`. `buildModifiers(omenId, twistId)`.
- `SpecDef`, `EnemyDef`, `BossDef`, `LayerDef` (with `palette` for RENDER).

**Modifiers** (composed once at `createWorld`, read-only after): pressure (`spawnRateMul unitHpMul contactDmgMul densityMul bossHpMul
burstRateMul burstSizeMul telegraphExtra nSafeAdd arenaMul`), damage rules (`smallHitThreshold smallHitMul bigHitCritMul`), XP and
offers (`xpPerUnitMul xpMul choices rerolls banishes rareWeight epicGateSec gemDecaySec freeMagnetRank`), caps (`hasteCapMul areaCapAdd
healCap maxHpMul mightPerRankAdd armorK0`), and `tags: Set<string>` for rules that need code.

**PlayerStats** (BUILD writes in `recomputeStats`, everyone reads `w.stats`): `maxHpMul armor regenPerSec healCap might haste areaMul
critChance critMult magnetMul xpMul moveSpeedMul extraProjectiles durationMul dashCharges`.

---

## 9. Input, choices, replays, daily

- **Input byte** (`InputFrame`): bits 0-5 direction (64), bit 6 `IN_MOVE`, bit 7 `IN_DASH`. `core/input.encodeInput(dx, dy, dash)`
  quantises any vector with the deterministic `dir64`. `ui/input.ts` samples keyboard + floating joystick (tap < 150 ms / 10 px = dash)
  once per tick.
- **Choice codes** (`ChoiceCode`): `CH_PICK + i` (0..7), `CH_REROLL` (8), `CH_BANISH + i` (16..23), `CH_SKIP` (32).
- **Offer RNG**: `Rng(hashInts(daySeed, specSalt, pickIdx, historyHash, rerollIdx))`, `historyHash = fnv1a(historyHash, hashString(ref))`.
- **Replay** (`core/replay.ts`): `{ v, seed, specId, frames: Uint8Array (frames[k] = input for tick k+1), choices: [{tick, code}] }`.
  `Recorder.frame(f)` after each `step` that returned true; `Recorder.choice(w.tick, code)` for each accepted `choose`.
  `playReplay(r)`, `hashWorld(w)`, `serializeReplay` / `deserializeReplay` (RLE + base64 JSON; a 12-minute run is a few KB).
- **Daily** (`core/daily.ts`, pure functions of a unix ms the app passes in): `dayNumber` (10:00 UTC reset, day 0 = 2026-01-01, so
  2026-11-09 after 10:00 is #312), `daySeed = xxh32([day], LOCAL_SALT)`, `weekNumber` (Monday 10:00 UTC), `weeklyOmenId`,
  `dailyTwistId`, `seedForDay(day, attempt)`, `msUntilReset`. `?day=N` in the URL overrides the day (debug).
- **RNG streams**: `spawn` (shared: spawn kinds/positions/formations), `hazard` (shared: burst positions/nominal times), `boss`
  (shared), `jitter` (per attempt: +-0.5 s burst jitter only), `combat` (crits/procs, per day+spec), `loot` (relic tables/doors).

---

## 10. Constants (`core/constants.ts`)

`BAL` holds spec section 7 v1.1 values, named as in the balance macro-sim (`scratchpad/balance/v11/sim.js` DEFAULTS, `final.json`
round 6): pressure `hp0 hpD hpC coreStep n0 nD nC dmg0 dmgD dmgC`, chip/N_safe, bursts `burstRate0/D/C burstPct0/C burstCap`,
telegraph minimums 1.2/0.8 s, formations, render cap 400 / queue 200 / clump 5, `bossHP [250,750,1600,3000,4600]`, boss burst/enrage,
Wyrmfall `wyrmT 720, wyrmD0 0.005, wyrmDbl 30, staggerDmg 1800, staggerCap 45, mawRadius 4`, player power (`baseDps 30`, fit
0.35-1.35, `rankMult [_,1,1.5,2.1,2.8,3.6]`, `fusionMult 2.4`, caps for Might/Haste/Area/Crit/Vit/Armor/Regen/Magnet, heal cap 1.5%/s,
Limit Break), XP `xp0 16 * 1.07^(L-1)` to L20 then 1.03, Core XP 0.7, gem decay 8 s, slots 6+4, ranks 5, offers (3 choices, 2 rerolls,
1 banish, rarity weights 100/35/10, epic gate 2:00). `CAP` = pool sizes, `WORLD` = geometry/movement, `TIMELINE`, `POINT_ANCHORS`
(spec 9.1). COMBAT/BUILD may tune values they own; note it in the changelog.

---

## 11. What is stubbed (each owner's backlog)

- **COMBAT**: separation/steering, Clumps (5 queued -> 1 at 5x), formations (ring/wall, violet, from 6:00), per-attempt burst jitter,
  lanes/cones in `playerInTelegraph`, boss patterns (slam/spores linger/charge lanes/beam) and soft enrage, carry-over cap 50% into the
  Core, chest doors (Relic/Forge/Elite) after boss kills, Wyrm head enemy (`EF.WYRM`) in the maw ring + rocks, Mend inside the heal cap,
  contact damage tuning (stub is harsh), Siege-style arena edges.
- **BUILD**: real summons (`al` pool), densest-cluster targeting, area radius cap (38% of the short axis), area per-target factor,
  offer algorithm (pity, stage gates, keyword weighting, owned-upgrade guarantee, fusion within 3 picks, no keyword triple, half-ranks
  and Tempered in the Core), relic/talent hook bodies, fusion damage per spec F formula, proc budgets, Lightburn/Mend, chain visuals data.
- **RENDER**: critter meshes per `EnemyDef.mesh`, bosses, biome dressing per `LayerDef.palette`, rim light, emissive spells +
  additive particles, telegraph fill growing inward + lanes/cones/maw, hit flashes, knockback squash, damage numbers (toggle in
  `opts.damageNumbers`), gem fountains, darkened slot-reel fusion reveal (on `EV.FUSION`), reduced-motion handling, interpolation.
- **UI**: captions flow (3 one-time captions), pause/settings (volume/mute, damage numbers, reduced motion), boss off-screen arrow,
  results cause text ("Overrun at 8:12"), share card polish, best-of-day / points top-up display, First Dive, audio palette.
- **BOT**: kiting/greedy/random bots at skill tiers, population runs writing the percentile table (`app/percentile.ts` reads
  `POPULATION`; produce `bot/population.ts` and UI switches the import), the 14:32 bound check, gate scripts.

## 12. Verification

```
npx tsc --noEmit
npx vitest run src/delve          # rng, hash, fmath accuracy/determinism, daily, replay (3,600 ticks x 2 specs), determinism lint
npx tsx scripts/delve-run.ts ember 312 3   # headless bot runs, prints time / cause / hash
```

## 13. Changelog (contract changes)

- v1 (architect): initial skeleton.
- BUILD v1 (build owner). All backwards compatible; new things other owners can use:
  - **Signatures:** `applyStatus(..., src, spread = false)` (spread = this application spreads on death);
    `splashAt(..., spellIdx, exclude = -1)`; new `DMG.PROC` flag (no crit, no Deep Cuts). Straight/homing projectiles hit
    each enemy once via per-projectile memory (`w.spells.prHit`) and pass `DMG.NO_STAMP`; orbits, splash rings and zone pulses
    use the 0.2 s per-source gate.
  - **New files:** `sim/rules.ts` (BUILD: rule flags, proc queue with per-second budgets, relic hook bodies),
    `sim/harness.ts` (BUILD: spell bench against static dummies, tests/tools only). `content/relics.ts` and `content/talents.ts`
    import hook bodies from `sim/rules.ts` (function references only, evaluated lazily): the one exception to content -> types.
  - **Procs:** on-kill effects are queued and flushed at the end of each BUILD system; damage credited to `SRC.RELIC` never fires
    on-kill hooks (procs cannot proc). Shatter (5 chill stacks) uses the same queue, credited to the chilling slot.
  - **Offers:** `OK.DOOR` (Relic / Forge / Elite) and `OK.RELIC` (1 of 3) are real. `queueOffer(w, OK.TALENT)` also queues the chest
    DOOR right after it (a same-tick `queueOffer(w, OK.DOOR)` from COMBAT is dropped as a duplicate). **COMBAT:** export
    `startEliteDoor(w: World): void` from `sim/bosses.ts` and the Elite door appears automatically (offers.ts looks it up at runtime);
    on a cleared elite, call `queueOffer(w, OK.RELIC)` and `forge(w)` (build.ts). Talent rows run out after 2 kills (slice).
  - **Card** gained optional `fit`, `detail`, `weight`; `CardKind` adds `'tempered'` and `'mend'`. `OpenOffer.hadRare`.
    **UI:** title for `OK.DOOR` should read "Choose a door", for `OK.RELIC` "Choose a relic"; show `card.detail` under the title.
  - **XP:** `dropGemFountain(w, x, y, value, n)`, `dropPickup(w, x, y, 4 | 5, value)` (tier 4 chest -> DOOR offer on pickup;
    tier 5 heal orb, value = fraction of max HP, through the heal cap). Kills worth > 8 XP burst into 3-5 gems. Magnet radius base
    2.2 m (WORLD says 1.6) and resting gems within 6 m creep toward the lantern at 1.4 m/s; fountain gems slide with friction
    (`gm.vx/vy` non-zero while sliding).
  - **Summons** live in the `al` pool (Gloom Wisps): `spell slot x y vx vy life target`, `aux0` = bite damage. **RENDER:** draw them.
  - **Events:** `HIT c = 4` rings also come from the fusion shockwave (`b = SRC.FUSION`, radius 6.8, one tick after `EV.FUSION`)
    and from relic procs (`b = SRC.RELIC`). `CAST c = 1` = an Overcharge echo cast. A fusion also fountains 14 gems at the player.
  - **Content:** `cinderTrail` and `bileFlask` are neutral (so both specs can reach all three fusions), `sunSpear` is epic,
    `magmaOrbs` is Pyre-only with the Orbit keyword. Per-spell behaviour extras in `SPELL_X` (content/spells.ts).
  - **Stats:** `recomputeStats` applies every cap after relic/talent/Tempered hooks. Ironhide's small-hit rule ramps x0.3 -> x1 up to
    the 15 threshold (no cliff; small-hit kits lose about 30-45%).
- COMBAT v1 (combat owner). All backwards compatible; existing signatures unchanged.
  - **Player (`sim/player.ts`):** acceleration movement (`MOVE`), wall slide. `HURT.BURST_HARD = 3` (half DR, not dash-immune;
    used for `TGF.NO_DASH_IMMUNITY`). Heal cap is a strict per-tick budget (`healCap x maxHp / 60`, clamped to <= 1.8%/s); excess
    requested heal accumulates in `player.healOverflow` (**BUILD:** Lightburn reads and zeroes it). New `queueHeal(w, amount)` pays
    a lump heal out inside the cap: **BUILD:** heal orbs (`xp.ts` tier 5) should call `queueHeal` (a one-shot `healPlayer` only gets
    one tick of budget). Max-HP gains (Vitality) are queued through the cap too (no heal leak via `refreshMaxHp`). Fields for UI:
    `lastHurtCause`, `lastHurtTick`, `dmgByCause[DEATH.*]`, `healedTotal`. `BOUND_SECONDS = 872`: hard 14:32 backstop.
  - **Telegraphs (`sim/hazards.ts`):** `TG_SHAPE.RING` is an annulus, inner radius in `tg.arc` (0 = disc). `CONE`: apex (x, y),
    direction toward (x2, y2), length r, half-angle arc. `LINGER_HURTS`: impact deals dmgPct/2, then dmgPct x maxHP per second
    while inside for `linger` ticks. New `addTelegraphCat(..., cat: TGC.*, lingerSec)` with per-category caps, `pointInTelegraph(w,
    i, x, y, hr)` (bots), `cancelTelegraphsOf(w, enemySlot)`. Bursts: shared schedule from `w.rng.hazard` (fixed draws per burst),
    +-0.5 s per-attempt jitter from `w.rng.jitter`; circles, lanes from 2:00, cones from 3:00, doubles from 8:00.
  - **Wyrmfall:** maw opens at 11:52 (`EV.WYRMFALL a = 0`, gold RING telegraph flagged `TGF.MAW`, `hazard.mawOpen/mawX/mawY/mawR`),
    the head surfaces at 12:00 (`a = 1`): an `EF.WYRM` enemy (`ENEMIES` idx 8 `wyrm`, mesh 'elite' - **RENDER:** key off `EF.WYRM`)
    at the arena edge behind the ring, `hazard.headSlot`. `hazard.inMaw`: while true, 50% of off-target damage is mirrored onto the
    head (`SRC.WYRM`, `DMG.DOT`). Rocks: `TRUE_DAMAGE | NO_DASH_IMMUNITY` circles, 0.3/s outside the ring, 0.9/s inside.
    **BUILD:** consider having `nearestEnemy` skip `EF.WYRM` unless `w.hazard.inMaw` (spells otherwise waste on the head).
  - **Bosses (`sim/bosses.ts`):** several can be alive (carry-over); per-boss arrays `slot[5] enrage[5] ...`, `liveCount`;
    `active/defIdx/spawnedTick` = the newest live boss. Soak = `BAL.bossSoak` (0.1, ramped in over `BAL.bossSoakRamp` 8 s) of off-boss damage diverted onto the nearest live
    boss within 18 m (`SRC.OTHER`, `DMG.DOT|NO_STAMP|IGNORE_ARMOR`). `startEliteDoor(w)` exported (Elite door). On an elite clear:
    `forge(w)` + `queueOffer(w, OK.RELIC)` with `boss.relicChoices = 4` (**BUILD:** read it for the card count; reset to 3 on boss
    kill). `EV.CHEST a`: 0 chest dropped (b = boss idx), 1 elite fight started (v = seconds), 2 elite cleared, 3 elite escaped.
  - **Enemies:** `content/enemies.ts` appends `slimelet` (7) and `wyrm` (8); `EN.*` numeric ids; `ENEMY_AI` (separation, knockback
    scale, flat armor). Each spec "unit" spawns as `BODY_SPLIT = 2` bodies at half HP/XP (mass and XP flow per spec 7.1 unchanged;
    contact per body x0.65). Clumps carry `aux1` = bodies folded in and grow when the field is pinned at 400 (`spawn.mergeInPlace`).
  - **Spawn/formations (`sim/spawn.ts`):** day-seeded formation schedule (own `Rng`, identical for every player): ring (24) or wall
    (20), violet marker telegraph (`TGC.FORMATION`, dmgPct 0) ~1 s before, `EV.FORMATION`. Members carry `EF.FORMATION` until
    released. Fields: `trashAlive queued clumps dropped formationUntil nextFormationTick`.
- RENDER v1 (render owner). No sim or contract changes; presentation only.
  - **Files:** `render/renderer.ts` (orchestrator, same public API: `new DelveRenderer(canvas)`, `opts`, `resize`, `onEvents`,
    `render(w, dt)`, `camera`), `render/env.ts` (cave floor, walls, biome props from `daySeed` + layer), `render/actors.ts`
    (critters per `EnemyDef.mesh`, one mesh per boss, the Wyrm head keyed off `EF.WYRM`, delver + lantern, pickups, projectiles,
    `al` summons, zones, telegraph decals, Wyrmfall boulders, blob shadows), `render/fx.ts` (pooled particles, glows, rings,
    lightning, damage numbers), `render/geo.ts`, `render/materials.ts`, `render/post.ts` (bloom + overlay + quality governor),
    `render/debug.ts`, `render/util.ts`, test `render/readonly.test.ts` (static scan: render never assigns into the World, never
    steps/chooses, never pushes events, never imports `sim/`; `debug.ts` exempt, see below).
  - **Options:** `RenderOptions.screenShake?: boolean` (optional; shake is also off whenever `reducedMotion`). `damageNumbers`
    toggles numbers. `renderer.fusionActive` is true while the fusion darkening holds (FUSION event until the fusion shockwave
    `HIT c = 4, b = SRC.FUSION` plus 0.9 s; it waits up to 4 s while UI holds the sim for the reel).
  - **Interpolation:** the renderer mirrors the host's accumulator from `dt` and `w.tick` deltas, so `render(w, dt)` must keep
    receiving the real frame `dt` (0 while paused is fine). Events are copied in `onEvents` and handled during `render`.
  - **URL knobs:** `?quality=0..4` pins the quality level (4 = bloom + DPR 2, 2 = no bloom DPR 1.5, 0 = DPR 0.75); otherwise the
    governor steps down when frames run long (bloom first). `?bloom=0|1` pins bloom. `?debug` shows FPS / draw calls / CPU ms and
    exposes `__delveRender.stats()`, `__delveStress(on)` (draws a private stress World: 400 enemies, 300 projectiles, 500 gems)
    and `__delveShow(fn)` (draws a test-built World from a provider). These never touch the live run's World.
- UI v1 (UI owner). No sim contract changes; presentation-side additions only.
  - **RENDER:** `main.ts` writes `renderer.opts.screenShake` (boolean, false when the player turns shake off or picks reduced
    motion) next to `reducedMotion` / `damageNumbers`; please gate camera shake on it. The fusion reveal is a DOM overlay
    (`ui/fusion.ts`): on `EV.FUSION` the host stops stepping for ~1.6 s while a slot reel spins, then resumes, so the sim's
    fusion shockwave ring (`HIT c = 4`, `SRC.FUSION`) lands as the name lands. `renderer.camera` is read for the off-screen
    boss arrow (projection only).
  - **Save** (`app/save.ts`, key `delve-daily.save.v1`, schema v2, v1 migrates): settings, per-day best (time, damage
    tie-break, spec, glyphs, serialized replay), attempts, points ledger (first pay-out + top-ups), last 60 runs, captions seen.
    `settleRun()` is the single writer. Points: `app/points.ts` (spec 9.1 anchors, day normalisation hook).
  - **Percentile:** (superseded by INTEGRATION v1: the real-engine bot table is live.) Was: the spec 7.5 placeholder; **BOT:** export the same `Population`
    shape from `bot/population.ts` and swap the import in `percentile.ts` (UI will do it on request).
  - **Debug URL params** (presentation only, the sim still moves only via step/choose): `?speed=N` ticks per real tick,
    `?bot=1|move|idle` autoplay via `bot/bot.ts` (`move` = inputs only, cards wait), `?go=ember|venom` start at once,
    `?fresh=1` in-memory save. Console: `__delve()`, `__delveUI()`, `__delveDebug.{setSpeed,setBot,previewFusion}`.
- INTEGRATION v1 (CORE as integrator). Glue and feel fixes after the four builders; no signature changes.
  - **BOT:** `bot/bot.ts` is now COMBAT's dodging bot (per-telegraph notice chance `e`, shortest-way escape, dash near impact,
    stands in the maw during the Wyrmfall, greedier gem routing). `scripts/delve-bots.ts` prints a survival table;
    `scripts/delve-population.ts` generates `bot/population.ts` (real-engine daily-best quantiles), which
    `app/percentile.ts` now uses (`POPULATION`); the spec 7.5 table stays as `SPEC_SIM_POPULATION`.
  - **XP (BUILD file, feel):** `xpNeeded` levels 1-4 are 5/8/11/14 (onboarding ramp: first card at ~0:10-0:19 instead of
    0:28-0:46); level 5+ is the spec curve.
  - **Firebolt (BUILD file, balance):** cooldown 0.8 -> 0.65 s, damage 20 -> 22 (Ember trailed Venom by ~25% in bot means).
  - **Debug guard:** `?guard=1` adds the `debug-guard` Modifiers tag: `hurtPlayer` floors HP at 40% except for Wyrmfall damage, so
    test runs reach the Core and the Wyrm. Guarded runs are never settled into the save, never ranked, and are not replayable
    from the stored seed (the tag is not in `SeedConfig`).
  - **RENDER (feel):** the camera eases back (x1.28) and toward the maw while the Wyrm is up, so the head is in frame; damage
    numbers refill at ~36/s instead of 12 per frame; splash glows are smaller and dimmer (late-game bloom soup).
  - **Tests:** `core/replay.test.ts` adds a full-run check: a bot plays to its death the way `main.ts` drives the sim
    (events drained every 7 ticks, choices recorded at the paused tick), the serialised log replays to the same hash.
  - **Preview:** `vite preview` uses base `/` (the config sets `/critter-jam/` only for `build`); to check the Pages base run
    `npx vite preview --base /critter-jam/` and open `/critter-jam/delve/`.
- JUICE v1 (RENDER + app/audio owner, polish pass). Presentation only; no sim numbers or sim files touched.
  - **`main.ts` (one line):** `audio.onEvents(ev, w)` now also passes the World (read-only) so audio can pan by the listener,
    run the biome drone, the Core heartbeat and the Wyrm breath hiss. The old one-argument call still works.
  - **Renderer:** per-biome colour grade (`post.ts` grade pass, `materials.gradeMaterial`, skipped at quality 0); spell VFX
    scale with `build.slotRank` (`actors.rankK`: projectile size/glow/trail, rank-5 white-hot star cores, splash rings, chain
    width, zone shader `aB.w` with a rune ring at rank 5); kill pops (the critter balloons white and bursts into bouncing
    chunks); hit squash + knockback lean + dust; hopping slimes, waddling shrooms, stomping golems; gem fountain arcs and
    pickup sparkle trails that heat up with the combo, lantern flare on pickup; damage numbers with tight kerning, pop-in,
    log-scaled size and a '!' wobble on crits; boss intro (cave dims, camera leans toward the boss, slam ring when it lands);
    fusion charge-up (inward spiral, snapping rings, light pillar) and a much bigger shockwave (rays, every critter flashes,
    tinted screen flash), with the darkening released faster; the Wyrmfall (light drains while the maw is open, grit rain,
    a white-orange flash when the head breaks through, camera pulls back and tips top-down when the head is on the camera
    side); the Core heartbeat (vignette + grade pump on the shared `render/util.coreBeatPhase` clock) and floor ember jets.
    Particle density follows the quality governor. `renderer.timeScale` (debug, screenshots) slows presentation time.
  - **Audio:** cave echo send, sfx bus that ducks under the fusion reveal, per-kind live-voice caps + global cap (big moments
    bypass it), random pitch per voice, stereo pan by x, keyword-coloured hits, size-pitched kill pops, gem arpeggio shimmer
    every 8th pickup, layered boss roar (pitch per boss), maw rumble, Wyrm roar, stagger clang, dodge whiff, formation chime,
    biome drones (a tritone in the Core) and the Core heartbeat thump.
- BOT v1 (bot owner + balance). No signature changes; numbers only outside `bot/` and `scripts/`.
  - **Bots (`bot/bot.ts`):** `Delver` class (stateful, seeded, read-only). One skill scalar `e` derives notice chance per
    telegraph (0.72-0.99), reaction delay (30-8 ticks), decision cadence, look-ahead horizon (0.25-1.1 s), kiting radius,
    crowd awareness, fumbles, dash use, maw-ring use; every knob is overridable in `BotSkill`. Pick policies
    `random | decent | greedy` (`cardValue` heuristic; greedy rerolls weak offers and banishes a dead spell card).
    `botInput(w, {e})` / `botChoose(w)` keep their old signatures (one Delver per World in a WeakMap).
  - **Runner (`bot/runner.ts`):** `runBot({seed, spec, bot, omenId?, record?})` -> telemetry (time, cause, picks per minute,
    first card, fusions, boss kill times, damage by cause, XP share, hash, optional replay). Test: `bot/bot.test.ts`.
  - **Population (`scripts/delve-pop.ts`):** child-process parallel; tiered population (casual 50 / average 30 / good 15 /
    great 4 / elite 1 %, 1-20 attempts, daily best), gates printout, Omen experiment, `--ladder N` skill curve,
    `--set k=v,...` runtime overrides for sweeps, `--write-table` regenerates `bot/population.ts` (labelled as a
    bot-population estimate). `scripts/delve-population.ts` is superseded.
  - **Balance (`core/constants.ts` BAL, numbers only):** hp0 11->16, hpC 0.34->0.42, coreStep 1.5->1.6, dmg0 2.0->3.0,
    dmgD 0.16->0.2, dmgC 0.2->0.25, burstRate0/D/C 0.05/0.15/0.15 -> 0.07/0.45/0.1, burstPct0/C 0.12/0.09 -> 0.29/0.05,
    telegraphCore 0.8->1.0 s (the 0.8 s cliff at 5:00 piled 6.7% of daily bests into one 10 s bucket). Why: on the real sim
    the horde almost never reaches a moving player (spells one-shot the Descent; a circling bot that ignores the crowd
    lived 6:40), so the old numbers gave a bot median near 10:00. **COMBAT:** the hazards.ts header comment still
    quotes the old burst numbers.
- UI v2 (UI/UX polish). Presentation only; no sim, content or contract changes.
  - **New files:** `ui/art.ts` (inline SVG: home hero delver + lantern in a cave mouth, Omen badges swarming/ironhide, Twist
    badges, onboarding panels), `ui/onboard.ts` (`showOnboarding(parent, onDone, onClick?, finalLabel?)`: 4-panel First Dive
    tour shown before the first run; `seenCaptions` gets `'onboard'`; replayable from How to play).
  - **Home:** hero art, omen/twist art, sticky DIVE bar on phones, two-column layout on desktop (>= 900 px) and phone
    landscape (height <= 520 px). Spec picker is a radiogroup.
  - **Results:** time counts up and lands, NEW BEST stamp + confetti + fanfare, points tally with a day bar and next
    milestone, a population curve under "Top N% est." (reads `app/percentile` POPULATION), a ticket-style share card
    preview over the copy text, sticky DIVE AGAIN. Tap skips the show; reduced motion shows the end state.
    `ResultsData` gained `cause`, `bestSpec`, `bestKeywords`, `reduced`; `ResultsCallbacks` gained optional `onStamp`,
    `onTally`, `onFanfare` (new `DelveAudio.stamp/tally/fanfare`).
  - **Touch:** tap-to-dash window 180 ms / 12 px (was 150 / 10); a quick second-finger tap dashes while the first steers;
    a gold ring marks each dash tap. Dash button hit area +12 px; its glow no longer clips to a square.
- FIX v1 (fixer pass on the QA findings; touches every owner's files, listed by area). `SIM_VERSION` 1 -> 2.
  - **Telegraphs (RENDER):** the fill now grows from the MIDDLE outward (it reaches the rim at impact); the whole area is
    tinted (alpha 0.3) with a solid bright rim from frame 0. RING telegraphs (safe inside) draw a dashed pale inner edge
    and a cool safe tint. A rim-only copy (`telegraphMaterial(true)`, depthTest off, renderOrder 40) draws every warning
    outline over critters and walls. A non-drainable ground ring marks the delver (brighter in the Core).
  - **Fusion reveal (UI):** the sim stays held until the overlay starts fading (`FusionReveal.show` gained `onResume`, fired
    at land + 1.0 s; `onLand` is only the boom). The fade is 0.3 s and the name card flies to the top strip.
  - **Camera / scene (RENDER):** camera-side walls, stalagmites and edge props are flattened (`env.camFlat`, down to 28%
    height due south at the rim). Wyrmfall camera: lean toward the maw capped at 3 m, pull-back capped at +26%, light drain
    0.14 while the Wyrm is up (was 0.38). Biome identity: the lantern pool takes 72% of the biome light colour in layers
    2+ (teal / cold blue), fungal/flooded ambient 0.55 -> 0.8, layer 2/3 grade centres tinted. Core veins, rim and grade
    edges are violet, not red; Core vignette 0.72 -> 0.62. Mushroom walkers are cream (`content/enemies.ts`), not pink-red.
  - **Balance (`BAL`, numbers):** burstPct0 0.29 -> 0.22, burstRateD 0.45 -> 0.34, burstRate0 0.07 -> 0.08, hp0 16 -> 13,
    hpD 0.33 -> 0.45, hpC 0.42 -> 0.48, coreStep 1.6 -> 1.7 over 310-410 s, dmg0 3 -> 2.2, dmgD 0.2 -> 0.46, dmgC 0.25 -> 0.3
    (gentler layers 1-2 for players without crowd awareness, about the same pressure at 5:00),
    bossHP x2 ([500, 1500, 3200, 6000, 9200]; v1.0 was [250 .. 4600]), xp0 16 -> 14, xpCore 0.7 -> 0.85. Magnet base 2.2 ->
    2.6 m, lantern creep 1.4 -> 1.8 m/s (`sim/xp.ts`, `WORLD.gemPickupRadius`). Late-Core double bursts ramp in over
    8:00-10:00 (was a step at 8:00). Rocks 0.3/0.9 -> 0.12/0.36 per s (spec 7.4: 0.12). Bot population (`delve-pop.ts --players
    160 --days 312,315,319,326,340,349`, table regenerated): deaths overrun 49% / red 50% (was 8% / 90%), median 7:38 (was
    ~6:18), CV 0.175, largest 10 s bucket 5.9% (gate 2 still above 4%), boss kills 9-18 s after spawn (was 7-15 s),
    Swarming Ember +0.2% / Venom +11.8%, first card p50 11.3 s casual / 13.5 s average. A fully overrun-driven tuning (spec 60-75%)
    was tried and rejected: overrun is nearly deterministic for the bots, so every tier piled into one Core wall (CV 0.12,
    9% of bests in one 10 s bucket) and the top end lost the Wyrmfall. Re-tune after a human playtest.
  - **Boss soak = diversion (COMBAT/BUILD):** while a boss is within 18 m, damage to trash is x0.5 (`damage.ts` reads the new
    `BossState.divert`) and the diverted half lands on the nearest boss next tick (`divertPrev/divertSrcPrev`). The Wyrm
    ring uses the same mechanism (spec 7.4: trash clearing halves in the ring). `SOAK_SHARE` 0.45 -> 0.5. A boss kill
    queues a 25% max-HP heal through the heal cap (`BOSS_KILL_HEAL`).
  - **Omens:** Ironhide uses spec v1.1 (small hits x0.85, big crits x1.10; was x0.3 / x1.15). Swarming xpPerUnitMul 0.7 ->
    0.6 and no `favours` claim; the home screen no longer shows "Favours ..." / "Omen pick".
  - **Offers (BUILD):** `fusionFirst[f]` resets when the fusion stops being eligible; `canBanish(w, card)` (exported) also
    refuses the rank-up of the spec's signature spell. Card copy: no "fit today xN" (the "Strong today" badge stays), rank
    cards say "+50% damage", passives reworded for non-gamers ("Area" is now "Wide Reach").
  - **Replays (CORE):** `playReplay` throws `ReplayVersionError` when `v !== SIM_VERSION` (`replayCompatible()`);
    `Replay.tags` records `debug-*` Modifiers tags (serialised as `t`). `core/lint.test.ts` hashes BAL/CAP/TIMELINE/WORLD
    against `SIM_VERSION`: change a constant -> bump the version and add the new hash.
  - **createWorld** falls back to Ember for an unknown spec id. `app/save.ts migrate` drops unknown `lastSpec`, caps `days`
    at 120 and keeps best replays only for the newest 14 days (`pruneDays`, also on every write); `saveHealth.ok` drives a
    "Progress can't be saved" note on home. `main.ts`: fatal-error screen with "Reset save" before boot finishes or if the
    frame loop keeps throwing; mid-run caption saves are deferred to pause / run end; debug runs (`bot`, `speed != 1`,
    `guard`, a `?day` other than today) settle into a session scratch save; audio suspends in a hidden tab in every state;
    home re-renders on the daily reset (live countdown) and on returning to a visible tab.
  - **UI:** fusion chip on NEW / RANK cards ("Fuses with Firebolt -> Plasma Arc (R5 + R4)", `ui/fusionhint.ts`) and fusion
    meters under the HUD slots; rank line "Top N% est." only in the top half, else "Beat N% of bot runs (est.)"; the share
    text uses a depth milestone below the median (`shareRank`, "Reached Layer 3"); "Rank today" shows the day's BEST with
    "This try" separately; a pinned share button on results; the death tip moved up; chip deaths pick the story from
    `player.dmgByCause` ("Worn down" when red floor did most of the damage) and the minute HP fell below 50% for good;
    boss banner in the upper third for 1.4 s; HP shows just the current value under 440 px; the XP bar pulses gold when
    level-up gems lie within 6 m; "Gold = grab!" fires the first time 15+ gems lie on the floor; captions hide under the
    pause sheet. Input: a held movement key survives pause/blur (repeats re-add it), a dash queued while cards were open is
    dropped on the pick, and a second finger takes over steering when the first lifts.
  - **Not changed:** `vite.config.ts` preview base (a Gem Jam-wide change; lead to decide), sim per-tick allocations
    (needs `--trace-deopt` profiling), per-Omen percentile tables.
- v0.2 UI (UI owner; no sim change, `SIM_VERSION` untouched).
  - **Cards:** `ui/cardcopy.ts` (new, tested in `ui/cardcopy.test.ts`) writes each level-up card's numbers line from the
    sim's own tables: rank-ups say "Rank 2 → 3: +40% damage" (`rankMult` ratio from the owned rank, Core half-ranks
    included), passives state their total after the pick with caps, Armor states its damage reduction at the current
    minute (`armorDR` formula, half against red floor). On short phones a rank-up card shows this line instead of the
    spell description. The "Pick a card." caption is gone (the card header says it).
  - **Formation caption** names what the renderer draws violet (`0xb070ff`: the 1 s marker and the formation critters),
    not a "violet floor": "A ring/wall of violet critters ...". Toast border uses the same colour.
  - **Results:** the day total counts up in lockstep with the "+N" tally and the bar (no "+585 next to 780 / 1,000"
    mid-count); desktop (>= 900 x 560) uses two columns so the share card sits above the pinned DIVE AGAIN bar; the
    ticket uses `shareRank` like the share text. Boss/Wyrm off-screen arrow stays below the boss bar.
  - **Demo runs** (`guard`, `bot`, `speed`, another `?day`): home and results show a "Demo run (...) · not saved" tag,
    the stamp says "Demo run" (never "First dive today"), points read "demo points, not saved". `ResultsData.demo`,
    `HomeData.demo`.
  - **Onboarding:** five panels (keep moving; red floor aims where you stand + dash; gold gems + the "Fuses with" tag;
    the goal: retries free, best counts, dying early is normal). Two new one-time coaching captions: `still` (no steering
    for 3 s in the first 90 s) and `redhit` (first red-floor damage: walk out sooner or dash).
- RENDER v0.2 (render owner: in-run readability). Presentation only; no sim, content or contract changes.
  - **The delver is never buried:** delver + lantern draw in an on-top depth band (`toyMaterial({ onTop })`, depth squeezed
    in front of the scene around `materials.uAnchor`, own depth order kept) and are self-lit; a cream outline hull
    (`hullMaterial`, red while hurt) sits just behind them. The ground ring is thicker, breathes, has a dark halo, and sits
    in a band over critters but under the delver (`onTopBasic`). Critters within ~2.8 m (3.4 m in the Core) of the delver
    darken/desaturate and their hit-flash whitening is muted (`toyMaterial({ nearDim })`, `materials.uNear`). Lantern
    floor pool wider/brighter in the Core.
  - **Telegraphs:** solid red wash (alpha ~0.44) + thick bright rim from frame 0, brighter fill behind a white-hot front
    growing middle -> rim at impact, last 20% throbs; the over-the-crowd copy now also washes the area and shows the
    front. The sim frees a warning ~0.1 s after impact, so the impact flash is drawn by the renderer
    (`ActorFrame.onImpact`: white filled flash + shock ring + glow; lanes flash as beams).
  - **Walls:** shader cutaway (`toyMaterial({ cutaway })`, `materials.uFocus`) sinks walls/stalagmites/props to ~22%
    height everywhere except clearly up-screen of the delver (on top of the static `camFlat`).
  - **Colour:** critters use a greyer rim (`uRimCritter`); Core grade edges are cool-neutral (the old magenta cut turned
    cream shrooms pink and violet clumps red-pink) and the heartbeat pump darkens violet, not red; formation tint 0.45
    -> 0.3 (+ glow).
  - **Wyrmfall camera:** frames the head's floor point and the delver: pull-back up to +95%, lean so the head sits
    within ~52% of the half-extent and the delver within ~46%; fog distance follows the zoom. Skull lighter + stronger rim.
  - **Damage numbers:** hits on the same critter within 0.45 s fold into one climbing number (`DamageNumbers.hit`), size
    relative to a running typical hit (chip damage small + dim, totals capped in size), 32 numbers max, ~12 new/s, and
    numbers fade out within ~2 m of the delver so they never cover it.
  - **Debug:** `?debug` adds `__delveWarp(sec, spec?, day?)`: a private guarded bot world fast-forwarded to `sec`, drawn at
    1 tick per frame (look checks of the Core / Wyrmfall without a 12-minute run).
- BOT v0.2 (bot owner: sim numbers, content numbers, bots, population). `SIM_VERSION` 2 -> 3 (constants hash `f5d34738`).
  - **Balance (`BAL`, numbers):** bursts 0.08/0.34/0.10 rate, 0.22/0.05 size -> 0.07/0.30/0.06, 0.16/0.06; hp0 13 -> 14,
    hpD 0.45 -> 0.58, hpC 0.48 -> 0.21, coreStep x1.7 over 310-410 s -> x2.1 over 300-540 s; dmg0 2.2 -> 1.0, dmgD 0.46 ->
    0.66; n0 1.6 -> 1.3, nD 0.2 -> 0.26; bossHP [500,1500,3200,6000,9200] -> [550,1900,2400,7000,10000]; enrage 20/40 s ->
    25/60 s; new keys `bossSoak` 0.1 (was the 0.5 `SOAK_SHARE` const; it now reads BAL) and `bossSoakRamp` 8 s.
    `bossBurst` 0.13 -> 0.10 now actually scales every boss pattern (`bosses.ts bossPct`; the key was unused).
    Layer 5 mix: golem 3 -> 2, +1 slime (`content/layers.ts`).
  - **Burst jitter (`hazards.ts`):** the +-0.5 s jitter was seeded by the attempt number only, so every player's Nth attempt
    shared each burst tick. It now mixes the attempt draw with a hash of the run's own state (lantern position, tick, burst
    count): replayable, different per run. Test: `sim/balance-v02.test.ts`.
  - **Heal cap:** the max-HP leak was already closed (`refreshMaxHp` queues the gain inside the cap); a regression test now
    takes 5 Vitality ranks at 50% HP and checks HP does not move at the pick and pays out <= 1.5%/s (fails if reverted).
  - **Swarming (`content/omens.ts`):** hpU x0.6 -> x0.63, and two tag rules: fire splashes x1.3 radius
    (`spells.ts SWARM_FIRE_SPLASH`), rot / Wildfire jump radius 2.5 -> 1.9 m (`statuses.ts SWARM_SPREAD_R`). Omen desc
    gained "Fire splashes burst wider; rot jumps shorter." **UI:** shows the desc as before.
  - **Bots / population:** casual tier e 0.15-0.45 -> 0.0-0.35 (random 50%), average 0.40-0.65 -> 0.30-0.55; skill model
    `kiteR` 0.6 + 2.0e, `crowdAware` 0.15 + 0.85e. `delve-pop.ts` prints per-Omen percentiles, fusions and 12:00 reach per
    tier, and `--write-table` also writes **`BOT_POPULATION_BY_OMEN` + `populationForOmen(id)`** in `bot/population.ts`.
    **UI:** pass `populationForOmen(seed.omenId)` as `pop` to `topLabel/topPercent/shareRank` and the results curve.
  - **Population** (`--players 160 --days 312,315,319,322,326,333,340,349 --omen-bots 16 --write-table`, 1,280 daily bests):
    p10 4:11 / p50 6:41 / p90 9:04 / p99 11:00, max 12:12, CV 0.29; largest 10 s bucket 4.38% (was 5.94%); deaths overrun
    73% / red 23% / boss 4% (was 49/50/1); boss kills 20-31 s after spawn (was 9-18 s); 1 elite run reached the Wyrmfall
    (was none); Swarming Ember +3.2% / Venom +15.0% (16 bots/day; a 60-bot run read +5.2% / +12.0%); Ironhide +1.4% / +2.9%.
- FIX v0.2 (fixer pass on the v0.2 fresh-eyes + tech review; touches several owners' files). `SIM_VERSION` 3 -> 4
  (constants hash `ba13b757`).
  - **Balance:** `BAL.enrageStart/enrageLen` 25/60 s -> 35/80 s; a new layer's enemy mix fades in over its first 20 s
    (`sim/spawn.ts MIX_BLEND_S`, decided from the low digits of the existing kind roll, no extra rng draw); Swarming hpU
    x0.63 -> x0.66. Quick population (days 312/319/326): largest 10 s bucket 6.94% at 4:10 -> 5.0% at 5:00 (4:10 now 4.4%),
    p10 4:05 / p50 6:37 / p90 9:17 / p99 11:46, CV 0.315, overrun 73%; days 333/340/347: 5.6% at 8:10 (gate 2 still
    open). Omen experiment (60 bots/day x 3 days): Swarming +7.1% (Ember +7.2 / Venom +7.0), Ironhide +0.1%.
  - **Bosses:** the dead `SOAK_SHARE` const (captured `BAL.bossSoak` once at load, so `--set bossSoak=` sweeps never
    reached it) is gone; the soak reads `BAL.bossSoak`.
  - **Render:** player zones are a faint haze with a DASHED rim (hazards keep a solid wash + solid rim); splash rings
    thinner/shorter, ring disc fill halved, telegraph post-impact afterglow 0.6 -> 0.35 s, impact ring 0.45 -> 0.3 s;
    boss-intro camera lean clamped so the delver stays within ~35% of the half-extent; damage numbers stop folding at
    5 digits (no more pinned "99999" on the Wyrm).
  - **UI:** fusion hints in plain words with picks-to-go ("Rank this to 5 and Firebolt to 4 to fuse them into Fever
    Bloom (3 more picks)", "1 pick from ...!", "Unlocks ...!") and a gold highlight one pick out (`cardFusionHint` now
    returns `{ text, picks }`); results lead with progress ("Reached Layer 3 · Next: Layer 4 at 3:00") for runs in the
    bottom tenth, the bot rank in small print; death tips name the counter to the boss that was up (`BOSS_TIPS`) or flag a
    spread build; new-best delta floors both times; boss arrow avoids the dash button and spell slots; toasts wrap;
    layer / Core banners sit above the delver and fade when red floor is within 1.5 m; joystick knob is a see-through
    ring and captions lift above it while touching; desktop HUD scales up from 1000x640; demo pill over the left results
    column; "earned this try"; onboarding says "pick a card".
