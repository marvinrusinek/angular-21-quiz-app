import { inject, Injectable, Injector } from '@angular/core';

import { Option } from '../../models/Option.model';
import { Quiz } from '../../models/Quiz.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { QuizOptionsService } from './quiz-options.service';
import { SelectedOptionService } from '../state/selectedoption.service';
import { isOptionCorrect } from '../../utils/is-option-correct';
import { norm } from '../../utils/text-norm';
import { swallow } from '../../utils/error-logging';

/**
 * Handles answer evaluation, correctness checking, and direct scoring
 * with pristine verification. Extracted from QuizService to reduce its size.
 */
@Injectable({ providedIn: 'root' })
export class QuizAnswerEvaluationService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly injector = inject(Injector);
  private readonly optionsService = inject(QuizOptionsService);

  // ── properties ──────────────────────────────────────────────────
  private _selectedOptionService: SelectedOptionService | null = null;

  // ── public methods ──────────────────────────────────────────────
  /**
   * Resolves user answer IDs to full Option objects from the question's options.
   * Returns the matched options array.
   */
  resolveAnswerOptions(
    answerIds: number[],
    question: QuizQuestion,
    questionIndex: number,
    shouldShuffle: boolean
  ): Option[] {
    if (!question || !Array.isArray(question.options)) {
      return answerIds.map(id => ({ optionId: id } as Option));
    }

    return answerIds
      .map((id) => {
        let match = question.options.find((o: Option) => o.optionId == id);

        if (!match) {
          const qPrefix = (questionIndex + 1).toString();
          const strId = id.toString();
          if (strId.length > qPrefix.length && strId.startsWith(qPrefix)) {
            const suffix = parseInt(strId.substring(qPrefix.length), 10);
            const optIdx = suffix - 1;
            if (question.options[optIdx]) match = question.options[optIdx];
          }
        }

        if (!match) {
          const answerId = id;
          match = question.options.find((o: Option) =>
            (o.text && String(o.optionId) === String(answerId)) ||
            (o.text && String(o.value) === String(answerId))
          );
        }

        if (!match && !shouldShuffle) {
          if (typeof id === 'number' && id >= 0 && question.options[id]) {
            match = question.options[id];
          }
        }

        return match;
      })
      .filter((o): o is Option => !!o);
  }

  /**
   * Evaluates whether the user answered correctly for a given question.
   * Returns { isCorrect, numberOfCorrectAnswers, multipleAnswer, resolvedAnswers }.
   */
  async evaluateCorrectness(
    _qIndex: number,
    currentQuestion: QuizQuestion,
    userAnswerIds: number[]
  ): Promise<{
    isCorrect: boolean;
    numberOfCorrectAnswers: number;
    multipleAnswer: boolean;
    resolvedAnswers: Option[];
    answerIds: number[];
  }> {
    const numberOfCorrectAnswers = currentQuestion.options.filter(
      (option) => !!option.correct && String(option.correct) !== 'false'
    ).length;
    const multipleAnswer = numberOfCorrectAnswers > 1;

    const resolvedAnswers = userAnswerIds
      .map((id) => {
        const found = currentQuestion.options.find((o: Option) =>
          String(o.optionId) === String(id)
        );
        if (found) return found;

        if (typeof id === 'number') {
          if (id >= 0 && id < currentQuestion.options.length) {
            return currentQuestion.options[id];
          }
          if (id > 100) {
            const optIdx = (id % 100) - 1;
            if (optIdx >= 0 && optIdx < currentQuestion.options.length) {
              return currentQuestion.options[optIdx];
            }
          }
        }
        return { optionId: id } as Option;
      })
      .filter((o): o is Option => !!o);

    if (!resolvedAnswers || resolvedAnswers.length === 0) {
      return { isCorrect: false, numberOfCorrectAnswers, multipleAnswer, resolvedAnswers, answerIds: [] };
    }

    const correctnessArray =
      await this.optionsService.determineCorrectAnswer(currentQuestion, resolvedAnswers);
    const allSelectedAreCorrect = correctnessArray.every((v) => v === true);
    const isCorrect =
      allSelectedAreCorrect && correctnessArray.length === numberOfCorrectAnswers;
    const answerIds =
      resolvedAnswers.map((a) => a.optionId).filter((id): id is number => id !== undefined);

    return { isCorrect, numberOfCorrectAnswers, multipleAnswer, resolvedAnswers, answerIds };
  }

  /**
   * Validates isCorrect=true against pristine quiz data and user selections.
   * Returns true if scoring should proceed, false if blocked.
   */
  verifyScoreAgainstPristine(
    questionIndex: number,
    isCorrect: boolean,
    isMultipleAnswer: boolean,
    shouldShuffle: boolean,
    quizId: string,
    quizInitialState: Quiz[],
    questions: QuizQuestion[],
    answers: Option[],
    userAnswers: any[]
  ): boolean {
    if (!isCorrect) return true;
    if (shouldShuffle) return true;

    const bundle: any[] = quizInitialState ?? [];

    let pristineCorrectTexts: string[] = [];

    const q = questions?.[questionIndex];
    const qText = norm(q?.questionText);
    if (qText) {
      for (const quiz of bundle) {
        for (const pq of (quiz?.questions ?? [])) {
          if (norm(pq?.questionText) !== qText) continue;

          pristineCorrectTexts = (pq?.options ?? [])
            .filter((o: any) => isOptionCorrect(o))
            .map((o: any) => norm(o?.text))
            .filter((t: string) => !!t);

          break;
        }
        if (pristineCorrectTexts.length > 0) break;
      }
    }

    if (pristineCorrectTexts.length === 0 && quizId) {
      const pristineQuiz = bundle.find((qz: any) => qz?.quizId === quizId);
      const pristineQ = pristineQuiz?.questions?.[questionIndex];
      if (pristineQ) {
        pristineCorrectTexts = (pristineQ?.options ?? [])
          .filter((o: any) => isOptionCorrect(o))
          .map((o: any) => norm(o?.text))
          .filter((t: string) => !!t);
      }
    }

    if (pristineCorrectTexts.length === 0) return true;
    if (pristineCorrectTexts.length > 1 && !isMultipleAnswer) return false;

    const selTexts = new Set<string>();

    try {
      const sos = this.selectedOptionServiceLazy;
      if (sos) {
        const selections = sos.getSelectedOptionsForQuestion(questionIndex) ?? [];
        for (const s of selections) {
          const t = norm((s as any)?.text);
          if (t) selTexts.add(t);
        }
      }
    } catch (err: unknown) {
      console.error('Failed to retrieve selected options for evaluation:', err);
    }

    if (selTexts.size === 0 && answers?.length > 0) {
      for (const a of answers) {
        const t = norm((a as any)?.text);
        if (t) selTexts.add(t);
      }
    }

    if (selTexts.size === 0) {
      try {
        const uaIds = Array.isArray(userAnswers?.[questionIndex])
          ? (userAnswers[questionIndex] as number[]) : [];
        const qOpts = questions?.[questionIndex]?.options ?? [];
        for (const id of uaIds) {
          const opt = qOpts.find((o: any) => String(o?.optionId) === String(id))
            ?? (typeof id === 'number' && id >= 0 && id < qOpts.length ? qOpts[id] : null);
          if (opt) {
            const t = norm((opt as any)?.text);
            if (t) selTexts.add(t);
          }
        }
      } catch (err: unknown) { swallow('quiz-answer-evaluation.service.ts', err); }
    }

    // Cross-visit union: fold in uiSelectedTexts (live bindings ∪ first-visit
    // snapshot) so COMPLETING a multi-answer on REVISIT verifies. The sources
    // above reset on navigation and hold only the just-clicked option, which
    // would fail the every()-correct check below and block the credit.
    try {
      const sos = this.selectedOptionServiceLazy;
      const ui = sos?.uiSelectedTextsForQuestion?.(questionIndex);
      if (ui) for (const t of ui) { const n = norm(t); if (n) selTexts.add(n); }
    } catch (err: unknown) { swallow('quiz-answer-evaluation.service.ts ui-union', err); }

    if (selTexts.size > 0) {
      if (pristineCorrectTexts.length === 1) {
        if (!pristineCorrectTexts.some(t => selTexts.has(t))) return false;
      } else {
        if (!pristineCorrectTexts.every(t => selTexts.has(t))) return false;
      }
    }

    return true;
  }

  // ── private methods ─────────────────────────────────────────────
  private get selectedOptionServiceLazy(): SelectedOptionService | null {
    if (!this._selectedOptionService) {
      try {
        this._selectedOptionService = this.injector.get(SelectedOptionService);
      } catch (err: unknown) { swallow('quiz-answer-evaluation.service.ts', err); /* ignore */ }
    }
    return this._selectedOptionService;
  }
}
