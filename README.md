# Critter Jam

A toy-box sorting puzzle for phones, in a chunky 3D diorama look.

A yard full of little critters in colour groups. Colour-coded buses pull up
one at a time, each with three seats. Tap a critter with a clear path to the
front: if it matches the bus it hops aboard, otherwise it waits on the bench.
Fill the bench and you're stuck. Rows at the back stay hidden until the rows
in front clear, so every level has a reveal and a plan that goes wrong late.

**Play:** https://ngb0004.github.io/critter-jam/ (deploys on every push to `main`)

Handy URLs: `?level=N` jump to a level, `?auto` lets a bot play (for testing and ad clips).

## Why this game

The loop is the one behind Bus Jam, Color Block Jam, Screw Jam and Hexa Sort,
four of the biggest puzzle hits of 2024–25, and the one subgenre analysts call
open to small, fast-iterating teams. What's ours: the 3D toy look in a genre
that is flat and plasticky, crowds of critters flowing at once, and the money
loop designed in from day one rather than bolted on. See
`../reports/Viral game design and monetization.md` for the research.

## Economy (v1)

- **Coins** from wins (+15, plus a tidy-bench bonus). Starting purse 300.
- **End Game Offer**: when the bench fills, +2 seats for 150 coins, once per level.
- **Rewarded video** (placeholder countdown for now): +1 seat.
- **Streak**: a win a day extends it; one missed day spends a freeze.
- No energy system, no paid randomness.

## Levels

`npx tsx scripts/gen-levels.ts 120 1` writes `public/levels.json`. Every level
is proven solvable by the DFS solver and placed on a difficulty curve by a
"casual" bot that only sees what the player sees: easy start, a tough one
every fifth level, a wall every tenth, relief after (`src/game/gen.ts`).

## Code

- `src/game/jam.ts`: rules. Pure, deterministic, tested.
- `src/game/solver.ts`: solvability proof. `src/game/bot.ts`: casual/careful/sloppy players. `src/game/gen.ts`: generator and curve.
- `src/render3d/scene.ts`: the diorama and the tap choreography. `src/render3d/toy.ts`: the shared toy material and shape helpers.
- `src/main.ts`: screens, HUD, input, economy. `src/save.ts`: progress and streak.

`npm run dev`, `npm test`, `npm run build`.
