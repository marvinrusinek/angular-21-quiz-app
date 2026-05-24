import { Injectable } from '@angular/core';

import { QuestionType } from '../../models/question-type.enum';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';
import { SelectedOption } from '../../models/SelectedOption.model';

import { OptionIdResolverService } from './option-id-resolver.service';
import { QuizService } from '../data/quiz.service';

import { isOptionCorrect } from '../../utils/is-option-correct';
import { norm } from '../../utils/text-norm';

export interface ResolutionStatus {
  resolved: boolean;
  correctTotal: number;
  correctSelected: number;
  incorrectSelected: number;
  remainingCorrect: number;
}

@Injectable({ providedIn: 'root' })
export class AnswerEvaluationService {
  constructor(
    private quizService: QuizService,
    private idResolver: OptionIdResolverService
  ) {}

  // ── Question completeness ──────────────────────────────────

  isQuestionComplete(
    question: QuizQuestion,
    selected: SelectedOption[]
  ): boolean {
    if (!question || !Array.isArray(question.options)) return false;
    if (!selected || selected.length === 0) return false;

    const totalCorrect = question.options.filter((o: Option) => isOptionCorrect(o)).length;
    if (totalCorrect === 0) return false;

    const selectedCorrectCount = selected.filter(sel => {
      const c = (sel as any).correct;
      if (c === true || String(c) === 'true' || c === 1 || c === '1') {
        return true;
      }

      const selIdStr = String(sel.optionId);

      const matchById = question.options.find(o =>
        (o.optionId !== undefined && o.optionId !== null) && String(o.optionId) === selIdStr
      );
      if (matchById) return !!matchById.correct;

      const numericId = Number(sel.optionId);
      if (Number.isInteger(numericId)) {
        const index = numericId - 1;
        if (index >= 0 && index < question.options.length) {
          const target = question.options[index];
          if (target.optionId === undefined || target.optionId === null) {
            return !!target.correct;
          }
        }
      }
      return false;
    }).length;

    const selectedIncorrectCount = selected.length - selectedCorrectCount;

    return selectedCorrectCount === totalCorrect && selectedIncorrectCount === 0;
  }

  // ── Resolution status ──────────────────────────────────────

  isQuestionResolvedCorrectly(
    question: QuizQuestion,
    selected: Array<SelectedOption | Option> | null
  ): boolean {
    return this.getResolutionStatus(question, selected as Option[], true).resolved;
  }

  isQuestionResolvedLeniently(
    question: QuizQuestion,
    selected: Array<SelectedOption | Option> | null
  ): boolean {
    return this.getResolutionStatus(question, selected as Option[], false).resolved;
  }

  isAnyCorrectAnswerSelected(
    question: QuizQuestion,
    selected: Array<SelectedOption | Option> | null
  ): boolean {
    const status = this.getResolutionStatus(question, selected as Option[], false);
    return status.correctSelected > 0;
  }

  getResolutionStatus(
    question: QuizQuestion,
    selected: Option[],
    strict: boolean = false
  ): ResolutionStatus {
    if (!question) {
      return { resolved: false, correctTotal: 0, correctSelected: 0, incorrectSelected: 0, remainingCorrect: 0 };
    }

    let questionOptions = Array.isArray(question.options) ? question.options : [];
    try {
      const qText = norm(question.questionText);
      const pristineBundle: any[] = (this.quizService as any)?.quizInitialState ?? [];
      let pristineQ: any = null;
      for (const quiz of pristineBundle) {
        for (const pq of (quiz?.questions ?? [])) {
          if (norm(pq?.questionText) === qText) {
            pristineQ = pq;
            break;
          }
        }
        if (pristineQ) break;
      }
      if (pristineQ && Array.isArray(pristineQ.options)) {
        const pristineCorrectCount = pristineQ.options.filter((o: any) =>
          o?.correct === true || String(o?.correct) === 'true'
        ).length;
        const currentCorrectCount = questionOptions.filter(o =>
          this.idResolver.coerceToBoolean(o.correct)
        ).length;
        if (pristineCorrectCount !== currentCorrectCount) {
          questionOptions = pristineQ.options;
        }
      }
      if (!pristineQ) {
        const rawQs: any[] = this.quizService?.questions ?? [];
        const rawQ = qText
          ? rawQs.find(r => norm(r?.questionText) === qText)
          : null;
        if (rawQ && Array.isArray(rawQ.options)) {
          const rawCorrectCount = rawQ.options.filter((o: any) =>
            o?.correct === true || String(o?.correct) === 'true'
          ).length;
          const currentCorrectCount = questionOptions.filter(o =>
            this.idResolver.coerceToBoolean(o.correct)
          ).length;
          if (rawCorrectCount > currentCorrectCount) {
            questionOptions = rawQ.options;
          }
        }
      }
    } catch { /* ignore and keep original */ }
    const correctTotal = 
      questionOptions.filter(o => this.idResolver.coerceToBoolean(o.correct)).length;

    let correctSelected = 0;
    let incorrectSelected = 0;

    const selectedArr = Array.isArray(selected) ? selected : [];
    const seenIndicesInQuestion = new Set<number>();

    const hasRealIds = questionOptions.some(o => o.optionId != null);
    for (const sel of selectedArr) {
      if (!sel) continue;
      if ((sel as any).selected === false) continue;

      let matchedIdx = -1;

      // STRATEGY 1: TEXT MATCH
      if (sel.text) {
        const selText = norm(sel.text);
        matchedIdx = questionOptions.findIndex(o =>
          o.text && norm(o.text) === selText
        );
      }

      // STRATEGY 2: ID MATCH
      if (matchedIdx === -1 && sel.optionId != null && hasRealIds) {
        const selIdStr = String(sel.optionId);
        matchedIdx = questionOptions.findIndex(o =>
          o.optionId != null && String(o.optionId) === selIdStr
        );
      }

      // STRATEGY 3: Synthetic ID Modulo
      if (matchedIdx === -1 && typeof sel.optionId === 'number' && sel.optionId > 100) {
        const potentialIdx = (sel.optionId % 100) - 1;
        if (potentialIdx >= 0 && potentialIdx < questionOptions.length) {
          matchedIdx = potentialIdx;
        }
      }

      // STRATEGY 4: Explicit index fallback
      if (matchedIdx === -1 && typeof (sel as any).index === 'number') {
        const idx = (sel as any).index;
        if (idx >= 0 && idx < questionOptions.length) {
          matchedIdx = idx;
        }
      }

      if (matchedIdx !== -1) {
        if (seenIndicesInQuestion.has(matchedIdx)) continue;
        seenIndicesInQuestion.add(matchedIdx);

        const isCorrect = this.idResolver.coerceToBoolean(questionOptions[matchedIdx].correct);
        if (isCorrect) {
          correctSelected++;
        } else {
          incorrectSelected++;        }
      } else {
        if (this.idResolver.coerceToBoolean(sel.correct)) {
          correctSelected++;
        } else {
        incorrectSelected++;        }
      }
    }

    const remainingCorrect = Math.max(correctTotal - correctSelected, 0);
    let resolved = correctTotal > 0 && remainingCorrect === 0;

    if (strict) resolved = resolved && incorrectSelected === 0;
    
    return { resolved, correctTotal, correctSelected, incorrectSelected, 
      remainingCorrect };
  }

  // ── Multi-answer detection ─────────────────────────────────
  isMultiAnswerQuestion(questionIndex: number): boolean {
    const q = this.quizService.questions?.[questionIndex];
    if (!q) return false;
    if (q.type === QuestionType.MultipleAnswer) return true;
    if (!Array.isArray(q.options)) return false;

    const correctAnswersCount = (q.options ?? []).filter(
      (o: Option) => o.correct === true || String(o.correct) === 'true'
    ).length;
    return correctAnswersCount > 1;
  }

  // ── Static correctness checks ──────────────────────────────
  areAllCorrectAnswersSelected(
    question: QuizQuestion,
    selectedOptionIds: Set<number>
  ): boolean {
    const correctIds = question.options
      .filter(o => {
        const c = (o as any).correct;
        return c === true || String(c) === 'true' || c === 1 || c === '1';
      })
      .map(o => o.optionId)
      .filter((id): id is number => typeof id === 'number');

    if (correctIds.length === 0) return false;

    const selectedStrings = new Set(Array.from(selectedOptionIds).map(id => String(id)));

    for (const id of correctIds) {
      if (!selectedStrings.has(String(id))) return false;
    }

    return true;
  }

  areAllCorrectAnswersSelectedForQuestion(
    questionIndex: number,
    getSelectedOptionsForQuestion: (idx: number) => SelectedOption[],
    questionCache: Map<number, QuizQuestion>
  ): boolean {
    try {
      const qIndex = this.quizService.currentQuestionIndexSig?.() ?? questionIndex;

      const question = questionCache.get(qIndex);
      if (!question || !Array.isArray(question.options)) return false;

      const selected = getSelectedOptionsForQuestion(qIndex) ?? [];
      if (selected.length === 0) return false;

      const correctOptions = question.options.filter((o: Option) => isOptionCorrect(o));
      const correctIds = new Set(correctOptions.map((o) => String(o.optionId)));

      const selectedIds = new Set(
        selected.map((o) => String((o as any).optionId ?? ''))
      );

      for (const id of selectedIds) {
        if (!correctIds.has(id)) return false;
      }

      return (
        correctIds.size > 0 &&
        selectedIds.size === correctIds.size &&
        [...selectedIds].every((id) => correctIds.has(id))
      );
    } catch (err: any) {
      // Error evaluating correctness
      return false;
    }
  }
}