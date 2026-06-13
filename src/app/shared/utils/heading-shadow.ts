import { Injector, isDevMode } from '@angular/core';

import { QuizService } from '../services/data/quiz.service';
import { ExplanationTextService } from '../services/features/explanation/explanation-text.service';
import { TimerService } from '../services/features/timer/timer.service';
import { SelectedOptionService } from '../services/state/selectedoption.service';
import { QuizStateService } from '../services/state/quizstate.service';

import { shouldShowFet, HeadingInputs } from './heading-model';
import { norm } from './text-norm';

/**
 * Stage 2 shadow validator (heading/FET refactor). DEV-ONLY, READ-ONLY,
 * EXTERNAL — touches no component/service code. Every ~600ms it derives the
 * single-source model's FET decision from fundamental state (pristine correct
 * texts + selections + timeout/interaction) and compares it to what the heading
 * actually shows. Logs only when they disagree — those are the states where the
 * model must be tuned before any writer is removed in Stage 3.
 */
const HEADING_SELECTOR = 'codelab-quiz-content h3';
const SAMPLE_MS = 600;

export function installHeadingShadow(injector: Injector): void {
  // Dev by default; set window.__headingShadow = true to also run on the deploy.
  if (!isDevMode() && !(globalThis as any).__headingShadow) return;
  if (typeof document === 'undefined') return;

  let quiz: QuizService, ets: ExplanationTextService, timer: TimerService,
      sel: SelectedOptionService, state: QuizStateService;
  try {
    quiz = injector.get(QuizService);
    ets = injector.get(ExplanationTextService);
    timer = injector.get(TimerService);
    sel = injector.get(SelectedOptionService);
    state = injector.get(QuizStateService);
  } catch { return; }

  let lastKey = '';

  const buildInputs = (idx: number): HeadingInputs | null => {
    const dq = quiz.getQuestionsInDisplayOrder?.()?.[idx];   // shuffle-aware displayed question
    if (!dq) return null;
    const qText = dq.questionText ?? '';
    const pristine = Array.from(quiz.getPristineCorrectTextsForQuestion?.(qText) ?? [])
      .map((t: any) => norm(t));
    const selectedTexts = new Set<string>(
      ((((sel as any).selectedOptionsMap?.get?.(idx)) ?? []) as any[])
        .filter((o) => o?.selected !== false)
        .map((o) => norm(o?.text))
    );
    const isMultiAnswer = pristine.length > 1;
    const selectedCorrect = pristine.filter((t) => selectedTexts.has(t));
    return {
      questionHtml: qText,          // exact markup not needed for the decision compare
      fetHtml: (ets.formattedExplanations?.[idx]?.explanation ?? '')
            || (ets.fetByIndex?.get?.(idx) ?? ''),
      isMultiAnswer,
      isMultiAnswerComplete:
        (pristine.length > 0 && selectedCorrect.length >= pristine.length)
        || quiz._multiAnswerPerfect?.get?.(idx) === true
        || ets.fetBypassForQuestion?.get?.(idx) === true,
      isSingleAnswered: !isMultiAnswer && selectedCorrect.length > 0,
      isTimedOut: timer.expiredForQuestionIndexSig?.() === idx,
      hasInteracted: state.hasUserInteracted?.(idx) === true,
    };
  };

  setInterval(() => {
    try {
      const el = document.querySelector(HEADING_SELECTOR);
      if (!el) return;
      const idx = quiz.currentQuestionIndex;
      const inputs = buildInputs(idx);
      if (!inputs) return;

      const liveIsFet = /correct because/i.test(el.innerHTML ?? '');  // what's actually shown
      const modelSaysFet = shouldShowFet(inputs);

      if (modelSaysFet !== liveIsFet) {
        const key = `${idx}|${modelSaysFet}|${liveIsFet}`;
        if (key !== lastKey) {                 // throttle: one log per distinct mismatch
          lastKey = key;
          console.debug('[HEADING-SHADOW] MISMATCH', { idx, modelSaysFet, liveIsFet, inputs });
        }
      } else {
        lastKey = '';
      }
    } catch { /* a shadow must never throw */ }
  }, SAMPLE_MS);
}
