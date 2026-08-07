import { Option } from '../../../../../../shared/models/Option.model';
import { OptionBindings } from '../../../../../../shared/models/OptionBindings.model';

import { QuizService } from '../../../../../../shared/services/data/quiz.service';
import type { QuestionVerdictService } from '../../../../../../shared/services/features/verdict/question-verdict.service';

import { isOptionCorrect } from '../../../../../../shared/utils/is-option-correct';
import { norm } from '../../../../../../shared/utils/text-norm';

/**
 * Is THIS option correct, for rendering purposes?
 *
 * The per-option highlight decision: icon, `correct-option` /
 * `incorrect-option` classes, colours. Correctness comes from
 * QuestionVerdictService, not from the option's own `correct` flag.
 *
 * ── The security invariant this function enforces ──────────────────
 *
 * While a multiple-answer question is INCOMPLETE:
 *
 *     selected options may show their own verdict
 *     unselected options reveal nothing
 *
 * That is enforced structurally here rather than by convention. Reading the
 * bank directly would let an unselected correct option paint itself green
 * before the user has earned the reveal — and once the answer key stops
 * shipping to the browser, there would be nothing to read anyway.
 *
 * The verdict service only knows about options the user actually selected
 * until the question resolves, so it cannot answer for an unselected one.
 * `verdictForOption` returning null IS that distinction.
 */

/**
 * The question this display index refers to.
 *
 * SHUFFLE-AWARE: in shuffle mode `questions[qIdx]` is the wrong question,
 * because qIdx is the DISPLAY index. The display-order array is the only
 * correct source, and getting this wrong would key the verdict lookup to
 * another question entirely.
 */
function questionTextForDisplayIndex(quizService: QuizService, qIdx: number): string | null {
  const service = quizService as any;
  const inDisplayOrder = service?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText;
  if (typeof inDisplayOrder === 'string' && inDisplayOrder.length > 0) return inDisplayOrder;

  const isShuffled = service?.isShuffleEnabled?.()
    && Array.isArray(service?.shuffledQuestions)
    && service.shuffledQuestions.length > 0;
  const fallback = isShuffled
    ? service?.shuffledQuestions?.[qIdx]?.questionText
    : service?.questions?.[qIdx]?.questionText;

  return typeof fallback === 'string' && fallback.length > 0 ? fallback : null;
}

export function isCurrentOptionCorrect(
  binding: OptionBindings | undefined,
  quizService: QuizService,
  qIdx: number,
  verdicts?: QuestionVerdictService
): boolean {
  const optionText = (binding?.option as any)?.text as string | undefined;
  const quizId = (quizService as any)?.quizId as string | undefined;
  const questionText = questionTextForDisplayIndex(quizService, qIdx);

  if (verdicts && quizId && questionText && optionText) {
    // 1. The user selected this option — its own verdict is authorized.
    const own = verdicts.verdictForOption(quizId, questionText, optionText);
    if (own !== null) return own;

    const state = verdicts.verdictFor(quizId, questionText);

    // 2. Terminal — the full correct set is authorized, including options the
    //    user never selected. This is the reveal.
    if (state.phase === 'resolved' || state.phase === 'expired') {
      const target = norm(optionText);
      return state.correctOptionTexts.some((text) => norm(text) === target);
    }

    // 3. INCOMPLETE and unselected — reveal nothing. Deliberately returns
    //    before the fallback below, so no direct `correct` read can run for an
    //    unselected option on an unresolved question.
    if (state.phase === 'incomplete') return false;

    // 4. idle | checking | error — fall through to the compatibility path.
  }

  // ── TEMPORARY COMPATIBILITY PATH ─────────────────────────────────
  //
  // Reached only when no verdict has been recorded yet (idle/checking/error),
  // or when the caller could not supply the verdict service. The timeout
  // reveal still depends on this, because the timer paths are not migrated
  // until STAGE 9D — this block is removed there.
  //
  // It is UNREACHABLE for the migrated incomplete-feedback path: case 3 above
  // returns first.
  const opt = binding?.option as any;
  if (isOptionCorrect(opt) || binding?.isCorrect === true) return true;

  const service = quizService as any;
  const isShuffled = service?.isShuffleEnabled?.()
    && Array.isArray(service?.shuffledQuestions)
    && service.shuffledQuestions.length > 0;
  const question = isShuffled ? service?.shuffledQuestions?.[qIdx] : service?.questions?.[qIdx];
  if (question?.options && opt?.text) {
    const optText = norm(opt.text);
    const match = question.options.find((o: Option) => o?.text && norm(o.text) === optText);
    if (isOptionCorrect(match)) return true;
  }
  return false;
}
