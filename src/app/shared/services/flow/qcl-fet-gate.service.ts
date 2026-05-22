import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { QuizQuestion } from '../../models/QuizQuestion.model';

import { QuizService } from '../data/quiz.service';
import { ExplanationTextService } from '../features/explanation/explanation-text.service';
import { QuizStateService } from '../state/quizstate.service';
import { QuestionStateResult } from './quiz-content-loader.service';

/**
 * Handles FET gate control, explanation preparation, and explanation state evaluation.
 * Extracted from QuizContentLoaderService.
 */
@Injectable({ providedIn: 'root' })
export class QclFetGateService {

  // ── injects ─────────────────────────────────────────────────────
  private explanationTextService = inject(ExplanationTextService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);

  // ── public methods ──────────────────────────────────────────────
  lockAndPurgeFet(adjustedIndex: number): void {
    const ets = this.explanationTextService;
    try {
      ets._fetLocked = true;
      ets.purgeAndDefer(adjustedIndex);
    } catch (error: any) { }
  }

  resetDisplayExplanationText(currentQuestionIndex: number): void {
    const ets = this.explanationTextService;
    ets.unlockExplanation();
    ets.setExplanationText('', { force: true, index: currentQuestionIndex });
    ets.setShouldDisplayExplanation(false, { force: true });
    ets.setIsExplanationTextDisplayed(false, { force: true });
  }

  unlockFetGateAfterRender(
    adjustedIndex: number,
    getCurrentIndex: () => number,
    detectChanges: () => void
  ): void {
    const ets = this.explanationTextService;
    ets._fetLocked = true;
    ets.setShouldDisplayExplanation(false);
    ets.setIsExplanationTextDisplayed(false);
    ets.latestExplanation = '';

    setTimeout(() => {
      detectChanges();
      requestAnimationFrame(() => {
        setTimeout(() => {
          const stillCurrent =
            ets._gateToken === ets._currentGateToken &&
            adjustedIndex === getCurrentIndex();
          if (!stillCurrent) return;
          ets._fetLocked = false;
        }, 100);
      });
    }, 140);
  }

  prepareExplanationForQuestion(params: {
    qIdx: number;
    questionsArray: QuizQuestion[];
    quiz: any;
    currentQuestionIndex: number;
    currentQuestion: QuizQuestion | null;
  }): { explanationHtml: string; question: QuizQuestion | null } {
    const { qIdx, questionsArray, quiz, currentQuestionIndex, currentQuestion } = params;

    this.explanationTextService._activeIndex = qIdx;
    this.explanationTextService.latestExplanationIndex = qIdx;

    const question =
      questionsArray?.[qIdx] ??
      quiz?.questions?.[qIdx] ??
      (currentQuestionIndex === qIdx ? currentQuestion : null);

    if (!question) {
      const fallback = '<span class="muted">No explanation available</span>';
      this.explanationTextService.setExplanationText(fallback, { index: qIdx });
      this.explanationTextService.setShouldDisplayExplanation(true);
      return { explanationHtml: fallback, question: null };
    }

    const rawExpl = (question.explanation || 'No explanation available').trim();

    let formatted = this.explanationTextService.getFormattedSync(qIdx);
    if (!formatted) {
      const correctIndices = this.explanationTextService.getCorrectOptionIndices(
        question,
        question.options,
        qIdx
      );

      formatted = this.explanationTextService.formatExplanation(question, correctIndices, rawExpl);
      this.explanationTextService.setExplanationTextForQuestionIndex(qIdx, formatted);
    }

    this.explanationTextService.explanationsInitialized = true;

    this.explanationTextService.setExplanationText(formatted, { index: qIdx });
    this.explanationTextService.setShouldDisplayExplanation(true);
    this.quizStateService.setDisplayState({ mode: 'explanation', answered: true });

    return { explanationHtml: formatted, question };
  }

  async evaluateQuestionStateAndExplanation(params: {
    quizId: string;
    questionIndex: number;
  }): Promise<QuestionStateResult> {
    const { quizId, questionIndex } = params;
    const noOp: QuestionStateResult = {
      handled: false,
      explanationText: '',
      showExplanation: false,
      shouldLockExplanation: false,
      shouldDisableExplanation: false
    };

    const questionState = this.quizStateService.getQuestionState(quizId, questionIndex);
    if (!questionState) return noOp;

    if (!questionState.selectedOptions) questionState.selectedOptions = [];

    const hasUserSelected = (questionState.selectedOptions?.length ?? 0) > 0;
    if (!hasUserSelected) return noOp;

    const isAnswered = questionState.isAnswered;
    const explanationAlreadyDisplayed = questionState.explanationDisplayed;
    const shouldDisableExplanation = !isAnswered && !explanationAlreadyDisplayed;

    if (isAnswered || explanationAlreadyDisplayed) {
      let explanationText = '';

      if (Number.isFinite(questionIndex) && this.explanationTextService.explanationsInitialized) {
        const explanation$ = this.explanationTextService.getFormattedExplanationTextForQuestion(questionIndex);
        explanationText = (await firstValueFrom(explanation$)) ?? '';

        if (!explanationText?.trim()) {
          explanationText = 'No explanation available';
        }
      } else {
        explanationText = 'No explanation available';
      }

      this.explanationTextService.setExplanationText(explanationText, { index: questionIndex });
      this.explanationTextService.setResetComplete(true);
      this.explanationTextService.setShouldDisplayExplanation(true);
      this.explanationTextService.lockExplanation();

      return {
        handled: true,
        explanationText,
        showExplanation: true,
        shouldLockExplanation: true,
        shouldDisableExplanation: false
      };
    } else if (shouldDisableExplanation) {
      if (!this.explanationTextService.isExplanationLocked()) {
        this.explanationTextService.setResetComplete(false);
        this.explanationTextService.setExplanationText('', { index: questionIndex });
        this.explanationTextService.setShouldDisplayExplanation(false);
      }

      return {
        handled: true,
        explanationText: '',
        showExplanation: false,
        shouldLockExplanation: false,
        shouldDisableExplanation: true
      };
    }

    return noOp;
  }

  resetFetStateForInit(): void {
    try {
      const ets = this.explanationTextService;
      ets._activeIndex = -1;
      ets._fetLocked = true;
      ets.latestExplanation = '';
      ets.setShouldDisplayExplanation(false);
      ets.setIsExplanationTextDisplayed(false);
      ets.formattedExplanationSig.set('');
      requestAnimationFrame(() => ets.emitFormatted(-1, null));
    } catch (error) {
    }
  }

  seedFirstQuestionText(): void {
    try {
      const firstQuestion = this.quizService.questions?.[0];
      if (firstQuestion) {
        const trimmed = (firstQuestion.questionText ?? '').trim();
        if (trimmed.length > 0) {
          setTimeout(() => {
            this.explanationTextService._fetLocked = false;
          }, 80);
        }
      }
      this.explanationTextService.setShouldDisplayExplanation(false);
      this.explanationTextService.setIsExplanationTextDisplayed(false);
    } catch (error: any) {
    }
  }

  resolveExplanationChange(
    explanation: string | any,
    index: number | undefined,
    currentExplanation: string
  ): { text: string; index: number | undefined } | null {
    let finalExplanation: string;
    let finalIndex = index;

    if (explanation && typeof explanation === 'object' && 'payload' in explanation) {
      finalExplanation = explanation.payload;
      finalIndex = ('index' in explanation) ? explanation.index : index;
    } else {
      finalExplanation = explanation;
    }

    if (!finalExplanation) return null;

    const currentHasPrefix = currentExplanation?.toLowerCase().includes('correct because');
    const incomingHasPrefix = finalExplanation.toLowerCase().includes('correct because');
    if (currentHasPrefix && !incomingHasPrefix) return null;

    return { text: finalExplanation, index: finalIndex };
  }
}