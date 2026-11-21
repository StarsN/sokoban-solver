# Sokoban Solver

A push-optimal Sokoban solver, built for make.fun's
[“Build the best Sokoban solver, 21 November 2026”](https://make.fun/bounty/sokoban-solver-01-run-20261121)
bounty ($100 in USDC).

Try make.fun yourself: https://make.fun/r/e7twrv07

## What it does

`main.ts` (Node 22, no dependencies) answers a whole set of 5 Sokoban levels
in one run. It reads `/input/<id>/level.txt` for each instance and writes
`/output/<id>/solution.txt`: the player's moves in LURD, one letter a step.

## How it works

Every level this competition draws is a hallway one square wide with rooms
off it, and a box pushed out of its room can never be pushed back — so the
rooms are independent problems, joined only by the player's walk, and a
level's push optimum is the sum of its rooms' optima. The solver:

1. **Splits the level into rooms** by cutting the hallway's dead squares
   (squares a box can never leave towards a goal) out of the floor.
2. **Solves each room push-optimally with A\* over pushes.** A state is the
   boxes' squares plus the player's reachable region, so every square the
   player can walk to counts as one state. The estimate is the cheapest
   assignment of boxes to goals over pull distances, which never
   overestimates. Dead squares and frozen 2×2 blocks of walls and boxes
   prune the search, so the first solved state A\* pops is push-optimal.
3. **Stitches the rooms together** with walks through the hallway. A level
   that does not split into rooms is solved whole by the same search.

The search never reads the clock: every budget is counted in work, so two
runs on the same set answer byte for byte alike.

## Local verification

Against the kit's practice set (checked with the kit's own checker):

| instance | boxes | rooms | P\* | pushes | points |
|----------|-------|-------|-----|--------|--------|
| i001 | 3 | 1 | 13 | 13 | 1000 |
| i002 | 4 | 1 | 16 | 16 | 1000 |
| i003 | 8 | 2 | 29 | 29 | 1000 |
| i004 | 12 | 3 | 47 | 47 | 1000 |
| i005 | 16 | 4 | 60 | 60 | 1000 |

Practice score: **1,000,000** (the maximum), in about 0.2 s for the whole
set — far inside the 60 s wall budget. The house baseline, make.fun's own
plain-astar 1.0.0, scores 200,000 on the same set. Two runs produce
byte-identical outputs. Three further sets drawn fresh from the kit's
generator with new seeds also score 1,000,000 each, in under 0.5 s per set.

Run it locally (from the kit directory, with the practice set):

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Files

- `main.ts` — the solver
- `LICENSE` — MIT

## License

MIT — see [LICENSE](LICENSE).
