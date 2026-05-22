import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { FormattedExplanation } from '../../../models/FormattedExplanation.model';
import { QuestionState } from '../../../models/QuestionState.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { ExplanationTextService } from '../explanation/explanation-text.service';

/**
 * Manages explanation text resolution, formatting, and caching for QQC.
 * Extracted from QuizQuestionComponent to reduce its size.
 */
@Injectable({ providedIn: 'root' })
export class QqcExplanationManagerService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly quizService = inject(QuizService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);

  /**
   * Fetches explanation text for a question index.
   * Returns fallback strings on error or missing data.
   */
  async getExplanationText(questionIndex: number): Promise<string> {
    try {
      if (!this.explanationTextService.explanationsInitialized) {
        return 'No explanation available for this question.';
      }

      const explanation$ =
        this.explanationTextService.getFormattedExplanationTextForQuestion(
          questionIndex
        );
      const explanationText = await firstValueFrom(explanation$);

      const trimmed = explanationText?.trim();
      if (!trimmed) return 'No explanation available for this question.';

      return trimmed;
    } catch (error) {
      return 'Error loading explanation.';
    }
  }

  /**
   * Processes explanation text for a question: formats and returns a FormattedExplanation.
   */
  async processExplanationText(
    questionData: QuizQuestion,
    questionIndex: number
  ): Promise<FormattedExplanation | null> {
    if (!questionData) {
      return {
        questionIndex,
        explanation: 'No question data available'
      };
    }

    const explanation = questionData.explanation || 'No explanation available';
    this.explanationTextService.setCurrentQuestionExplanation(explanation);

    try {
      const formattedExplanation = await this.getFormattedExplanation(
        questionData,
        questionIndex
      );

      if (formattedExplanation) {
        const explanationText =
          typeof formattedExplanation === 'string'
            ? formattedExplanation
            : formattedExplanation.explanation || '';

        return {
          questionIndex,
          explanation: explanationText
        };
      } else {
        return {
          questionIndex,
          explanation: questionData.explanation || 'No explanation available'
        };
      }
    } catch (error) {
      return {
        questionIndex,
        explanation: questionData.explanation || 'Error processing explanation'
      };
    }
  }

  /**
   * Gets a formatted explanation from the explanation text service.
   */
  async getFormattedExplanation(
    questionData: QuizQuestion,
    questionIndex: number
  ): Promise<{ questionIndex: number; explanation: string }> {
    const formattedExplanationObservable =
      this.explanationTextService.formatExplanationText(
        questionData,
        questionIndex
      );
    return firstValueFrom(formattedExplanationObservable);
  }

  /**
   * Normalizes a question index to a valid 0-based index within the questions array.
   * Handles NaN, negative, 1-based overflow, and out-of-range values.
   *
   * Extracted from QuizQuestionComponent.normalizeIndex().
   */
  normalizeIndex(idx: number, questions: QuizQuestion[]): number {
    if (!Number.isFinite(idx)) return 0;

    const normalized = Math.trunc(idx);

    if (!questions || questions.length === 0) return normalized >= 0 ? normalized : 0;
    if (questions[normalized] != null) return normalized;

    const potentialOneBased = normalized - 1;
    const looksOneBased =
      normalized === potentialOneBased + 1 &&
      potentialOneBased >= 0 &&
      potentialOneBased < questions.length &&
      questions[potentialOneBased] != null;

    if (looksOneBased) return potentialOneBased;

    return Math.min(Math.max(normalized, 0), questions.length - 1);
  }

  /**
   * Captures the current explanation display state for a question.
   * Returns a snapshot that can be used to restore state after a reset.
   */
  captureExplanationSnapshot(params: {
    preserveVisualState: boolean;
    index: number;
    explanationToDisplay: string;
    quizId: string | null | undefined;
    isAnswered: boolean;
    displayMode: string;
    shouldDisplayExplanation: boolean;
    explanationVisible: boolean;
    displayExplanation: boolean;
    displayStateAnswered: boolean;
  }): {
    shouldRestore: boolean;
    explanationText: string;
    questionState?: QuestionState;
  } {
    if (!params.preserveVisualState) {
      return { shouldRestore: false, explanationText: '' };
    }

    const rawExplanation = (params.explanationToDisplay ?? '').trim();
    const latestExplanation = (this.explanationTextService.getLatestExplanation() ?? '')
      .toString()
      .trim();
    const explanationText = rawExplanation || latestExplanation;

    if (!explanationText) {
      return { shouldRestore: false, explanationText: '' };
    }

    const activeQuizId =
      [params.quizId, this.quizService.getCurrentQuizId(), this.quizService.quizId]
        .find((id) => typeof id === 'string' && id.trim().length > 0) ?? null;

    const questionState = activeQuizId
      ? this.quizStateService.getQuestionState(activeQuizId, params.index)
      : undefined;

    const answered = Boolean(
      questionState?.isAnswered ||
      this.selectedOptionService.isAnsweredSig() ||
      params.isAnswered ||
      params.displayStateAnswered
    );

    const explanationVisibleCheck = Boolean(
      params.displayMode === 'explanation' ||
      params.shouldDisplayExplanation ||
      params.explanationVisible ||
      params.displayExplanation ||
      this.explanationTextService.shouldDisplayExplanationSig() ||
      questionState?.explanationDisplayed
    );

    return {
      shouldRestore:
        params.preserveVisualState &&
        answered &&
        explanationVisibleCheck &&
        explanationText.length > 0,
      explanationText,
      questionState
    };
  }
}