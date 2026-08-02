import { randomInt } from 'node:crypto';

/**
 * Randomness abstraction + the shuffle port.
 *
 * The builder never calls `Math.random()`. Everything random flows through a
 * RandomSource so tests are exactly reproducible and production can use a
 * strong generator.
 */

export interface RandomSource {
  /** A float in [0, 1). */
  next(): number;
}

export class InvalidRandomSourceError extends Error {
  public override readonly name = 'InvalidRandomSourceError';
}

/**
 * Production source.
 *
 * Built from `crypto.randomInt`, which is uniform over its range and free of
 * the modulo bias you get from `randomBytes() % n`. Dividing by 2^32 yields a
 * uniform float in [0, 1).
 */
export const cryptoRandomSource: RandomSource = {
  next: () => randomInt(0, 2 ** 32) / 2 ** 32
};

/**
 * Deterministic test source (mulberry32). Small, well-distributed, and
 * reproducible from a seed — enough for parity fixtures.
 */
export function seededRandomSource(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next: () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
  };
}

/** Replays a fixed list of values, then throws. Pins exact orderings in tests. */
export function fixedRandomSource(values: readonly number[]): RandomSource {
  let index = 0;
  return {
    next: () => {
      if (index >= values.length) {
        throw new InvalidRandomSourceError('Fixed random source exhausted');
      }
      return values[index++] as number;
    }
  };
}

function draw(random: RandomSource): number {
  const value = random.next();
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new InvalidRandomSourceError('Random source must return a finite number in [0, 1)');
  }
  return value;
}

/**
 * EXACT port of Angular's `ArrayUtils.shuffleArray` (shared/utils/array-utils.ts).
 *
 * Two properties are reproduced deliberately, because parity depends on them:
 *
 *   1. The loop runs down to `i === 0` INCLUSIVE. Textbook Fisher-Yates stops at
 *      i === 1; this one performs a final no-op swap at i === 0 and, crucially,
 *      CONSUMES ONE EXTRA RANDOM VALUE. With a seeded source, stopping at 1
 *      would desynchronise every subsequent draw.
 *   2. It mutates in place and returns the same array reference.
 *
 * Callers must therefore clone first — the builder always does, so the master
 * bank is never touched.
 */
export function shuffleArrayInPlace<T>(array: T[], random: RandomSource): T[] {
  for (let i = array.length - 1; i >= 0; i--) {
    const j = Math.floor(draw(random) * (i + 1));
    const a = array[i] as T;
    const b = array[j] as T;
    array[i] = b;
    array[j] = a;
  }
  return array;
}

/** Convenience: shuffle a COPY, leaving the input untouched. */
export function shuffledCopy<T>(items: readonly T[], random: RandomSource): T[] {
  return shuffleArrayInPlace([...items], random);
}
