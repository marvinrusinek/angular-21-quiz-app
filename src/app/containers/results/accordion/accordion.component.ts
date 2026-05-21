import {
  ChangeDetectionStrategy, Component, DestroyRef, effect,
  inject, input, OnInit, signal
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { CommonModule } from '@angular/common';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';

import { Option } from '../../../shared/models/Option.model';
import { QuizQuestion } from '../../../shared/models/QuizQuestion.model';
import { Result } from '../../../shared/models/Result.model';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { TimerService } from '../../../shared/services/features/timer/timer.service';
import { SelectedOptionService } from '../../../shared/services/state/selectedoption.service';
import { ExplanationTextService } from '../../../shared/services/features/explanation/explanation-text.service';

@Component({
  selector: 'codelab-results-accordion',
  standalone: true,
  imports: [CommonModule, MatExpansionModule, MatIconModule],
  templateUrl: './accordion.component.html',
  styleUrls: ['./accordion.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AccordionComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly quizDataService = inject(QuizDataService);
  private readonly quizService = inject(QuizService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly timerService = inject(TimerService);
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  // ── inputs ──────────────────────────────────────────────────────
  readonly questionsInput = input<QuizQuestion[]>([], { alias: 'questions' });
  readonly isShuffled = input(false);
  readonly accordionHeaderLabel = input('', { alias: "headerLabel" });

  // ── remaining variables ─────────────────────────────────────────
  readonly questions = signal<QuizQuestion[]>([]);

  results: Result = {
    userAnswers: [],
    elapsedTimes: []
  };

  private hasRetried = false;

  constructor() {
    effect(() => {
      const incoming = this.questionsInput();
      if (Array.isArray(incoming) && incoming.length > 0) {
        this.questions.set(incoming);
      }
    });

    effect(() => {
      const questions = this.quizService.questionsSig();
      this.questions.set(questions);

      if (questions.length === 0 && !this.hasRetried) {
        this.hasRetried = true;
        this.retryLoadQuestionsViaDataService();
      }
    });
  }

  ngOnInit(): void {
    const userAnswersData = this.recoverUserAnswers();
    this.initializeResults(userAnswersData);
    this.loadInitialQuestionsFromService();
    this.normalizeUserAnswers();
  }

  checkIfAnswersAreCorrect(
    question: QuizQuestion,
    userAnswers: any[],
    index: number
  ): boolean {
    const userIds = userAnswers[index];
    if (!userIds || (Array.isArray(userIds) && userIds.length === 0)) return false;

    // Convert IDs to visual indices for comparison
    const userIndices = this.getUserAnswerIndices(question, userIds);
    const correctIndices = this.getCorrectOptionIndices(question, index);

    if (userIndices.length !== correctIndices.length) return false;

    // Check if every user index is in correct indices
    return userIndices.every((ui) => correctIndices.includes(ui));
  }

  getUserAnswerIndices(question: QuizQuestion, userIds: number | number[]): number[] {
    if (!question || !question.options || !userIds) return [];

    const ids = Array.isArray(userIds) ? userIds : [userIds];

    return ids
      .map((id: number) => {
        // Try matching by optionId first
        let idx = question.options.findIndex((opt: Option) =>
          opt.optionId != null && String(opt.optionId) === String(id)
        );

        // Fallback: treat id as a 0-based display index (used when options lack optionId)
        if (idx === -1 && id >= 0 && id < question.options.length) idx = id;

        return idx >= 0 ? idx + 1 : -1;
      })
      .filter((idx: number) => idx !== -1)
      .sort((a, b) => a - b);
  }

  getCorrectOptionIndices(question: QuizQuestion, index?: number): number[] {
    return this.explanationTextService.getCorrectOptionIndices(question, undefined, index);
  }

  formatOptionList(indices: number[]): string {
    if (!indices || indices.length === 0) return '';
    if (indices.length === 1) return `Option ${indices[0]}`;
    if (indices.length === 2) return `Options ${indices[0]} and ${indices[1]}`;
    const last = indices[indices.length - 1];
    const rest = indices.slice(0, -1).join(', ');
    return `Options ${rest}, and ${last}`;
  }

  // Get selected options directly from SelectedOptionService for a given question index
  // Returns visual 1-based indices (Option 1, Option 2, etc.) in SELECTION ORDER (not sorted)
  getSelectedOptionsForQuestion(questionIndex: number): { text: string; visualIndex: number }[] {
    const question = this.questions()[questionIndex];
    if (!question || !question.options) return [];

    const matchOption = (sel: any): number => {
      // Match by optionId (when both sides have it)
      let idx = question.options.findIndex((opt: Option) =>
        opt.optionId != null && sel.optionId != null && sel.optionId !== -1 &&
        String(opt.optionId) === String(sel.optionId)
      );
      // Match by text
      if (idx === -1 && sel.text) {
        idx = question.options.findIndex((opt: Option) => opt.text === sel.text);
      }
      // Fallback: treat optionId as display index (when options lack optionId)
      if (idx === -1 && typeof sel.optionId === 'number' && sel.optionId >= 0 && sel.optionId < question.options.length) {
        idx = sel.optionId;
      }
      return idx;
    };

    // Try rawSelectionsMap first (more reliable)
    const rawSelections = this.selectedOptionService.rawSelectionsMap.get(questionIndex);
    if (rawSelections && rawSelections.length > 0) {
      return rawSelections.map((sel: any) => {
        const visualIdx = matchOption(sel);
        return {
          text: sel.text || (visualIdx >= 0 ? question.options[visualIdx]?.text : '') || `Option ${visualIdx + 1}`,
          visualIndex: visualIdx >= 0 ? visualIdx + 1 : 0
        };
      }).filter((o: any) => o.visualIndex > 0);
    }

    // Fallback to selectedOptionsMap
    const selections = this.selectedOptionService.selectedOptionsMap.get(questionIndex);
    if (!selections || selections.length === 0) return [];

    return selections.map((sel: any) => {
      const visualIdx = matchOption(sel);
      return {
        text: sel.text || (visualIdx >= 0 ? question.options[visualIdx]?.text : '') || `Option ${visualIdx + 1}`,
        visualIndex: visualIdx >= 0 ? visualIdx + 1 : 0
      };
    }).filter((o: any) => o.visualIndex > 0);
  }

  // Check if we have any selections from the service for this question
  hasSelectionsFromService(questionIndex: number): boolean {
    const rawSelections =
      this.selectedOptionService.rawSelectionsMap.get(questionIndex);
    if (rawSelections && rawSelections.length > 0) return true;

    const selections =
      this.selectedOptionService.selectedOptionsMap.get(questionIndex);
    return !!selections && selections.length > 0;
  }

  // Check if user selections match correct answers for a question (using service data)
  // Returns true if ALL correct answers are INCLUDED in the user's selections
  checkIfAnswersAreCorrectFromService(
    question: QuizQuestion,
    questionIndex: number
  ): boolean {
    if (!question || !question.options) return false;

    // Get correct option texts
    const correctTexts = question.options
      .filter(opt => opt.correct)
      .map(opt => (opt.text || '').trim().toLowerCase());

    // Get selected option texts
    const selectedOpts = this.getSelectedOptionsForQuestion(questionIndex);
    const selectedTexts = selectedOpts
      .map(o => (o.text || '').trim().toLowerCase());

    // Check if ALL correct answers are included in selections
    return correctTexts.every(ct => selectedTexts.includes(ct));
  }

  // Recover selections from durable localStorage store. clearState/resetAll
  // wipes rawSelectionsMap AND sessionStorage, but the durable
  // 'quizAnswersForResults' key in localStorage survives. Falls back to the
  // service's userAnswers if localStorage is empty.
  private recoverUserAnswers(): any[] {
    this.selectedOptionService.recoverAnswersForResults();

    let storedAnswers: any[] = [];
    try {
      const stored = localStorage.getItem('userAnswers');
      storedAnswers = stored ? JSON.parse(stored) : [];
    } catch (error: any) {
      // error handled silently
    }

    return storedAnswers.length > 0 ? storedAnswers : this.quizService.userAnswers;
  }

  private initializeResults(userAnswersData: any[]): void {
    this.results = {
      userAnswers: userAnswersData,
      elapsedTimes: this.timerService.elapsedTimes
    };
  }

  // For navigation-back scenarios — populate from service state synchronously
  // so the accordion renders without waiting for the questions$ stream.
  private loadInitialQuestionsFromService(): void {
    const currentQuestions = this.quizService.questions;
    if (currentQuestions && currentQuestions.length > 0) {
      this.questions.set(currentQuestions);
    }
  }

  // Fallback path when questions$ emits empty: resolve quizId from route or
  // service, then fetch directly from QuizDataService (bypasses shuffling /
  // state complexity).
  private retryLoadQuestionsViaDataService(): void {
    // Use a small timeout to let other initializations settle
    setTimeout(() => {
      const id = this.resolveQuizId();
      if (!id) return;

      this.quizDataService.getQuestionsForQuiz(id)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((qs: QuizQuestion[]) => {
          if (qs && qs.length > 0) {
            this.questions.set(qs);
          }
        });
    }, 100);
  }

  // Priority: URL params > service state. Syncs the service if the URL had
  // a different id so downstream consumers see consistent state.
  private resolveQuizId(): string | null {
    let id = this.activatedRoute.snapshot.paramMap.get('quizId') ||
      this.activatedRoute.parent?.snapshot.paramMap.get('quizId') ||
      null;

    if (!id) {
      id = this.quizService.quizId;
    } else if (this.quizService.quizId !== id) {
      this.quizService.setQuizId(id);
    }

    return id;
  }

  // Coerce userAnswers entries into arrays so Angular's template can iterate
  // them uniformly (raw values come back as either scalar or array).
  private normalizeUserAnswers(): void {
    if (!this.results?.userAnswers) return;
    this.results.userAnswers = this.results.userAnswers.map((ans) =>
      Array.isArray(ans) ? ans : (ans !== null && ans !== undefined ? [ans] : [])
    );
  }
}
