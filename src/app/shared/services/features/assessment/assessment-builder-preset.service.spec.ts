import { TestBed } from '@angular/core/testing';

import { AssessmentBuilderService } from './assessment-builder.service';
import { findInterviewPreset, INTERVIEW_PRESETS, InterviewPreset } from '../../../models/interview-preset.model';
import { calculateDifficultyQuota } from '../../../utils/difficulty-quota';
import { setQuizDataCache, getQuizData } from '../../../quiz-data-cache';
import { ArrayUtils } from '../../../utils/array-utils';
import { Quiz } from '../../../models/Quiz.model';
import quizData from '../../../../../assets/data/quiz.json';

const REAL_CATALOG = ((quizData as { quizzes?: unknown[] }).quizzes ?? quizData) as Quiz[];

/** Difficulty of the topic a generated question came from. */
function difficultyOf(sourceQuizId: string | undefined, catalog: Quiz[]): string | undefined {
  return catalog.find((q) => q.quizId === sourceQuizId)?.difficulty;
}

interface Mix { beginner: number; intermediate: number; advanced: number }

function mix(questions: { sourceQuizId?: string }[], catalog: Quiz[]): Mix {
  const out: Mix = { beginner: 0, intermediate: 0, advanced: 0 };
  for (const q of questions) {
    const d = difficultyOf(q.sourceQuizId, catalog);
    if (d === 'beginner' || d === 'intermediate' || d === 'advanced') out[d] += 1;
  }
  return out;
}

describe('AssessmentBuilderService — role presets', () => {
  let service: AssessmentBuilderService;

  beforeEach(() => {
    setQuizDataCache(REAL_CATALOG, []);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [AssessmentBuilderService] });
    service = TestBed.inject(AssessmentBuilderService);
  });

  afterEach(() => setQuizDataCache(REAL_CATALOG, []));

  it.each(INTERVIEW_PRESETS.map((p) => [p.id, p] as const))(
    '%s: returns exactly its requested question count with no duplicates',
    (_id, preset) => {
      const built = service.buildFromPreset(preset as InterviewPreset);
      expect(built.questions).toHaveLength(preset.questionCount);
      const texts = built.questions.map((q) => q.questionText);
      expect(new Set(texts).size).toBe(texts.length);
    }
  );

  it('Junior produces the documented 9 beginner / 6 intermediate mix and NEVER advanced', () => {
    const preset = findInterviewPreset('junior')!;
    for (let run = 0; run < 15; run++) {
      const built = service.buildFromPreset(preset);
      expect(mix(built.questions, REAL_CATALOG)).toEqual({ beginner: 9, intermediate: 6, advanced: 0 });
    }
  });

  it('Mid-Level produces the documented 4 / 12 / 4 mix', () => {
    const built = service.buildFromPreset(findInterviewPreset('mid-level')!);
    expect(mix(built.questions, REAL_CATALOG)).toEqual({ beginner: 4, intermediate: 12, advanced: 4 });
  });

  // Senior weights 10% beginner but configures no beginner topic, so those 2
  // questions redistribute into the preset's other allowed difficulties. The
  // TOTAL is still exact and no beginner question appears.
  it('Senior redistributes its unfillable beginner quota and still totals 25', () => {
    const preset = findInterviewPreset('senior')!;
    const quota = calculateDifficultyQuota(preset.questionCount, preset.difficultyDistribution);
    expect(quota).toEqual({ beginner: 2, intermediate: 10, advanced: 13 });

    const built = service.buildFromPreset(preset);
    const actual = mix(built.questions, REAL_CATALOG);
    expect(built.questions).toHaveLength(25);
    expect(actual.beginner).toBe(0);                        // no beginner topic configured
    expect(actual.intermediate + actual.advanced).toBe(25); // shortfall absorbed
  });

  it('only ever uses topics configured on the preset', () => {
    for (const preset of INTERVIEW_PRESETS) {
      const built = service.buildFromPreset(preset);
      const allowed = new Set(preset.topicIds);
      for (const q of built.questions) expect(allowed.has(q.sourceQuizId as string)).toBe(true);
    }
  });

  it('balances across topics — no single topic dominates', () => {
    const preset = findInterviewPreset('mid-level')!;
    const built = service.buildFromPreset(preset);
    const perTopic = new Map<string, number>();
    for (const q of built.questions) {
      perTopic.set(q.sourceQuizId as string, (perTopic.get(q.sourceQuizId as string) ?? 0) + 1);
    }
    // Round-robin within a difficulty means counts differ by at most one inside
    // each band; a dominant topic would show up as a large max.
    expect(Math.max(...perTopic.values())).toBeLessThanOrEqual(4);
  });

  it('the same preset can generate a different session on a later run', () => {
    const preset = findInterviewPreset('senior')!;
    const a = service.buildFromPreset(preset).questions.map((q) => q.questionText).join('|');
    let differed = false;
    for (let i = 0; i < 10 && !differed; i++) {
      const b = service.buildFromPreset(preset).questions.map((q) => q.questionText).join('|');
      if (a !== b) differed = true;
    }
    expect(differed).toBe(true);
  });

  it('uses the shared ArrayUtils.shuffleArray rather than a second shuffle', () => {
    const spy = jest.spyOn(ArrayUtils, 'shuffleArray');
    service.buildFromPreset(findInterviewPreset('junior')!);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not mutate the canonical question bank', () => {
    const before = JSON.stringify(getQuizData());
    for (const preset of INTERVIEW_PRESETS) service.buildFromPreset(preset);
    expect(JSON.stringify(getQuizData())).toBe(before);
  });

  it('keeps "All of the above" last after option shuffling', () => {
    for (const preset of INTERVIEW_PRESETS) {
      const built = service.buildFromPreset(preset);
      for (const q of built.questions) {
        const idx = (q.options ?? []).findIndex((o) => /all of the above/i.test(o.text ?? ''));
        if (idx >= 0) expect(idx).toBe((q.options ?? []).length - 1);
      }
    }
  });

  it('stamps preset metadata and the preset duration onto the assessment', () => {
    const preset = findInterviewPreset('mid-level')!;
    const built = service.buildFromPreset(preset);
    expect(built.durationSeconds).toBe(30 * 60);
    expect(built.config.presetId).toBe('mid-level');
    expect(built.config.presetName).toBe('Mid-Level Angular Developer');
    expect(built.title).toBe('Mid-Level Angular Developer');
  });

  describe('capacity + shortfall', () => {
    it('reports usable capacity excluding zero-weighted difficulties', () => {
      const junior = service.presetCapacity(findInterviewPreset('junior')!);
      // Junior weights advanced at 0%, and configures no advanced topic either.
      expect(junior.byDifficulty.advanced).toBe(0);
      expect(junior.usable).toBeGreaterThanOrEqual(junior.required);
      expect(service.canBuildPreset(findInterviewPreset('junior')!)).toBe(true);
    });

    it('recovers a same-difficulty shortfall from the preset\'s other topics', () => {
      // Shrink one beginner topic so a single topic can no longer carry its share.
      const trimmed = REAL_CATALOG.map((q) =>
        q.quizId === 'typescript' ? { ...q, questions: (q.questions ?? []).slice(0, 1) } : q
      );
      setQuizDataCache(trimmed as Quiz[], []);
      const built = service.buildFromPreset(findInterviewPreset('junior')!);
      expect(built.questions).toHaveLength(15);
      expect(mix(built.questions, trimmed as Quiz[])).toEqual({ beginner: 9, intermediate: 6, advanced: 0 });
    });

    it('redistributes across difficulties when a whole band is short', () => {
      // Gut every beginner topic Junior uses → its 9 beginner must come from the
      // only other ALLOWED band (intermediate). Advanced stays 0 (weight is 0%).
      const gutted = REAL_CATALOG.map((q) =>
        q.difficulty === 'beginner' ? { ...q, questions: [] } : q
      );
      setQuizDataCache(gutted as Quiz[], []);
      const built = service.buildFromPreset(findInterviewPreset('junior')!);
      const actual = mix(built.questions, gutted as Quiz[]);
      expect(built.questions).toHaveLength(15);
      expect(actual.advanced).toBe(0);        // never pulled into Junior
      expect(actual.intermediate).toBe(15);
    });

    it('refuses to build — and reports capacity — when the preset cannot be filled', () => {
      const starved = REAL_CATALOG.map((q) => ({ ...q, questions: (q.questions ?? []).slice(0, 1) }));
      setQuizDataCache(starved as Quiz[], []);
      const preset = findInterviewPreset('senior')!;
      const capacity = service.presetCapacity(preset);
      expect(capacity.usable).toBeLessThan(capacity.required);
      expect(service.canBuildPreset(preset)).toBe(false);
      expect(() => service.buildFromPreset(preset)).toThrow(/needs 25 questions but only \d+/);
    });
  });
});
