import { Injectable, inject } from '@angular/core';

import { SK_SEL_Q } from '../../../constants/session-keys';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { ExplanationTextService } from '../explanation/explanation-text.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { isOptionCorrect } from '../../../utils/is-option-correct';

/**
 * Context passed from the component for explanation resolution.
 */
export interface ExplanationContext {
  /** The resolved display index for the question */
  resolvedIndex: number;
  /** The question object (already resolved from display index) */
  question: QuizQuestion | null;
  /** The current question from the component (may be stale) */
  currentQuestion: QuizQuestion | null;
  /** The quiz ID */
  quizId: string;
  /** Option bindings currently rendered */
  optionBindings: OptionBindings[];
  /** Options to display (input property) */
  optionsToDisplay: Option[];
  /** Whether this is a multi-answer question */
  isMultiMode: boolean;
}

@Injectable({ providedIn: 'root' })
export class SharedOptionExplanationService {
  pendingExplanationIndex = -1;

  private explanationTextService = inject(ExplanationTextService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Main Explanation Emission
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Resolves the question index, applies stale-call guard, builds context,
   * and delegates to emitExplanation. Called from the component's thin wrapper.
   */
  resolveAndEmitExplanation(params: {
    questionIndex: number;
    activeQuestionIndex: number;
    currentQuestion: QuizQuestion | null;
    quizId: string;
    optionBindings: OptionBindings[];
    optionsToDisplay: Option[];
    isMultiMode: boolean;
    getQuestionAtDisplayIndex: (idx: number) => QuizQuestion | null;
  }, skipGuard = false): void {
    const { questionIndex, activeQuestionIndex, currentQuestion, getQuestionAtDisplayIndex } = params;

    const resolvedIndex = Number.isFinite(activeQuestionIndex)
      ? Math.max(0, Math.trunc(activeQuestionIndex))
      : Number.isFinite(questionIndex)
        ? Math.max(0, Math.trunc(questionIndex))
        : this.resolveExplanationQuestionIndex(questionIndex, activeQuestionIndex);

    const question =
      getQuestionAtDisplayIndex(resolvedIndex)
      ?? currentQuestion
      ?? this.quizService.questions?.[resolvedIndex]
      ?? null;

    // Guard: Prevent stale deferred calls from emitting for the wrong question.
    if (currentQuestion && resolvedIndex !== questionIndex) {
      const questionAtIndex = getQuestionAtDisplayIndex(resolvedIndex)
        ?? this.quizService.getQuestionsInDisplayOrder?.()?.[resolvedIndex]
        ?? this.quizService.questions?.[resolvedIndex];
      if (questionAtIndex && questionAtIndex.questionText !== currentQuestion.questionText) {
        return;
      }
    }

    const ctx: ExplanationContext = {
      resolvedIndex,
      question,
      currentQuestion,
      quizId: params.quizId,
      optionBindings: params.optionBindings,
      optionsToDisplay: params.optionsToDisplay,
      isMultiMode: params.isMultiMode
    };

    this.emitExplanation(ctx, skipGuard);
  }

  /**
   * Evaluates whether the question is resolved, then formats and emits
   * the explanation text through all required service channels.
   */
  emitExplanation(ctx: ExplanationContext, skipGuard = false): void {
    const { resolvedIndex, question } = ctx;

    // Guard: Emit FET only when the question is resolved correctly.
    // Use display-order question source to handle shuffled mode correctly.
    const authQ = this.quizService.getQuestionsInDisplayOrder?.()?.[resolvedIndex]
      ?? this.quizService.questions?.[resolvedIndex] ?? question;

    if (!skipGuard) {
      if (authQ && Array.isArray(authQ.options)) {
        const resolved = this.checkResolution(ctx);
        if (!resolved) return;
      } else if (!question || !Array.isArray(question?.options)) {
        // No question data available â€” cannot verify resolution. Block FET.
        return;
      }
    }

    const explanationText = this.resolveExplanationText(ctx)?.trim()
      || question?.explanation || '';

    if (!explanationText) return;

    // Cache the resolved formatted text
    this.cacheResolvedFormattedExplanation(resolvedIndex, explanationText);

    // Clear locks and pulse stream
    try {
      this.explanationTextService._fetLocked = false;
      this.explanationTextService.unlockExplanation();
    } catch (err) {
      console.error('SharedOptionExplanationService.emitExplanation unlock failed:', err);
    }

    // Force display flags to TRUE
    this.explanationTextService.setIsExplanationTextDisplayed(true);
    this.explanationTextService.shouldDisplayExplanationSig.set(true);

    this.pendingExplanationIndex = resolvedIndex;
    this.applyExplanationText(explanationText, resolvedIndex);
    this.scheduleExplanationVerification(resolvedIndex, explanationText);
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Resolution Check
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Checks whether the question is resolved (all correct answers selected).
   * Uses UI state first, falls back to service state.
   */
  private checkResolution(ctx: ExplanationContext): boolean {
    const { resolvedIndex, question, optionBindings, optionsToDisplay } = ctx;

    // Use authoritative question source â€” the component's question.options
    // often lack the `correct` flag, making correctCount=0 and falling to
    // single-answer logic which resolves on 1 correct selection.
    const authQuestion = this.quizService.getQuestionsInDisplayOrder?.()?.[resolvedIndex]
      ?? this.quizService.questions?.[resolvedIndex] ?? question;
    // Always resolve correct count and texts from pristine quizInitialState.
    // After Restart Quiz, live options can have ALL correct flags set to true
    // (stale mutation), inflating correctCount and bypassing the multi-answer
    // gate. Pristine data is immutable and always authoritative.
    let correctCount = 0;
    let pristineCorrectTexts = new Set<string>();
    const qText = authQuestion?.questionText ?? question?.questionText;
    const pristineSet = this.quizService?.getPristineCorrectTextsForQuestion?.(qText);
    if (pristineSet && pristineSet.size > 0) {
      correctCount = pristineSet.size;
      pristineCorrectTexts = new Set(pristineSet);
    }
    // Fallback: use live data only if pristine lookup failed
    if (correctCount === 0) {
      correctCount = (authQuestion?.options ?? question!.options).filter(
        (o: any) => isOptionCorrect(o)
      ).length;
    }
    const isMultiAnswer = correctCount > 1 || this.quizService.multipleAnswer;

    // RESOLVE: optionBindings may be a signal (-clean) or array (-main)
    const _rawOb1 = optionBindings as any;
    const _ob1: any[] = typeof _rawOb1 === 'function' ? (_rawOb1() ?? []) : (_rawOb1 ?? []);
    const visualOptions = (Array.isArray(_ob1) && _ob1.length > 0)
      ? _ob1.map((b: OptionBindings) => b.option)
      : (optionsToDisplay ?? []);

    const selectedFromUi = visualOptions
      .map((opt: any, idx: number) => {
        const bindingSelected = _ob1?.[idx]?.isSelected === true;
        const optionSelected = opt?.selected === true || bindingSelected;
        return optionSelected
          ? ({
            optionId: opt?.optionId,
            text: opt?.text,
            correct: opt?.correct,
            displayIndex: idx
          } as any)
          : null;
      })
      .filter((opt: any) => opt != null);

    const selectedFromService =
      this.selectedOptionService.getSelectedOptionsForQuestion(resolvedIndex) ?? [];

    const isSelectionCorrect = (sel: any): boolean => {
      const selText = this.normalize(sel?.text);
      if (pristineCorrectTexts.size > 0 && selText) {
        return pristineCorrectTexts.has(selText);
      }
      if (isOptionCorrect(sel)) return true;

      const selId = sel?.optionId;

      const byId = question!.options.find((o: any) =>
        o?.optionId !== undefined && o?.optionId !== null &&
        String(o.optionId) === String(selId)
      );
      if (byId) return isOptionCorrect(byId);

      const byText = question!.options.find((o: any) =>
        this.normalize(o?.text) !== '' && this.normalize(o?.text) === selText
      );
      if (byText) return isOptionCorrect(byText);

      return false;
    };

    const uiResolved = (() => {
      if (selectedFromUi.length === 0) return false;

      const correctSelected = selectedFromUi.filter(isSelectionCorrect).length;

      if (correctCount > 1) {
        return correctSelected >= correctCount;
      }
      return correctSelected >= 1;
    })();

    const status = this.selectedOptionService.getResolutionStatus(
      question!,
      selectedFromService as any,
      false
    );

    let resolved = (selectedFromUi.length > 0) ? uiResolved : status.resolved;

    // Multi-answer pristine gate: regardless of UI/service verdict, require
    // that ALL pristine-correct option texts are present in selected set
    // (UI union service). Blocks false positives when flags are mutated.
    if (isMultiAnswer && pristineCorrectTexts.size > 0) {
      const selectedTexts = new Set<string>();
      for (const s of selectedFromUi) {
        const t = this.normalize(s?.text);
        if (t) selectedTexts.add(t);
      }
      for (const s of selectedFromService) {
        if (s?.selected === false) continue;
        const t = this.normalize((s as any)?.text);
        if (t) selectedTexts.add(t);
      }
      try {
        const idx = resolvedIndex;
        const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SK_SEL_Q + idx) : null;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (const s of parsed) {
              if (s?.selected !== true) continue;
              const t = this.normalize(s?.text);
              if (t) selectedTexts.add(t);
            }
          }
        }
      } catch { /* ignore */ }
      let allPresent = true;
      for (const t of pristineCorrectTexts) {
        if (!selectedTexts.has(t)) { allPresent = false; break; }
      }
      if (!allPresent) resolved = false;
    }

    // For multi-answer questions, do NOT let the service override the UI
    // check. The service's selectedOptionsMap can be contaminated by init
    // paths, causing it to report "resolved" when only 1 of 2 correct
    // answers are actually selected. Only allow override for single-answer.
    if (!resolved && status.resolved && !isMultiAnswer) resolved = true;

    return resolved;
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Apply & Verify
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  applyExplanationText(
    explanationText: string,
    displayIndex: number
  ): void {
    this.quizStateService.markUserInteracted(displayIndex);

    const contextKey = this.buildExplanationContext(displayIndex);

    this.explanationTextService._activeIndex = displayIndex;
    this.explanationTextService.latestExplanation = explanationText;
    this.explanationTextService.latestExplanationIndex = displayIndex;

    this.explanationTextService.emitFormatted(displayIndex, explanationText);

    this.explanationTextService.setExplanationText(explanationText, {
      force: true,
      context: contextKey,
      index: displayIndex
    });

    const displayOptions = { context: contextKey, force: true } as const;
    this.explanationTextService.setShouldDisplayExplanation(
      true,
      displayOptions
    );
    this.explanationTextService.setIsExplanationTextDisplayed(
      true,
      displayOptions
    );
    this.explanationTextService.setResetComplete(true);

    this.explanationTextService.lockExplanation();

    this.quizStateService.setDisplayState({
      mode: 'explanation',
      answered: true
    });
  }

  buildExplanationContext(questionIndex: number): string {
    const normalized = Number.isFinite(questionIndex)
      ? Math.max(0, Math.floor(questionIndex))
      : 0;

    return `question:${normalized}`;
  }

  scheduleExplanationVerification(
    displayIndex: number,
    explanationText: string
  ): void {
    requestAnimationFrame(() => {
      let latest: string | null = null;
      try {
        latest = this.explanationTextService.formattedExplanationSig();
      } catch {
        latest = null;
      }

      if (this.pendingExplanationIndex !== displayIndex) return;

      if (latest?.trim() === explanationText.trim()) {
        this.clearPendingExplanation();
        return;
      }

      this.explanationTextService.unlockExplanation();
      this.applyExplanationText(explanationText, displayIndex);
      this.clearPendingExplanation();
    });
  }

  resolveDisplayIndex(
    questionIndex: number,
    getActiveQuestionIndex: () => number,
    currentQuestionIndex: number,
    resolvedQuestionIndex: number | null
  ): number {
    const explicit = Number.isFinite(questionIndex)
      ? Math.max(0, Math.floor(questionIndex))
      : null;

    const resolved =
      explicit ??
      getActiveQuestionIndex() ??
      currentQuestionIndex ??
      resolvedQuestionIndex;
    return Number.isFinite(resolved) ? Math.max(0, Math.floor(resolved!)) : 0;
  }

  clearPendingExplanation(): void {
    this.pendingExplanationIndex = -1;
  }

  /**
   * Resolves a question index for explanation emission using a fallback chain:
   *   1. The provided questionIndex (if finite)
   *   2. The active question index from the component
   *   3. The service-level current question index
   *   4. Emergency fallback: 0
   */
  resolveExplanationQuestionIndex(
    questionIndex: number,
    activeQuestionIndex: number
  ): number {
    if (Number.isFinite(questionIndex)) {
      return Math.max(0, Math.trunc(questionIndex));
    }

    if (Number.isFinite(activeQuestionIndex)) {
      return Math.max(0, Math.trunc(activeQuestionIndex));
    }

    const svcIndex = this.quizService?.getCurrentQuestionIndex?.() ?? this.quizService?.currentQuestionIndex;
    if (typeof svcIndex === 'number' && Number.isFinite(svcIndex)) {
      return Math.max(0, Math.trunc(svcIndex));
    }

    return 0;
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Explanation Text Resolution
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  cacheResolvedFormattedExplanation(index: number, formatted: string): void {
    const text = (formatted ?? '').trim();
    if (!text) return;

    this.explanationTextService.formattedExplanations[index] = {
      questionIndex: index,
      explanation: text
    };
    this.explanationTextService.fetByIndex.set(index, text);
    this.explanationTextService.updateFormattedExplanation(text);
  }

  /**
   * Resolves the formatted explanation text using visual option positions
   * for correct "Option N" labeling (shuffle-safe).
   */
  resolveExplanationText(ctx: ExplanationContext): string {
    const { resolvedIndex: displayIndex, question, optionsToDisplay, currentQuestion, quizId } = ctx;
    // RESOLVE: ctx.optionBindings may be a signal (-clean) or array (-main)
    const _rawOb2 = (ctx as any).optionBindings;
    const optionBindings: any[] = typeof _rawOb2 === 'function' ? (_rawOb2() ?? []) : (_rawOb2 ?? []);
    // Use ctx.question (resolved from display index) over currentQuestion (can be null)
    const effectiveQuestion = question ?? currentQuestion;

    // 1. Determine which options are ACTUALLY displayed right now
    const displayOptions = (Array.isArray(optionBindings) && optionBindings.length > 0)
      ? optionBindings.map(b => b.option)
      : (Array.isArray(optionsToDisplay) && optionsToDisplay.length > 0)
        ? optionsToDisplay : [];

    if (displayOptions.length === 0) {
      return (effectiveQuestion?.explanation || '').trim();
    }

    // 2. Identify the authoritative canonical question
    const allCanonical = this.quizService.quizDataLoader.getCanonicalQuestions(quizId) || [];
    const currentQText = this.normalize(effectiveQuestion?.questionText);

    let authQ = allCanonical.find(q => this.normalize(q.questionText) === currentQText);
    authQ = authQ || (effectiveQuestion as QuizQuestion);

    if (!authQ) return (effectiveQuestion?.explanation || '').trim();

    // 3. Build sets of correct identifiers from the authoritative source
    const correctIds = new Set<number>();
    const correctTexts = new Set<string>();

    if (Array.isArray(authQ.answer)) {
      for (const a of authQ.answer) {
        if (!a) continue;
        const id = Number(a.optionId);
        if (!isNaN(id)) correctIds.add(id);
        const t = this.normalize(a.text);
        if (t) correctTexts.add(t);
      }
    }
    if (correctIds.size === 0 && Array.isArray(authQ.options)) {
      for (const o of authQ.options) {
        if (!o || !o.correct) continue;
        const id = Number(o.optionId);
        if (!isNaN(id)) correctIds.add(id);
        const t = this.normalize(o.text);
        if (t) correctTexts.add(t);
      }
    }

    // 4. Calculate indices based on VISUAL POSITIONS
    const correctIndices = displayOptions
      .map((opt, i) => {
        const id = Number(opt.optionId);
        const text = this.normalize(opt.text);
        const isCorrect = (!isNaN(id) && correctIds.has(id)) ||
          (text && correctTexts.has(text)) ||
          !!opt.correct;

        return isCorrect ? i + 1 : null;
      })
      .filter((n): n is number => n !== null);

    // 5. Format and Emit
    const rawExplanation = (authQ.explanation || '').trim();
    const formatted = this.explanationTextService.formatExplanation(
      { ...authQ, options: displayOptions },
      correctIndices,
      rawExplanation,
      displayIndex
    );

    this.explanationTextService.storeFormattedExplanation(
      displayIndex,
      formatted,
      authQ,
      displayOptions,
      true
    );

    return formatted;
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Utilities
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  private normalize(value: unknown): string {
    return String(value ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\u00A0/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }
}