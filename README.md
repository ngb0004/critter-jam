# Gem Jam (repo: critter-jam)

A toy-box sorting puzzle for phones, in a chunky 3D diorama look.

A mine floor packed with gems in colour groups. Colour-coded carts roll in on
the rails, one at a time, three seats each. Tap a gem with a clear path to the
front: if it matches the cart it hops aboard, otherwise it waits on the tray.
Fill the tray and you're stuck. Back rows stay hidden until the rows in front
clear, so every level has a reveal and a plan that goes wrong late.

**Landing page:** https://ngb0004.github.io/critter-jam/
**Play:** https://ngb0004.github.io/critter-jam/play/ (deploys on every push to `main`)

Handy URLs (on `/play/`): `?level=N` jump to a level, `?skin=critters` the animals-and-buses
look, `?capture` frame-stepped mode for ad recording (`window.__jam.advance`).

## The big moments

- **Avalanche.** On a chain of three clean boardings, a cart that arrives to
  find its colour already fully reachable fills itself and rolls away, and the
  next cart gets the same chance. Runs of ×3, ×4, ×5 with a climbing chord,
  camera shake and coin bonuses. The skill is setting it up.
- **Fever.** Clean play fills a meter; full meter means seven seconds in which
  every tap drags the cart's remaining gems in from anywhere on the board.
- **Prism** (wild, fits any cart) and **Magnet gem** (board it and its two
  mates fly in from anywhere) on selected levels.
- **Chain counter** for consecutive direct boardings, with coin drops.

## Economy (v1)

- **Coins** from wins (+15, plus a tidy-tray bonus), chains and avalanches. Starting purse 300.
- **End Game Offer**: tray full → +2 slots for 150 coins, once per level.
- **Rewarded video** (placeholder countdown for now): +1 slot.
- **Boosters**: Undo (40), Magnet (120), Shuffle (80, solver-checked). A gift booster every third win.
- **Streak**: a win a day extends it; one missed day spends a freeze.
- No energy system, no paid randomness.

## Levels

`npx tsx scripts/gen-levels.ts 120 7` writes `public/levels.json` using every
core. Every level is proven solvable by the DFS solver and placed on a
difficulty curve by a "casual" bot that only sees what the player sees: easy
start, a tough one every fifth level, a wall every tenth, relief after. A
"careful" bot gates fairness, losses are steered to come late, and the share
of carts that fill by avalanche is kept at 10–35% so avalanches stay earned.
`scripts/repair-levels.ts` re-measures a set and re-rolls the off-curve ones.

## Code

- `src/game/jam.ts`: rules. Pure, deterministic, tested (`npm test`).
- `src/game/solver.ts`: solvability proof. `src/game/bot.ts`: casual/careful/sloppy players. `src/game/gen.ts`: generator and curve.
- `src/render3d/scene.ts`: the diorama, both skins, and the tap choreography. `src/render3d/toy.ts`: shared toy material and shape helpers.
- `src/main.ts`: screens, HUD, input, boosters, Fever, economy. `src/save.ts`: progress and streak.
- `marketing/recorder/`: ad clip recorder (needs `npx vite preview --port 4191 --base /critter-jam/`).

`npm run dev`, `npm test`, `npm run build`.

## Delve Daily (`/delve/`)

A second, separate game in the same repo: a daily-seed survivors-like. Everyone
gets the same dive each day (reset 10:00 UTC); you steer a lantern-bearing delver
through five one-minute layers with bosses, then the endless Core, until the
Wyrmfall ends the run. Attacks fire on their own, so you only move. Your best run
of the day counts, and points are paid when a run ends. The rank ("Top 18% est.")
is an estimate from bot runs, not from real players. There is no backend, no
accounts and no ads; progress lives in `localStorage`.

**Play:** https://ngb0004.github.io/critter-jam/delve/ (locally: `npm run dev`, then `/delve/`)

**Controls:**
- Move with WASD, the arrow keys, or one thumb dragged anywhere on screen.
- Dash with Space or the round button.
- At level-up, pick a card with a click or 1-4. R rerolls (2 per run) and B banishes (1 per run).
- P or Esc pauses.
- Red floor means move out of it. Gold means pick it up.

**Code:** `src/delve/`. Read `src/delve/ARCHITECTURE.md` first; it covers module ownership, the sim contracts and the changelog.
- `core/`: fixed 60 Hz deterministic world, seeded RNG, `fmath` tables, daily seed, replays.
- `sim/`: combat, spells, enemies, bosses, hazards, offers and build.
- `content/`: specs, spells, fusions, passives, relics, talents, Omens and layers.
- `render/`: three.js renderer, which only reads sim state.
- `ui/`: DOM screens, cards, HUD, fusion reveal, input.
- `app/`: save, points, percentile, share text, synthesized audio.
- `bot/`: bot players. `bot/population.ts` is the table the rank estimate uses.
- Scripts: `scripts/delve-bots.ts` and `scripts/delve-population.ts`.

**Debug URL params** (these runs go to a scratch save and never touch your real bests):
- `?fresh=1` uses an in-memory save.
- `?go=ember|venom` starts a run at once.
- `?bot=1|move|idle` lets a bot play.
- `?speed=N` runs N ticks per real tick.
- `?guard=1` keeps HP from dropping below 40%.
- `?day=N` plays a different day.
- `?debug` shows the FPS overlay and `__delveStress(true)`.
- `?quality=0..4` pins the render quality.

`npx vite preview --base /critter-jam/` serves the built site at its Pages paths.
