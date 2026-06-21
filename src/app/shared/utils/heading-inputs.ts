import { HeadingInputs } from './heading-model';
import { norm } from './text-norm';

/**
 * Shared gatherer for the heading model's inputs (Phase 3 step 1).
 *
 * Both the dev-only shadow validator (heading-shadow.ts) and the component's
 * reactive `headingHtml` computed call this, so the shadow's validated agreement
 * with the live heading transfers directly to the computed — they read the exact
 * same state. Kept dependency-light (services typed loosely) to avoid import
 * cycles; the callers pass their real, typed service instances.
 */
export interface HeadingInputDeps {
  idx: number;
  quizService: any;
  explanationTextService: any;
  timerService: any;
  selectedOptionService: any;
  quizStateService: any;
  quizNavigationService: any;
}

/**
 * Build the HeadingInputs for a display index from live service state. Returns
 * null when there is no displayed question for the index (caller should skip).
 */
export function buildHeadingInputs(d: HeadingInputDeps): HeadingInputs | null {
  const { idx } = d;
  const dq = d.quizService.getQuestionsInDisplayOrder?.()?.[idx];   // shuffle-aware
  if (!dq) {
    return null;
  }

  const qText = dq.questionText ?? '';
  const pristine = Array.from(d.quizService.getPristineCorrectTextsForQuestion?.(qText) ?? [])
    .map((t: any) => norm(t));
  const selectedTexts = new Set<string>(
    ((((d.selectedOptionService as any).selectedOptionsMap?.get?.(idx)) ?? []) as any[])
      .filter((o) => o?.selected !== false)
      .map((o) => norm(o?.text))
  );
  const isMultiAnswer = pristine.length > 1;
  const selectedCorrect = pristine.filter((t) => selectedTexts.has(t));
  const ets = d.explanationTextService;

  return {
    questionHtml: qText,
    fetHtml: (ets.formattedExplanations?.[idx]?.explanation ?? '')
          || (ets.fetByIndex?.get?.(idx) ?? ''),
    isMultiAnswer,
    isMultiAnswerComplete:
      (pristine.length > 0 && selectedCorrect.length >= pristine.length)
      || d.quizService._multiAnswerPerfect?.get?.(idx) === true
      || ets.fetBypassForQuestion?.get?.(idx) === true,
    isSingleAnswered: !isMultiAnswer && selectedCorrect.length > 0,
    isTimedOut: d.timerService.expiredForQuestionIndexSig?.() === idx,
    hasInteracted: d.quizStateService.hasUserInteracted?.(idx) === true,
    optionsReady: typeof document !== 'undefined'
      && document.querySelectorAll('.option-row').length > 0,
    isNavigatingToPrevious: d.quizNavigationService.isNavigatingToPreviousSig?.() === true,
    interactedThisVisit: d.quizStateService.wasInteractedThisVisit?.(idx) === true,
  };
}
