/**
 * Role-based Interview presets — backend port of the Angular definitions.
 *
 * PARITY SOURCES
 *   src/app/shared/models/interview-preset.model.ts
 *   src/app/shared/utils/difficulty-quota.ts
 *
 * DATA NOTE (carried over verbatim in spirit): difficulty is a property of a
 * TOPIC (quiz), not of an individual question. "60% beginner" means 60% of the
 * questions come from beginner-difficulty topics.
 *
 * A preset owns its OWN topic list. The client picks a preset id and nothing
 * else — it never supplies topics, counts, quotas or duration.
 */

export type QuizDifficulty = 'beginner' | 'intermediate' | 'advanced';

/** Ordered least → most difficult. Drives tie-breaks and redistribution. */
export const DIFFICULTY_ORDER: readonly QuizDifficulty[] = [
  'beginner',
  'intermediate',
  'advanced'
] as const;

export interface DifficultyDistribution {
  readonly beginner: number;
  readonly intermediate: number;
  readonly advanced: number;
}

export type DifficultyQuota = Record<QuizDifficulty, number>;

export type InterviewPresetId = 'junior' | 'mid-level' | 'senior';

export interface InterviewPreset {
  readonly id: InterviewPresetId;
  readonly name: string;
  readonly questionCount: number;
  readonly durationMinutes: number;
  readonly difficultyDistribution: DifficultyDistribution;
  readonly topicIds: readonly string[];
}

export function isValidDistribution(distribution: DifficultyDistribution): boolean {
  const values = [distribution.beginner, distribution.intermediate, distribution.advanced];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return false;
  return values.reduce((sum, value) => sum + value, 0) === 100;
}

/**
 * EXACT port of `calculateDifficultyQuota` — LARGEST-REMAINDER method.
 *
 *   1. exact = total × percentage / 100
 *   2. base  = floor(exact)
 *   3. the leftover goes one at a time to the largest fractional remainders
 *
 * TIE RULE: equal remainders resolve to the HIGHER difficulty (advanced first).
 * A 0%-weighted difficulty can never receive a question — its remainder is 0,
 * and zero remainders are never awarded.
 *
 * Shipped results:
 *   junior     15 @ 60/40/0  →  9 /  6 /  0   (exact)
 *   mid-level  20 @ 20/60/20 →  4 / 12 /  4   (exact)
 *   senior     25 @ 10/40/50 →  2 / 10 / 13   (floors 2/10/12; the single
 *                                              leftover is a .5 tie between
 *                                              beginner and advanced → advanced)
 */
export function calculateDifficultyQuota(
  questionCount: number,
  distribution: DifficultyDistribution
): DifficultyQuota {
  if (!Number.isInteger(questionCount) || questionCount < 0) {
    throw new Error('calculateDifficultyQuota: questionCount must be a non-negative integer');
  }
  if (!isValidDistribution(distribution)) {
    throw new Error('calculateDifficultyQuota: distribution must be nonnegative and total 100');
  }

  const exact = DIFFICULTY_ORDER.map((difficulty) => ({
    difficulty,
    share: (questionCount * distribution[difficulty]) / 100
  }));

  const quota: DifficultyQuota = { beginner: 0, intermediate: 0, advanced: 0 };
  for (const { difficulty, share } of exact) quota[difficulty] = Math.floor(share);

  let leftover = questionCount - DIFFICULTY_ORDER.reduce((sum, d) => sum + quota[d], 0);
  if (leftover <= 0) return quota;

  const byRemainder = exact
    .map(({ difficulty, share }) => ({
      difficulty,
      remainder: share - Math.floor(share),
      rank: DIFFICULTY_ORDER.indexOf(difficulty)
    }))
    .filter((entry) => entry.remainder > 0)
    .sort((a, b) => b.remainder - a.remainder || b.rank - a.rank);

  for (const entry of byRemainder) {
    if (leftover === 0) break;
    quota[entry.difficulty] += 1;
    leftover -= 1;
  }

  return quota;
}

/**
 * The shipped presets, copied field for field.
 *
 * NOTE carried over from the Angular source: two requested topics ("Security
 * fundamentals", "Angular Security") do not exist in the bank and are
 * deliberately omitted rather than faked.
 */
export const INTERVIEW_PRESETS: readonly InterviewPreset[] = Object.freeze([
  Object.freeze({
    id: 'junior' as const,
    name: 'Junior Angular Developer',
    questionCount: 15,
    durationMinutes: 20,
    difficultyDistribution: Object.freeze({ beginner: 60, intermediate: 40, advanced: 0 }),
    topicIds: Object.freeze([
      'typescript', 'create-first-app', 'templates', 'directives', 'pipes', 'angular-cli',
      'component-tree', 'dependency-injection', 'router', 'forms'
    ])
  }),
  Object.freeze({
    id: 'mid-level' as const,
    name: 'Mid-Level Angular Developer',
    questionCount: 20,
    durationMinutes: 30,
    difficultyDistribution: Object.freeze({ beginner: 20, intermediate: 60, advanced: 20 }),
    topicIds: Object.freeze([
      'typescript', 'templates',
      'component-tree', 'forms', 'router', 'http', 'testing', 'dependency-injection', 'material',
      'change-detection', 'rxjs', 'signals'
    ])
  }),
  Object.freeze({
    id: 'senior' as const,
    name: 'Senior Angular Developer',
    questionCount: 25,
    durationMinutes: 40,
    difficultyDistribution: Object.freeze({ beginner: 10, intermediate: 40, advanced: 50 }),
    topicIds: Object.freeze([
      'performance', 'testing', 'http',
      'rxjs', 'signals', 'change-detection', 'component-architecture',
      'dependency-injection-advanced', 'design-patterns'
    ])
  })
]);

export function findInterviewPreset(id: string | null | undefined): InterviewPreset | undefined {
  return INTERVIEW_PRESETS.find((preset) => preset.id === id);
}

export interface PresetCapacity {
  readonly byDifficulty: DifficultyQuota;
  /** Only difficulties the preset ALLOWS (nonzero weight) contribute. */
  readonly usable: number;
  readonly required: number;
}

/**
 * Resolved, authoritative preset values. The client never supplies these.
 * `durationSeconds` comes from `durationMinutes`, NOT from the count→duration
 * lookup used by Custom — which is why preset counts of 15 and 25 are safe here
 * even though that lookup has no entry for them.
 */
export interface ResolvedInterviewPreset {
  readonly presetId: InterviewPresetId;
  readonly presetName: string;
  readonly questionCount: number;
  readonly durationSeconds: number;
  readonly topicIds: readonly string[];
  readonly difficultyQuotas: DifficultyQuota;
}

export function resolvePreset(preset: InterviewPreset): ResolvedInterviewPreset {
  const durationSeconds = preset.durationMinutes * 60;

  // Guard the latent Angular defect explicitly: a preset must never yield an
  // unusable duration, because the countdown is server-enforced from it.
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`preset "${preset.id}" resolves to an invalid duration`);
  }

  return {
    presetId: preset.id,
    presetName: preset.name,
    questionCount: preset.questionCount,
    durationSeconds,
    topicIds: [...preset.topicIds],
    difficultyQuotas: calculateDifficultyQuota(preset.questionCount, preset.difficultyDistribution)
  };
}
