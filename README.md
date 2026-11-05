# Gem Jam (repo: critter-jam)

A toy-box sorting puzzle for phones, in a chunky 3D diorama look.

A mine floor packed with gems in colour groups. Colour-coded carts roll in on
the rails, one at a time, three seats each. Tap a gem with a clear path to the
front: if it matches the cart it hops aboard, otherwise it waits on the tray.
Fill the tray and you're stuck. Back rows stay hidden until the rows in front
clear, so every level has a reveal and a plan that goes wrong late.

**Play:** https://ngb0004.github.io/critter-jam/ (deploys on every push to `main`)

Handy URLs: `?level=N` jump to a level, `?skin=critters` the animals-and-buses
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
