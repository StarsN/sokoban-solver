// A push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// How it works. Every level this competition draws is a hallway one square
// wide with rooms off it, and a box that leaves its room can never be pushed
// back: the rooms are independent problems, joined only by the player's walk,
// and the level's push optimum is the sum of the rooms' optima. So the solver
// splits a level into its rooms, solves each room push-optimally on its own,
// and stitches the rooms' move strings together with walks through the
// hallway. A level that does not split into rooms is solved whole instead.
//
// Each room is solved by A* over pushes. A state is the boxes' squares plus
// the player's reachable region (named by its lowest square), so every square
// the player can walk to from where it stands counts as one state. The
// estimate is the cheapest assignment of boxes to goals over pull distances
// (how few pushes move a box from a square onto a goal, other boxes ignored),
// which never overestimates: one push moves one box one square. Dead squares
// (no pull path to any goal) and frozen 2 x 2 blocks of walls and boxes prune
// the search. The first solved state A* pops is therefore push-optimal.
//
// The search never looks at the clock: every budget is counted in work
// (states kept, states expanded), so two runs on the same set answer byte for
// byte alike. Node's built-in modules only; no network, no files outside the
// input and output directories, no environment reads beyond the two directory
// variables the harness sets.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four steps: [dx, dy, the walk's letter, the push's letter]. */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player). */
type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** Work budgets, counted in states so a run is deterministic. */
type Budget = { used: number; limit: number };
const BUDGET: Budget = { used: 0, limit: 3_000_000 };

/** Parse XSB text. The outermost frame counts as wall whatever it shows. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * For one goal, the fewest pushes that move a box from each square onto it,
 * other boxes ignored: a pull search run backwards from the goal. A box at a
 * square the search never reaches can never reach a goal, so that square is
 * dead. A square's distance is -1 when dead.
 */
function pullDistances(level: Level, goal: number): Int32Array {
  const { w, wall } = level;
  const dist = new Int32Array(wall.length).fill(-1);
  dist[goal] = 0;
  const queue = [goal];
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k]![1] * w + DIRS[k]![0];
      const from = x - d;
      const behind = from - d;
      if (wall[from] || wall[behind] || dist[from] >= 0) continue;
      dist[from] = dist[x]! + 1;
      queue.push(from);
    }
  }
  return dist;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box standing there reaches no goal) out of the floor, and each connected
 * part left that holds a box is a room. Null when some part holds a different
 * number of boxes than goals, or a box or goal falls outside every part:
 * then the level is no set of rooms.
 */
function roomsOf(level: Level): { boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const dists = goals.map((g) => pullDistances(level, g));
  const live = new Uint8Array(wall.length);
  for (let i = 0; i < wall.length; i++) {
    if (wall[i]) continue;
    for (const d of dists) {
      if (d[i] >= 0) {
        live[i] = 1;
        break;
      }
    }
  }
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const id = rooms.length;
    rooms.push({ boxes: [], goals: [] });
    const stack = [s];
    part[s] = id;
    while (stack.length > 0) {
      const p = stack.pop()!;
      for (let k = 0; k < 4; k++) {
        const q = p + DIRS[k]![1] * w + DIRS[k]![0];
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = id;
          stack.push(q);
        }
      }
    }
  }
  for (const b of boxes) {
    if (part[b]! < 0) return null;
    rooms[part[b]!]!.boxes.push(b);
  }
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const { w, wall } = level;
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k]![1] * w + DIRS[k]![0];
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = DIRS[k]![2];
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` from `from`, boxes moving as pushed. */
function endPlayer(level: Level, from: number, boxes: number[], moves: string): number {
  const { w, wall } = level;
  const box = new Uint8Array(wall.length);
  for (const b of boxes) box[b] = 1;
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    const k = c === 'u' ? 0 : c === 'd' ? 1 : c === 'l' ? 2 : 3;
    const d = DIRS[k]![1] * w + DIRS[k]![0];
    const next = p + d;
    if (wall[next]) throw new Error('endPlayer: a move walks into a wall');
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) throw new Error('endPlayer: a move pushes a box into a wall or a box');
      box[next] = 0;
      box[beyond] = 1;
    }
    p = next;
  }
  return p;
}

/**
 * The push-optimal solution of `level`: {pushes, moves} (moves in LURD, an
 * upper letter marking a push), or null when the search gives up. A* over
 * pushes with the assignment estimate; `greedy` orders the open list by the
 * estimate alone, which finds a solution fast without promising its optimum.
 */
function solvePushes(level: Level, maxStates: number, budget: Budget, greedy = false): { pushes: number; moves: string } | null {
  const { w, wall, goals, boxes, player } = level;
  const size = wall.length;
  const goalMask = new Uint8Array(size);
  for (const g of goals) goalMask[g] = 1;
  const dists = goals.map((g) => pullDistances(level, g));
  const nearest = new Int32Array(size).fill(-1);
  for (let i = 0; i < size; i++) {
    if (wall[i]) continue;
    let best = -1;
    for (const d of dists) {
      if (d[i] >= 0 && (best < 0 || d[i] < best)) best = d[i];
    }
    nearest[i] = best;
  }
  for (const b of boxes) if (nearest[b]! < 0) return null;
  const solved = (bs: number[]): boolean => bs.every((b) => goalMask[b] === 1);
  if (solved(boxes)) return { pushes: 0, moves: '' };

  // The cheapest assignment of boxes to goals over the pull distances, or -1
  // when no box can be given a goal of its own: such a state cannot be solved.
  // With more than six boxes the plain sum of nearest distances stands in.
  const estimate = (bs: number[]): number => {
    if (bs.length > 6) {
      let s = 0;
      for (const b of bs) s += nearest[b]!;
      return s;
    }
    let best = Infinity;
    const used = new Array<boolean>(goals.length).fill(false);
    const assign = (i: number, acc: number): void => {
      if (acc >= best) return;
      if (i === bs.length) {
        best = acc;
        return;
      }
      for (let j = 0; j < goals.length; j++) {
        if (used[j]) continue;
        const d = dists[j]![bs[i]!]!;
        if (d < 0) continue;
        used[j] = true;
        assign(i + 1, acc + d);
        used[j] = false;
      }
    };
    assign(0, 0);
    return best === Infinity ? -1 : best;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  // Mark the squares the player reaches from `from` with `occupied` in the
  // way, and return the lowest of them. The marks carry a fresh stamp, so a
  // later call's marks never mix with an earlier one's.
  const regionLow = (from: number): number => {
    stamp++;
    let low = from;
    let n = 0;
    stack[n++] = from;
    seen[from] = stamp;
    while (n > 0) {
      const p = stack[--n]!;
      if (p < low) low = p;
      for (let k = 0; k < 4; k++) {
        const q = p + DIRS[k]![1] * w + DIRS[k]![0];
        if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
          seen[q] = stamp;
          stack[n++] = q;
        }
      }
    }
    return low;
  };

  // Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls
  // and boxes with a box off its goal: no push can ever free it.
  const frozen = (t: number): boolean => {
    const blocked = (i: number): boolean => i >= 0 && i < size && (wall[i] === 1 || occupied[i] === 1);
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (!blocked(a) || !blocked(b) || !blocked(c) || !blocked(d)) continue;
      if ((occupied[a] && !goalMask[a]) || (occupied[b] && !goalMask[b]) || (occupied[c] && !goalMask[c]) || (occupied[d] && !goalMask[d])) {
        return true;
      }
    }
    return false;
  };

  // The states, in the order found: their boxes, the player's square after
  // the push that made them, their parent, the push that made them, and their
  // push count. The open list is a heap of state indexes, ordered by f, then
  // by deeper g, then by discovery order, so the search is deterministic.
  const sBoxes: number[][] = [boxes.slice()];
  const sPlayer: number[] = [player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sDir: number[] = [-1];
  const sG: number[] = [0];
  const fVal: number[] = [estimate(boxes)];
  const seqVal: number[] = [0];
  const heap: number[] = [0];
  let seq = 1;
  const lessIdx = (a: number, b: number): boolean => {
    if (fVal[a]! !== fVal[b]!) return fVal[a]! < fVal[b]!;
    if (sG[a]! !== sG[b]!) return sG[a]! > sG[b]!;
    return seqVal[a]! < seqVal[b]!;
  };
  const heapPush = (idx: number): void => {
    let i = heap.length;
    heap.push(idx);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!lessIdx(heap[i]!, heap[p]!)) break;
      const tmp = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && lessIdx(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && lessIdx(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        const tmp = heap[i]!;
        heap[i] = heap[m]!;
        heap[m] = tmp;
        i = m;
      }
    }
    return top;
  };

  const closed = new Map<string, number>();
  for (const b of boxes) occupied[b] = 1;
  closed.set(`${boxes.join(',')}:${regionLow(player)}`, 0);
  for (const b of boxes) occupied[b] = 0;

  const reconstruct = (idx: number): string => {
    const chain: number[] = [];
    for (let s = idx; s > 0; s = sParent[s]!) chain.push(s);
    chain.reverse();
    let moves = '';
    let p = player;
    let cur = boxes;
    for (const s of chain) {
      const from = sFrom[s]!;
      const k = sDir[s]!;
      const d = DIRS[k]![1] * w + DIRS[k]![0];
      for (const b of cur) occupied[b] = 1;
      moves += walkTo(level, occupied, p, from - d);
      for (const b of cur) occupied[b] = 0;
      moves += DIRS[k]![3];
      p = from;
      cur = sBoxes[s]!;
    }
    return moves;
  };

  while (heap.length > 0) {
    if (budget.used >= budget.limit) return null;
    budget.used++;
    const s = heapPop();
    const g = sG[s]!;
    const cur = sBoxes[s]!;
    for (const b of cur) occupied[b] = 1;
    regionLow(sPlayer[s]!);
    const stampHere = stamp;
    const pushes: { bi: number; k: number; t: number }[] = [];
    for (let bi = 0; bi < cur.length; bi++) {
      const b = cur[bi]!;
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k]![1] * w + DIRS[k]![0];
        const t = b + d;
        if (wall[t] || occupied[t] || nearest[t]! < 0) continue;
        if (seen[b - d] !== stampHere) continue;
        pushes.push({ bi, k, t });
      }
    }
    for (const { bi, k, t } of pushes) {
      const b = cur[bi]!;
      const next = cur.slice();
      next[bi] = t;
      next.sort((x, y) => x - y);
      occupied[b] = 0;
      occupied[t] = 1;
      if (frozen(t)) {
        occupied[t] = 0;
        occupied[b] = 1;
        continue;
      }
      const low = regionLow(b);
      const key = `${next.join(',')}:${low}`;
      const ng = g + 1;
      const prev = closed.get(key);
      if (prev !== undefined && prev <= ng) {
        occupied[t] = 0;
        occupied[b] = 1;
        continue;
      }
      const h = estimate(next);
      if (h < 0) {
        occupied[t] = 0;
        occupied[b] = 1;
        continue;
      }
      if (sBoxes.length >= maxStates) {
        for (const x of cur) occupied[x] = 0;
        return null;
      }
      closed.set(key, ng);
      const idx = sBoxes.length;
      sBoxes.push(next);
      sPlayer.push(b);
      sParent.push(s);
      sFrom.push(b);
      sDir.push(k);
      sG.push(ng);
      fVal.push(greedy ? h : ng + h);
      seqVal.push(seq++);
      heapPush(idx);
      occupied[t] = 0;
      occupied[b] = 1;
      if (solved(next)) {
        for (const x of cur) occupied[x] = 0;
        try {
          return { pushes: ng, moves: reconstruct(idx) };
        } catch {
          return null;
        }
      }
    }
    for (const b of cur) occupied[b] = 0;
  }
  return null;
}

/**
 * The moves that solve `text`: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls, the player walking on from where
 * the last room left it. A room the search gives up on ends the answer where
 * it stands (a valid prefix, the level unsolved); a level that is no set of
 * rooms is solved whole instead.
 */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms !== null) {
    const current: number[][] = rooms.map((r) => r.boxes.slice());
    let player = level.player;
    let boxes = level.boxes.slice();
    let moves = '';
    for (let ri = 0; ri < rooms.length; ri++) {
      const room = rooms[ri]!;
      const wall = level.wall.slice();
      for (let oj = 0; oj < rooms.length; oj++) {
        if (oj === ri) continue;
        for (const b of current[oj]!) wall[b] = 1;
      }
      const sub: Level = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice(),
        boxes: current[ri]!.slice(),
        player,
      };
      let solved: { pushes: number; moves: string } | null = null;
      try {
        solved = solvePushes(sub, 400_000, BUDGET, false) ?? solvePushes(sub, 200_000, BUDGET, true);
      } catch {
        solved = null;
      }
      if (solved === null) return moves;
      moves += solved.moves;
      try {
        player = endPlayer(level, player, boxes, solved.moves);
      } catch {
        return moves;
      }
      boxes = boxes.filter((b) => !room.boxes.includes(b)).concat(room.goals);
      boxes.sort((a, b) => a - b);
      current[ri] = room.goals.slice();
    }
    return moves;
  }
  let solved: { pushes: number; moves: string } | null = null;
  try {
    solved = solvePushes(level, 400_000, BUDGET, false) ?? solvePushes(level, 200_000, BUDGET, true);
  } catch {
    solved = null;
  }
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
