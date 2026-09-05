/**
 * Isolation Forest — the anomaly model, implemented here rather than imported.
 *
 * WHY THIS MODEL. The deterministic engine is excellent at known conditions: a
 * 2σ move, volume at twice its median, a level crossed. What it cannot express is
 * a combination that is unremarkable in every individual dimension and unusual
 * as a whole — a modest move, on modest volume, against the market, away from the
 * moving average, on a day that gapped. Isolation Forest is built for exactly
 * that: it isolates points that are easy to separate from the rest of the data in
 * a random partitioning, which is a genuinely multivariate notion of "unusual"
 * rather than a threshold wearing a new name.
 *
 * WHY IT IS WRITTEN OUT. It is ~120 lines of well-specified algorithm (Liu, Ting
 * & Zhou, 2008). Adding a Python service to obtain it would introduce a second
 * deployment, a network boundary and an operational failure mode to a hackathon
 * app whose central claim is that the deterministic core keeps working when
 * anything optional fails. The maintained JS ports we looked at are unmaintained
 * or bundle a heavier numeric stack than this file replaces.
 *
 * DETERMINISM. Every random choice comes from a seeded generator, so the same
 * data and seed produce the same trees, the same scores and therefore the same
 * stored evidence. That is what makes a stored anomaly reproducible and repeated
 * detection idempotent, and it is also why nothing here reads `Math.random`.
 *
 * NO NORMALIZATION IS REQUIRED. Splits are drawn uniformly between the observed
 * minimum and maximum of a feature within a node, so the model is invariant to
 * each feature's scale and units. Nothing is standardised, which also means there
 * is no fitted scaler that could leak statistics from future observations.
 */

export type IsolationForestConfig = {
  /** Trees in the ensemble. 100 is the value the paper's convergence analysis uses. */
  trees: number;
  /** Sub-sample per tree. 256 is the paper's default; small samples isolate better. */
  sampleSize: number;
  seed: number;
};

export const DEFAULT_FOREST: IsolationForestConfig = { trees: 100, sampleSize: 256, seed: 20260906 };

type Node =
  | { kind: "leaf"; size: number }
  | { kind: "split"; column: number; value: number; left: Node; right: Node };

export type IsolationForest = {
  trees: Node[];
  /** Rows actually used per tree — the normalizing constant depends on it. */
  sampleSize: number;
  columns: number;
  config: IsolationForestConfig;
};

/** Small, fast, seedable PRNG. Deterministic across platforms and Node versions. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EULER_MASCHERONI = 0.5772156649015329;

/**
 * Average path length of an unsuccessful search in a binary search tree.
 *
 * This is the normalization that makes a score comparable across sample sizes:
 * without it, "how deep did this point sit" would depend on how much data we had.
 */
export function averagePathLength(n: number): number {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + EULER_MASCHERONI) - (2 * (n - 1)) / n;
}

function sample(rows: number[][], size: number, random: () => number): number[][] {
  if (rows.length <= size) return rows;
  // Partial Fisher–Yates: an unbiased sample without replacement, and without
  // copying the whole dataset per tree.
  const index = rows.map((_, i) => i);
  for (let i = 0; i < size; i++) {
    const j = i + Math.floor(random() * (index.length - i));
    [index[i], index[j]] = [index[j], index[i]];
  }
  return index.slice(0, size).map((i) => rows[i]);
}

function buildTree(rows: number[][], depth: number, heightLimit: number, columns: number, random: () => number): Node {
  if (depth >= heightLimit || rows.length <= 1) return { kind: "leaf", size: rows.length };

  // Only columns that actually vary in this node can isolate anything. A constant
  // column would otherwise produce an empty child and a wasted level.
  const usable: number[] = [];
  for (let c = 0; c < columns; c++) {
    let min = Infinity;
    let max = -Infinity;
    for (const row of rows) {
      if (row[c] < min) min = row[c];
      if (row[c] > max) max = row[c];
    }
    if (max > min) usable.push(c);
  }
  if (usable.length === 0) return { kind: "leaf", size: rows.length };

  const column = usable[Math.floor(random() * usable.length)];
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    if (row[column] < min) min = row[column];
    if (row[column] > max) max = row[column];
  }
  const value = min + random() * (max - min);

  const left: number[][] = [];
  const right: number[][] = [];
  for (const row of rows) (row[column] < value ? left : right).push(row);
  // A split that separates nothing (every value equal to the drawn bound) stops
  // here rather than recursing forever on the same rows.
  if (left.length === 0 || right.length === 0) return { kind: "leaf", size: rows.length };

  return {
    kind: "split", column, value,
    left: buildTree(left, depth + 1, heightLimit, columns, random),
    right: buildTree(right, depth + 1, heightLimit, columns, random),
  };
}

/** Fits a forest. Rows must be finite and of equal length — see lib/ml/features.ts. */
export function fitIsolationForest(rows: number[][], config: IsolationForestConfig = DEFAULT_FOREST): IsolationForest {
  if (rows.length === 0) throw new Error("Isolation Forest needs at least one observation");
  const columns = rows[0].length;
  if (columns === 0) throw new Error("Isolation Forest needs at least one feature");
  if (rows.some((row) => row.length !== columns || row.some((v) => !Number.isFinite(v)))) {
    // Refusing is the point: a NaN silently becomes a split boundary that swallows
    // every comparison, and the model would then score confidently on nonsense.
    throw new Error("Isolation Forest received a ragged or non-finite feature matrix");
  }

  const random = mulberry32(config.seed);
  const sampleSize = Math.min(config.sampleSize, rows.length);
  const heightLimit = Math.ceil(Math.log2(Math.max(sampleSize, 2)));
  const trees: Node[] = [];
  for (let t = 0; t < config.trees; t++) {
    trees.push(buildTree(sample(rows, sampleSize, random), 0, heightLimit, columns, random));
  }
  return { trees, sampleSize, columns, config };
}

function pathLength(node: Node, point: number[], depth = 0): number {
  if (node.kind === "leaf") return depth + averagePathLength(node.size);
  return pathLength(point[node.column] < node.value ? node.left : node.right, point, depth + 1);
}

/**
 * The paper's anomaly score, in [0, 1).
 *
 * Near 1: isolated far more easily than the training data — unusual. Near 0.5:
 * indistinguishable from ordinary observations. It is a model output, not a
 * probability, not a percentage, and never rendered as either.
 */
export function anomalyScore(forest: IsolationForest, point: number[]): number {
  if (point.length !== forest.columns || point.some((v) => !Number.isFinite(v))) {
    throw new Error("Isolation Forest received a point of the wrong shape or with non-finite values");
  }
  const expected = forest.trees.reduce((sum, tree) => sum + pathLength(tree, point), 0) / forest.trees.length;
  const normalizer = averagePathLength(forest.sampleSize);
  if (!(normalizer > 0)) return 0;
  const score = Math.pow(2, -expected / normalizer);
  return Number.isFinite(score) ? score : 0;
}

/** The q-th quantile of a score distribution, by linear interpolation. */
export function quantile(values: number[], q: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * Math.min(Math.max(q, 0), 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
