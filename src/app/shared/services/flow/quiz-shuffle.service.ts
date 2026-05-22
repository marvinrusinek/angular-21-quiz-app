import { Injectable } from '@angular/core';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';
import { ShuffleState } from '../../models/ShuffleState.model';

import { Utils } from '../../utils/utils';

export interface PrepareShuffleOpts {
  shuffleQuestions?: boolean,
  shuffleOptions?: boolean
}

@Injectable({ providedIn: 'root' })
export class QuizShuffleService {
  // ── properties ──────────────────────────────────────────────────
  private shuffleByQuizId = new Map<string, ShuffleState>();

  // ── public methods ──────────────────────────────────────────────

  // Call once starting a quiz session (after fetching questions)
  public prepareShuffle(
    quizId: string,
    questions: QuizQuestion[],
    opts: PrepareShuffleOpts = { shuffleQuestions: true, shuffleOptions: false }  // Question shuffle ON, Option shuffle OFF for stability
  ): void {
    // Only shuffle ONCE per quiz session.
    // If we already have a shuffle order for this quiz, DO NOT recreate it!
    if (this.shuffleByQuizId.has(quizId)) {
      // Fix any pre-existing option shuffling: normalize option orders to identity
      this.normalizeOptionOrders(quizId, questions);
      return;
    }

    // Check persistence
    if (this.loadState(quizId)) {
      const state = this.shuffleByQuizId.get(quizId);
      if (state && state.questionOrder.length === questions.length) {
        // Fix any pre-existing option shuffling: normalize option orders to identity
        this.normalizeOptionOrders(quizId, questions);
        return;
      }
      // Persisted shuffle length mismatch â€” regenerating
      this.shuffleByQuizId.delete(quizId);
      localStorage.removeItem(`shuffleState:${quizId}`);
    }

    // Question shuffling enabled, but option shuffling disabled for stability
    const { shuffleQuestions = true, shuffleOptions = false } = opts;

    const qIdx = questions.map((_, i) => i);
    const questionOrder = shuffleQuestions ? Utils.shuffleArray(qIdx) : qIdx;

    const optionOrder = new Map<number, number[]>();
    for (const origIdx of questionOrder) {
      const len = questions[origIdx]?.options?.length ?? 0;
      const base = Array.from({ length: len }, (_, i) => i);
      optionOrder.set(
        origIdx,
        shuffleOptions ? Utils.shuffleArray(base) : base
      );
    }

    this.shuffleByQuizId.set(quizId, { questionOrder, optionOrder });
    this.saveState(quizId);
  }

  public hasShuffleState(quizId: string): boolean {
    return this.shuffleByQuizId.has(quizId) ||
      !!localStorage.getItem(`shuffleState:${quizId}`);
  }

  public getShuffleState(quizId: string): ShuffleState | undefined {
    if (!this.shuffleByQuizId.has(quizId)) this.loadState(quizId);
    return this.shuffleByQuizId.get(quizId);
  }

  public alignAnswersWithOptions(
    rawAnswers: Option[] | undefined,
    options: Option[] = [],
  ): Option[] {
    const normalizedOptions = Array.isArray(options) ? options : [];
    if (normalizedOptions.length === 0) return [];

    const answers = Array.isArray(rawAnswers) ? rawAnswers : [];
    const aligned = answers
      .map((answer) => this.normalizeAnswerReference(answer, normalizedOptions))
      .filter((option): option is Option => option != null);

    if (aligned.length > 0) {
      const seen = new Set<number>();
      return aligned
        .filter((option) => {
          const id = this.toNum(option.optionId);
          if (id == null) {
            return true;
          }
          if (seen.has(id)) {
            return false;
          }
          seen.add(id);
          return true;
        })
        .map((option) => ({ ...option }));
    }

    const fallback = normalizedOptions.filter((option) => option.correct);
    if (fallback.length > 0) return fallback.map((option) => ({ ...option }));

    return [];
  }

  // Map display index -> original index (for scoring, persistence, timers)
  public toOriginalIndex(quizId: string, displayIdx: number): number | null {
    if (!this.shuffleByQuizId.has(quizId)) this.loadState(quizId);

    const state = this.shuffleByQuizId.get(quizId);
    if (!state) return null;

    const result = state.questionOrder[displayIdx] ?? null;
    return result;
  }

  // Get a question re-ordered by the saved permutation (options included).
  public getQuestionAtDisplayIndex(
    quizId: string,
    displayIdx: number,
    allQuestions: QuizQuestion[]
  ): QuizQuestion | null {
    const state = this.shuffleByQuizId.get(quizId);
    if (!state) return null;

    const origIdx = state.questionOrder[displayIdx];
    const src = allQuestions[origIdx];
    if (!src) return null;

    // Ensure numeric, stable optionId before reordering
    const normalizedOpts = this.cloneAndNormalizeOptions(
      src.options ?? [],
      origIdx
    );
    const order = state.optionOrder.get(origIdx);
    const safeOptions = this.reorderOptions(normalizedOpts, order);

    const alignedAnswers = this.alignAnswersWithOptions(src.answer, safeOptions);

    return {
      ...src,
      options: safeOptions.map((option) => ({ ...option })),
      answer: alignedAnswers
    };
  }

  public buildShuffledQuestions(
    quizId: string,
    questions: QuizQuestion[]
  ): QuizQuestion[] {
    if (!Array.isArray(questions) || questions.length === 0) return [];

    const state = this.shuffleByQuizId.get(quizId);
    if (!state) {
      return questions.map((question, index) => {
        const normalizedOptions = this.cloneAndNormalizeOptions(
          question.options ?? [],
          index,  // use loop index as question index
        );
        return {
          ...question,
          options: normalizedOptions.map((option) => ({ ...option })),
          answer: this.alignAnswersWithOptions(
            question.answer,
            normalizedOptions
          )
        };
      });
    }

    const displaySet = state.questionOrder
      .map((originalIndex) => {
        const source = questions[originalIndex];
        if (!source) return null;

        const normalizedOptions = this.cloneAndNormalizeOptions(
          source.options ?? [],
          originalIndex
        );
        const orderedOptions = this.reorderOptions(
          normalizedOptions,
          state.optionOrder.get(originalIndex)
        );

        const alignedAnswers = this.alignAnswersWithOptions(source.answer, orderedOptions);
        const correctIds = new Set(alignedAnswers.map(a => Number(a.optionId)));
        const correctTexts = new Set(alignedAnswers.map(a => (a.text ?? '').trim().toLowerCase()));

        return {
          ...source,
          options: orderedOptions.map((option) => ({
            ...option,
            correct: option.correct === true ||
              (option.optionId !== undefined && correctIds.has(Number(option.optionId))) ||
              (option.text !== undefined && correctTexts.has((option.text ?? '').trim().toLowerCase()))
          })),
          answer: alignedAnswers
        } as QuizQuestion;
      })
      .filter((question): question is QuizQuestion => question !== null);

    if (displaySet.length === 0) {
      return questions.map((question, index) => {
        const normalizedOptions = this.cloneAndNormalizeOptions(
          question.options ?? [],
          index
        );
        const alignedAnswers = this.alignAnswersWithOptions(
          question.answer,
          normalizedOptions
        );
        const correctIds = new Set(alignedAnswers.map(a => Number(a.optionId)));
        const correctTexts = new Set(alignedAnswers.map(a => (a.text ?? '').trim().toLowerCase()));

        return {
          ...question,
          options: normalizedOptions.map((option) => ({
            ...option,
            correct: option.correct === true ||
              (option.optionId !== undefined && correctIds.has(Number(option.optionId))) ||
              (option.text !== undefined && correctTexts.has((option.text ?? '').trim().toLowerCase()))
          })),
          answer: alignedAnswers
        };
      });
    }

    return displaySet;
  }

  // Clear when the session ends
  public clear(quizId: string): void {
    this.shuffleByQuizId.delete(quizId);
    localStorage.removeItem(`shuffleState:${quizId}`);
  }

  public clearAll(): void {
    this.shuffleByQuizId.clear();
    try {
      const keys = Object.keys(localStorage);
      for (const key of keys) {
        if (key.startsWith('shuffleState:')) {
          localStorage.removeItem(key);
        }
      }
    } catch (err: any) {
      // clear failed â€” non-critical
    }
  }

  // Make optionId numeric & stable; idempotent. Prefer 1-based ids for compatibility
  // with existing quiz logic while always normalising the display order.
  // Make optionId numeric & stable; idempotent. Uses questionIndex to ensure global uniqueness.
  public assignOptionIds(options: Option[], questionIndex: number): Option[] {
    return (options ?? []).map((o, i) => {
      // Build a globally unique numeric ID like 101, 102, 201, 202, etc.
      // Format: (QuestionIndex + 1) * 100 + (OptionIndex + 1)
      // This is stable and idempotent.
      const uniqueId = (questionIndex + 1) * 100 + (i + 1);

      return {
        ...o,
        optionId: uniqueId,
        // Fallback so selectedOptions.includes(option.value) remains viable
        value: (o as any).value ?? (o as any).text ?? uniqueId
      } as Option;
    });
  }

  // ── private methods ─────────────────────────────────────────────

  /**
   * Resets all option orders to identity (no option shuffling).
   * Called to fix pre-existing shuffle states that had option shuffling enabled.
   */
  private normalizeOptionOrders(quizId: string, _questions: QuizQuestion[]): void {
    const state = this.shuffleByQuizId.get(quizId);
    if (!state) return;

    let changed = false;
    for (const [origIdx, order] of state.optionOrder.entries()) {
      const identity = Array.from({ length: order.length }, (_, i) => i);
      const isIdentity = order.length === identity.length &&
        order.every((v, i) => v === i);
      if (!isIdentity) {
        state.optionOrder.set(origIdx, identity);
        changed = true;
      }
    }

    if (changed) this.saveState(quizId);
  }

  // Persistence Utilities
  private saveState(quizId: string): void {
    const state = this.shuffleByQuizId.get(quizId);
    if (!state) return;

    try {
      // Convert Map to Array for JSON serialization
      const serializedState = {
        questionOrder: state.questionOrder,
        optionOrder: Array.from(state.optionOrder.entries())
      };
      localStorage.setItem(`shuffleState:${quizId}`, JSON.stringify(serializedState));
    } catch (err: any) {
      // persist failed â€” non-critical
    }
  }

  private loadState(quizId: string): boolean {
    try {
      const raw = localStorage.getItem(`shuffleState:${quizId}`);
      if (!raw) return false;

      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.questionOrder || !Array.isArray(parsed.optionOrder)) return false;

      const state: ShuffleState = {
        questionOrder: parsed.questionOrder,
        optionOrder: new Map(parsed.optionOrder)
      };

      this.shuffleByQuizId.set(quizId, state);
      return true;
    } catch (err: any) {
      // load failed â€” non-critical
      return false;
    }
  }

  private reorderOptions(options: Option[], order?: number[]): Option[] {
    if (!Array.isArray(options) || options.length === 0) return [];

    const normalizeForDisplay = (opts: Option[]): Option[] =>
      opts.map((option, index) => {
        const id = this.toNum(option.optionId) ?? index + 1;

        // value must remain a number per your model
        const numericValue =
          typeof option.value === 'number'
            ? option.value : (this.toNum(option.value) ?? id);

        return {
          ...option,
          optionId: id,
          displayOrder: index,  // if this isn't in Option, you can keep it as an extension or drop it
          value: numericValue   // always number
        } as Option;  // if displayOrder isn't in Option, use a local type if you need it
      });

    if (!Array.isArray(order) || order.length !== options.length) {
      return normalizeForDisplay(options.map((option) => ({ ...option })));
    }

    const reordered = order
      .map((sourceIndex) => {
        const option = options[sourceIndex];
        if (!option) return null;
        return { ...option } as Option;
      })
      .filter((option): option is Option => option !== null);

    if (reordered.length !== options.length) {
      return normalizeForDisplay(options.map((option) => ({ ...option })));
    }

    return normalizeForDisplay(reordered);
  }

  private normalize(val: unknown): string {
    return String(val ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/ /g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  private normalizeAnswerReference(
    answer: Option | null | undefined,
    options: Option[]
  ): Option | null {
    if (!answer) return null;

    const byId = this.toNum(answer.optionId);
    if (byId != null) {
      const matchById = options.find(
        (option) => this.toNum(option.optionId) === byId
      );
      if (matchById) return matchById;
    }

    const byValue = this.toNum(answer.value);
    if (byValue != null) {
      const matchByValue = options.find(
        (option) => this.toNum(option.value) === byValue
      );
      if (matchByValue) return matchByValue;
    }

    const normAnsText = this.normalize(answer.text);
    if (normAnsText) {
      const matchByText = options.find(
        (option) => this.normalize(option.text) === normAnsText
      );
      if (matchByText) return matchByText;
    }

    return null;
  }

  private toNum(v: unknown): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const n = Number(String(v));
    return Number.isFinite(n) ? n : null;
  }

  private cloneAndNormalizeOptions(
    options: Option[] = [],
    questionIndex: number
  ): Option[] {
    const withIds = this.assignOptionIds(options, questionIndex);
    return withIds.map((option, index) => ({
      ...option,
      displayOrder: index,
      correct: (option.correct as any) === true || (option.correct as any) === 'true',
      selected: option.selected === true,
      highlight: option.highlight ?? false,
      showIcon: option.showIcon ?? false
    }));
  }
}
