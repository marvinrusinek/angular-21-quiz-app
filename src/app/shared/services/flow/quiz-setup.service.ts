import { Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { filter } from 'rxjs/operators';

import { QuestionPayload } from '../../models/QuestionPayload.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { QuizService } from '../data/quiz.service';
import { QuizDataService } from '../data/quizdata.service';
import { ExplanationTextService } from '../features/explanation/explanation-text.service';
import { SelectionMessageService } from '../features/selection-message/selection-message.service';
import { TimerService } from '../features/timer/timer.service';
import { NextButtonStateService } from '../state/next-button-state.service';
import { QuizPersistenceService } from '../state/quiz-persistence.service';
import { QuizStateService } from '../state/quizstate.service';
import { SelectedOptionService } from '../state/selectedoption.service';
import { SharedVisibilityService } from '../ui/shared-visibility.service';
import { QuizContentLoaderService } from './quiz-content-loader.service';
import { QuizDotStatusService } from './quiz-dot-status.service';
import { QuizNavigationService } from './quiz-navigation.service';
import { QuizOptionProcessingService } from './quiz-option-processing.service';
import { QuizResetService } from './quiz-reset.service';
import { QuizSetupDataService } from './quiz-setup-data.service';
import { QuizSetupRouteService } from './quiz-setup-route.service';
import { QuizVisibilityRestoreService } from './quiz-visibility-restore.service';

import type { QuizComponent } from '../../../containers/quiz/quiz.component';

type Host = QuizComponent;

/**
 * Hosts orchestration / route / lifecycle logic extracted from QuizComponent.
 * Delegates to 2 extracted sub-services; retains lifecycle + option/explanation handlers inline.
 */
@Injectable({ providedIn: 'root' })
export class QuizSetupService {
  // ── injects ─────────────────────────────────────────────────────
  private dataService = inject(QuizSetupDataService);
  private dotStatusService = inject(QuizDotStatusService);
  private explanationTextService = inject(ExplanationTextService);
  private nextButtonStateService = inject(NextButtonStateService);
  private quizContentLoaderService = inject(QuizContentLoaderService);
  private quizDataService = inject(QuizDataService);
  private quizNavigationService = inject(QuizNavigationService);
  private quizOptionProcessingService = inject(QuizOptionProcessingService);
  private quizPersistence = inject(QuizPersistenceService);
  private quizResetService = inject(QuizResetService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private quizVisibilityRestoreService = inject(QuizVisibilityRestoreService);
  private router = inject(Router);
  private routeService = inject(QuizSetupRouteService);
  private selectedOptionService = inject(SelectedOptionService);
  private selectionMessageService = inject(SelectionMessageService);
  private sharedVisibilityService = inject(SharedVisibilityService);
  private timerService = inject(TimerService);

  // ── public methods ──────────────────────────────────────────────

  // â”€â”€â”€ Route (delegated) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  subscribeToRouteEvents(host: Host): void {
    this.routeService.subscribeToRouteEvents(
      host,
      (h: Host) => this.dataService.loadQuestions(h)
    );
  }

  fetchTotalQuestions(host: Host): void {
    this.routeService.fetchTotalQuestions(host);
  }

  subscribeToQuestionIndex(host: Host): void {
    this.routeService.subscribeToQuestionIndex(host);
  }

  subscribeToRouteParams(host: Host): void {
    this.routeService.subscribeToRouteParams(host);
  }

  fetchRouteParams(host: Host): void {
    // Original fetchRouteParams called this.loadQuizData(host) at the end.
    // The route sub-service sets host._pendingLoadQuizData instead;
    // we wire the actual call here.
    host.activatedRoute.params
      .pipe(takeUntilDestroyed(host.destroyRef))
      .subscribe((params: any) => {
        host.quizId.set(params['quizId'] ?? '');
        host.questionIndex.set(+params['questionIndex']);
        host.currentQuestionIndex.set(host.questionIndex() - 1);
        void this.dataService.loadQuizData(host);
      });
  }

  subscribeRouterAndInit(host: Host): void {
    this.routeService.subscribeRouterAndInit(host);
  }

  setupNavigation(host: Host): void {
    this.routeService.setupNavigation(host);
  }

  async updateContentBasedOnIndex(host: Host, index: number): Promise<void> {
    return this.routeService.updateContentBasedOnIndex(host, index);
  }

  async loadQuestionByRouteIndex(host: Host, routeIndex: number): Promise<void> {
    return this.routeService.loadQuestionByRouteIndex(host, routeIndex);
  }

  // â”€â”€â”€ Data (delegated) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async loadQuestions(host: Host): Promise<void> {
    return this.dataService.loadQuestions(host);
  }

  async loadQuizData(host: Host): Promise<boolean> {
    return this.dataService.loadQuizData(host);
  }

  loadCurrentQuestion(host: Host): void {
    this.dataService.loadCurrentQuestion(host);
  }

  refreshQuestionOnReset(host: Host): void {
    this.dataService.refreshQuestionOnReset(host);
  }

  async getQuestion(host: Host): Promise<void | null> {
    return this.dataService.getQuestion(host);
  }

  applyQuestionsFromSession(host: Host, questions: QuizQuestion[]): void {
    this.dataService.applyQuestionsFromSession(host, questions);
  }

  resolveQuizData(host: Host): void {
    this.dataService.resolveQuizData(host);
  }

  initializeQuizFromRoute(host: Host): void {
    // Original initializeQuizFromRoute called this.setupNavigation(host) in subscribe.
    // The data sub-service sets host._pendingSetupNavigation instead;
    // we wire the actual call here via a wrapper.
    host.activatedRoute.data
      .pipe(
        takeUntilDestroyed(host.destroyRef),
        filter((data: any) => {
          if (!data.quizData) {
            void this.router.navigate(['/select']);
            return false;
          }
          host.quiz.set(data.quizData);
          this.quizContentLoaderService.resetFetStateForInit();
          return true;
        })
      )
      .subscribe(() => {
        this.setupNavigation(host);
        // Seed the question text against the question the URL is targeting,
        // not always questions[0]. Direct navigation to /question/.../3
        // would otherwise display Q1's text until a downstream emission
        // overrides it â€” visible to the user as a "Q1 then Q3" flash, or
        // worse, as Q1 stuck if the override never lands.
        const currentIdx = host.currentQuestionIndex();
        const seedIdx = Number.isFinite(currentIdx) && currentIdx >= 0
          ? currentIdx : 0;
        const trimmed = (this.quizService.questions?.[seedIdx]?.questionText ?? '').trim();
        if (trimmed) host.questionToDisplaySig.set(trimmed);
        this.quizContentLoaderService.seedFirstQuestionText();
        host.cdRef.markForCheck();
      });
  }

  initializeQuestionStreams(host: Host): void {
    this.dataService.initializeQuestionStreams(host);
  }

  loadQuizQuestionsForCurrentQuiz(host: Host): void {
    this.dataService.loadQuizQuestionsForCurrentQuiz(host);
  }

  createQuestionData(host: Host): void {
    this.dataService.createQuestionData(host);
  }

  async handleNavigationToQuestion(host: Host, questionIndex: number): Promise<void> {
    return this.dataService.handleNavigationToQuestion(host, questionIndex);
  }

  async updateQuestionStateAndExplanation(host: Host, questionIndex: number): Promise<void> {
    return this.dataService.updateQuestionStateAndExplanation(host, questionIndex);
  }

  selectedAnswer(host: Host, optionIndex: number): void {
    this.dataService.selectedAnswer(host, optionIndex);
  }

  // â”€â”€â”€ Remaining inline: lifecycle + option/explanation handlers â”€â”€â”€

  // â”€â”€ Constructor wiring (subscriptions + observables) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  wireConstructor(host: Host): void {
    const qqc = host.quizQuestionComponent?.();
    if (qqc) qqc.renderReady.set(false);

    this.sharedVisibilityService.pageVisibility$.subscribe((isHidden: boolean) => {
      const needsRender = this.quizVisibilityRestoreService.handleVisibilityChange(isHidden, {
        currentQuestion: host.currentQuestion(),
        optionsToDisplay: host.optionsToDisplaySig(),
        explanationToDisplay: host.explanationToDisplay(),
        combinedQuestionData: host.combinedQuestionData,
        optionsToDisplaySig: host.optionsToDisplaySig
      });
      if (needsRender) {
        host.cdRef.markForCheck();
      }

      // When tab becomes visible, restore selection message for current question
      if (!isHidden) {
        const idx = host.currentQuestionIndex();
        const isAnswered = this.selectedOptionService.isQuestionAnswered(idx);
        if (!isAnswered) this.selectionMessageService.forceBaseline(idx);
        const question = this.quizService.questions?.[idx]
          ?? host.questionsArray()?.[idx] ?? null;
        if (question) {
          const displayHTML = this.routeService.buildQuestionDisplayHTML(question);
          if (displayHTML) {
            const writeH3 = () => {
              try {
                const h3 = document.querySelector('codelab-quiz-content h3');
                if (h3 && !h3.innerHTML.trim()) {
                  h3.innerHTML = displayHTML;
                }
              } catch {}
            };
            setTimeout(writeH3, 50);
            setTimeout(writeH3, 200);
            setTimeout(writeH3, 500);
            setTimeout(writeH3, 1000);
          }
        }
      }
    });

    host.subscriptions.add(
      this.quizService.quizReset$.subscribe(() => this.dataService.refreshQuestionOnReset(host))
    );

    host.subscriptions.add(
      this.quizService.questions$.subscribe((questions: QuizQuestion[]) => {
        const serviceQuizId = this.quizService.getCurrentQuizId();
        if (questions?.length && (!host.quizId() || serviceQuizId === host.quizId())) {
          const shuffled = this.quizService.shuffledQuestions;
          const effectiveQuestions =
            this.quizService.isShuffleEnabled() && shuffled?.length > 0
              ? shuffled : questions;
          host.questions.set(effectiveQuestions);
          host.questionsArray.set([...effectiveQuestions]);
          host.totalQuestions.set(effectiveQuestions.length);
          host.cdRef.markForCheck();
        }
      })
    );

    this.selectedOptionService.selectedOption$.subscribe((selections: any[]) => {
      const qIndex = selections?.[0]?.questionIndex ?? host.currentQuestionIndex();
      if (selections && selections.length > 0) host.markQuestionAnswered(qIndex);
      host.updateDotStatus(qIndex);
      host.cdRef.detectChanges();
    });

    this.quizService.currentQuestion$.subscribe({
      next: (newQuestion: QuizQuestion | null) => {
        if (!newQuestion) return;
        host.currentQuestion.set(null);
        setTimeout(() => { host.currentQuestion.set({ ...newQuestion }); }, 10);
      },
      error: () => { }
    });
  }

  // â”€â”€ onOptionSelected â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async onOptionSelected(host: Host, option: any, isUserAction: boolean = true): Promise<void> {
    if (!isUserAction) return;
    const id = option?.optionId ?? option?.id ?? option?.displayOrder ?? -1;
    const now = Date.now();
    if (id !== -1 && id === (host._lastOptionId ?? -1) && (now - (host._lastClickTime ?? 0)) < 200) return;
    host._lastClickTime = now;
    host._lastOptionId = id;

    host._processingOptionClick = true;
    const idx = host.normalizeQuestionIndex(option?.questionIndex);

    const _isShuf = (this.quizService as any)?.isShuffleEnabled?.()
      && (this.quizService as any)?.shuffledQuestions?.length > 0;
    const authQ = _isShuf
      ? ((this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[idx]
        ?? (this.quizService as any)?.shuffledQuestions?.[idx]
        ?? host.currentQuestion())
      : (this.quizService.questions?.[idx] ?? host.currentQuestion());
    const correctCount = (authQ?.options ?? []).filter(
      (o: any) => o?.correct === true || o?.correct === 1 || String(o?.correct) === 'true'
    ).length;
    const isMultiAnswer = correctCount > 1 || this.quizService.multipleAnswer;

    let clickedIsCorrectForFET = false;
    if (!isMultiAnswer) {
      try {
        const nrmF = (t: any) => String(t ?? '').trim().toLowerCase();
        const clickedText = nrmF(option?.text);
        const qTextF = nrmF(authQ?.questionText);
        if (clickedText && qTextF) {
          const bundleF: any[] = (this.quizService as any)?.quizInitialState ?? [];
          for (const quiz of bundleF) {
            let found = false;
            for (const pq of (quiz?.questions ?? [])) {
              if (nrmF(pq?.questionText) !== qTextF) continue;
              const mo = (pq?.options ?? []).find((o: any) => nrmF(o?.text) === clickedText);
              if (mo) {
                clickedIsCorrectForFET = mo?.correct === true || String(mo?.correct) === 'true';
              }
              found = true;
              break;
            }
            if (found) break;
          }
        }
      } catch { /* ignore */ }
    }
    if (!isMultiAnswer && clickedIsCorrectForFET) {
      this.showExplanationForQuestion(host, idx);
    }

    await this.quizOptionProcessingService.processOptionClick({
      option, idx, quizId: host.quizId(),
      currentQuestionIndex: host.currentQuestionIndex(),
      questionsArray: host.questionsArray(),
      currentQuestion: host.currentQuestion(),
      optionsToDisplay: host.optionsToDisplaySig(),
      liveSelections: host.getSelectionsForQuestion(idx),
      explanationToDisplay: host.explanationToDisplay()
    });

    // Always mark progress against the authoritative current-question
    // index from quizService â€” host.currentQuestionIndex and the derived
    // `idx` from option.questionIndex can both be stale on Q2+, leaving
    // markQuestionAnswered called with 0 on every question (already in
    // the set, early-returns, progress freezes).
    const liveQIdx = (this.quizService as any)?.currentQuestionIndex;
    const hostIdx = host.currentQuestionIndex();
    const progressIdx = Number.isFinite(liveQIdx)
      ? liveQIdx
      : (Number.isFinite(hostIdx) ? hostIdx : idx);
    host.markQuestionAnswered(progressIdx);
    host.updateDotStatus(idx);

    const confirmed = this.selectedOptionService.clickConfirmedDotStatus.get(idx);
    const dotStatus = confirmed || this.dotStatusService.dotStatusCache.get(idx);
    if (dotStatus === 'correct' || dotStatus === 'wrong') {
      this.quizPersistence.setPersistedDotStatus(host.quizId(), idx, dotStatus);
    }

    host.cdRef.detectChanges();
    host._processingOptionClick = false;

    setTimeout(() => {
      this.nextButtonStateService.evaluateNextButtonState(
        this.selectedOptionService.isAnsweredSig(),
        this.quizStateService.isLoadingSig(),
        this.quizStateService.isNavigatingSig()
      );
      host.updateDotStatus(idx);
      const delayedDotStatus = this.dotStatusService.dotStatusCache.get(idx);
      if (delayedDotStatus === 'correct' || delayedDotStatus === 'wrong') {
        this.quizPersistence.setPersistedDotStatus(host.quizId(), idx, delayedDotStatus);
      }
      host.cdRef.detectChanges();
    }, 150);
  }

  // â”€â”€ advanceQuestion / restartQuiz â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async advanceQuestion(host: Host, direction: 'next' | 'previous'): Promise<void> {
    const leavingIdx = host.currentQuestionIndex();
    this.quizContentLoaderService.snapshotLeavingQuestion({
      leavingIdx,
      leavingDotClass: host.getDotClass(leavingIdx),
      quizId: host.quizId(),
      getScoringKey: (idx: number) => this.dotStatusService.getScoringKey(host.quizId(), idx),
    });
    const leavingDotClass = host.getDotClass(leavingIdx);
    if (leavingDotClass.includes('correct')) this.quizPersistence.setPersistedDotStatus(host.quizId(), leavingIdx, 'correct');
    else if (leavingDotClass.includes('wrong')) this.quizPersistence.setPersistedDotStatus(host.quizId(), leavingIdx, 'wrong');
    host.animationStateSig.set('animationStarted');
    this.selectedOptionService.setAnswered(false);
    this.quizStateService.resetInteraction();
    if (direction === 'next') {
      const destIndex = host.currentQuestionIndex() + 1;
      if (destIndex < host.totalQuestions()) {
        this.dotStatusService.clearForIndex(destIndex);
        this.selectedOptionService.lastClickedCorrectByQuestion.delete(destIndex);
        this.selectedOptionService.clickConfirmedDotStatus.delete(destIndex);
        this.quizPersistence.clearPersistedDotStatus(host.quizId(), destIndex);
        try { sessionStorage.removeItem('dot_confirmed_' + destIndex); } catch {}
      }
    }
    if (direction === 'next') {
      const destIdx = host.currentQuestionIndex() + 1;
      this.selectionMessageService.setOptionsSnapshot([]);
      this.selectionMessageService._singleAnswerCorrectLock.delete(destIdx);
      this.selectionMessageService._singleAnswerIncorrectLock.delete(destIdx);
      this.selectionMessageService.forceBaseline(destIdx);
      await this.quizNavigationService.advanceToNextQuestion();
      if (!this.selectedOptionService.isQuestionAnswered(destIdx)) {
        this.selectionMessageService.forceBaseline(destIdx);
        setTimeout(() => {
          if (!this.selectedOptionService.isQuestionAnswered(destIdx)) {
            this.selectionMessageService.forceBaseline(destIdx);
          }
        }, 100);
      }
    } else {
      await this.quizNavigationService.advanceToPreviousQuestion();
    }
    host.cdRef.markForCheck();
  }

  restartQuiz(host: Host): void {
    const totalQs = host.totalQuestions();
    this.quizResetService.performRestartServiceResets(host.quizId(), totalQs);
    this.dotStatusService.clearAllMaps();
    host.quizQuestionComponent?.()?.selectedIndices?.clear();
    this.timerService.stopTimer?.(undefined, { force: true });
    host.answeredQuestionIndices.clear();
    host.progressSig.set(0);
    this.quizPersistence.clearClickConfirmedDotStatus(totalQs);

    try {
      for (let i = 0; i < totalQs; i++) {
        sessionStorage.removeItem('sel_Q' + i);
      }
      sessionStorage.removeItem('answeredQuestionIndices');
      sessionStorage.removeItem('quizProgress');
      sessionStorage.removeItem('quizProgressQuizId');
    } catch {}
    try {
      this.quizStateService._hasUserInteracted?.clear?.();
      this.quizStateService._answeredQuestionIndices?.clear?.();
      (this.quizStateService as any)._clickedInSession?.clear?.();
      (this.quizStateService as any).persistInteractionState?.();
    } catch {}

    this.router.navigate(['/quiz/question', host.quizId(), 1])
      .then(() => {
        host.currentQuestionIndex.set(0);
        this.quizResetService.applyPostRestartState(host.totalQuestions(), () => {
          host.sharedOptionComponent?.()?.generateOptionBindings();
          host.cdRef.detectChanges();
        });

        const question = this.quizService.questions?.[0]
          ?? host.questionsArray()?.[0]
          ?? null;
        if (question) {
          const displayHTML = this.routeService.buildQuestionDisplayHTML(question);
          if (displayHTML) {
            const writeH3 = () => {
              try {
                const h3 = document.querySelector('codelab-quiz-content h3');
                if (h3 && !h3.innerHTML.trim()) {
                  h3.innerHTML = displayHTML;
                }
              } catch {}
            };
            setTimeout(writeH3, 50);
            setTimeout(writeH3, 200);
            setTimeout(writeH3, 500);
          }
        }
      })
      .catch(() => { });
  }

subscribeToTimerExpiry(host: Host): void {
    this.timerService.expired$
      .pipe(takeUntilDestroyed(host.destroyRef))
      .subscribe(() => {
        const idx = host.currentQuestionIndex();
        const selections = host.getSelectionsForQuestion(idx);
        if (selections.length === 0) {
          this.dotStatusService.timerExpiredUnanswered.add(idx);
          host.cdRef.markForCheck();
        }
      });
  }

  setupQuiz(host: Host): void {
    this.resolveQuizData(host);
    this.initializeQuizFromRoute(host);
    this.initializeQuestionStreams(host);
    this.loadQuizQuestionsForCurrentQuiz(host);
    this.createQuestionData(host);
    void this.getQuestion(host);
    void this.handleNavigationToQuestion(host, host.currentQuestionIndex());
  }

  showExplanationForQuestion(host: Host, qIdx: number): void {
    const { explanationHtml } = this.quizContentLoaderService.prepareExplanationForQuestion({
      qIdx, questionsArray: host.questionsArray(), quiz: host.quiz(),
      currentQuestionIndex: host.currentQuestionIndex(), currentQuestion: host.currentQuestion(),
    });
    host.explanationToDisplay.set(explanationHtml);
    host.cdRef.detectChanges();
  }

  onExplanationChanged(host: Host, explanation: string | any, index?: number): void {
    const resolved = this.quizContentLoaderService.resolveExplanationChange(
      explanation, index, host.explanationToDisplay()
    );
    if (!resolved) return;

    const qIdx = resolved.index ?? this.quizService.getCurrentQuestionIndex?.() ?? 0;

    const _isShufEC = (this.quizService as any)?.isShuffleEnabled?.()
      && (this.quizService as any)?.shuffledQuestions?.length > 0;
    const rawQ: any = _isShufEC
      ? ((this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]
        ?? (this.quizService as any)?.shuffledQuestions?.[qIdx]
        ?? (this.quizService as any)?.questions?.[qIdx])
      : (this.quizService as any)?.questions?.[qIdx];

    const normEC = (t: any) => String(t ?? '').trim().toLowerCase();
    const qTextEC = normEC(rawQ?.questionText);
    let correctCountEC = 0;
    let correctTextsEC: string[] = [];
    try {
      const bundleEC: any[] = (this.quizService as any)?.quizInitialState ?? [];
      if (qTextEC && bundleEC.length > 0) {
        for (const quiz of bundleEC) {
          let found = false;
          for (const pq of (quiz?.questions ?? [])) {
            if (normEC(pq?.questionText) !== qTextEC) continue;
            found = true;
            const pOpts = (pq?.options ?? []).filter(
              (o: any) => o?.correct === true || String(o?.correct) === 'true'
            );
            correctCountEC = pOpts.length;
            correctTextsEC = pOpts.map((o: any) => normEC(o?.text)).filter((t: string) => !!t);
            break;
          }
          if (found) break;
        }
      }
    } catch { /* ignore */ }
    if (correctCountEC === 0) {
      const rawOpts: any[] = rawQ?.options ?? [];
      correctCountEC = rawOpts.filter(
        (o: any) => o?.correct === true || String(o?.correct) === 'true'
      ).length;
      correctTextsEC = rawOpts
        .filter((o: any) => o?.correct === true || String(o?.correct) === 'true')
        .map((o: any) => normEC(o?.text))
        .filter((t: string) => !!t);
    }
    const isMultiAnswer = correctCountEC > 1;

    if (!isMultiAnswer) {
      let scoredCorrect = false;
      try {
        const scoringSvc = (this.quizService as any)?.scoringService;
        const isShuf = (this.quizService as any)?.isShuffleEnabled?.() && (this.quizService as any)?.shuffledQuestions?.length > 0;
        if (isShuf && scoringSvc?.questionCorrectness) {
          let effectiveQuizId = (this.quizService as any)?.quizId || '';
          if (!effectiveQuizId) {
            try { effectiveQuizId = localStorage.getItem('lastQuizId') || ''; } catch {}
          }
          if (effectiveQuizId) {
            const origIdx = scoringSvc.quizShuffleService?.toOriginalIndex?.(effectiveQuizId, qIdx);
            if (typeof origIdx === 'number' && origIdx >= 0) {
              scoredCorrect = scoringSvc.questionCorrectness.get(origIdx) === true;
            }
          }
        } else {
          scoredCorrect = scoringSvc?.questionCorrectness?.get(qIdx) === true;
        }
        if (!scoredCorrect) {
          scoredCorrect = this.explanationTextService.fetBypassForQuestion?.get(qIdx) === true;
        }
      } catch { /* ignore */ }
      if (!scoredCorrect) {
        return;
      }
    }

    if (isMultiAnswer) {
      const selections = this.selectedOptionService.getSelectedOptionsForQuestion(qIdx) ?? [];
      const selTexts = new Set(
        selections
          .filter((s: any) => s?.selected !== false)
          .map((s: any) => normEC(s?.text))
          .filter((t: string) => !!t)
      );
      const allCorrectSelected = correctTextsEC.length > 0
        && correctTextsEC.every((t: string) => selTexts.has(t));
      if (!allCorrectSelected) {
        let scoredCorrect = false;
        try {
          const scoringSvc = (this.quizService as any)?.scoringService;
          const isShuf = (this.quizService as any)?.isShuffleEnabled?.() && (this.quizService as any)?.shuffledQuestions?.length > 0;
          if (isShuf && scoringSvc?.questionCorrectness) {
            let effectiveQuizId = (this.quizService as any)?.quizId || '';
            if (!effectiveQuizId) {
              try { effectiveQuizId = localStorage.getItem('lastQuizId') || ''; } catch {}
            }
            if (effectiveQuizId) {
              const origIdx = scoringSvc.quizShuffleService?.toOriginalIndex?.(effectiveQuizId, qIdx);
              if (typeof origIdx === 'number' && origIdx >= 0) {
                scoredCorrect = scoringSvc.questionCorrectness.get(origIdx) === true;
              }
            }
          } else {
            scoredCorrect = scoringSvc?.questionCorrectness?.get(qIdx) === true;
          }
          if (!scoredCorrect) {
            scoredCorrect = this.explanationTextService.fetBypassForQuestion?.get(qIdx) === true;
          }
        } catch { /* ignore */ }
        if (!scoredCorrect) return;
      }
    }

    host.explanationToDisplay.set(resolved.text);
    this.explanationTextService.setExplanationText(resolved.text, { index: resolved.index });
    this.explanationTextService.setShouldDisplayExplanation(true);
  }

  // â”€â”€â”€ Lifecycle / event wrappers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private bridgeQuestionPayload(host: Host): void {
    this.quizService.questionPayload$
      .pipe(
        filter((p): p is QuestionPayload => !!p && !!p.question && Array.isArray(p.options) && p.options.length > 0)
      )
      .subscribe((payload) => {
        // URL-MISMATCH GUARD: when the user has navigated directly to
        // /question/.../5 but a stale or default-Q1 payload is emitted
        // afterwards, the original code would overwrite the freshly-
        // loaded Q5 view with Q1's question + options. Cross-check the
        // payload's questionText against the URL-derived question and
        // drop emissions that don't belong to the current page.
        try {
          const m = window.location.pathname.match(/\/question\/[^/]+\/(\d+)/);
          if (m) {
            const urlIdx = Number(m[1]) - 1;
            const urlQuestion = this.quizService.questions?.[urlIdx];
            const urlText = (urlQuestion?.questionText ?? '').trim().toLowerCase();
            const payloadText = (payload.question?.questionText ?? '').trim().toLowerCase();
            if (urlText && payloadText && urlText !== payloadText) {
              return;  // skip stale payload that doesn't match the URL question
            }
          }
        } catch { /* non-browser env */ }

        host.combinedQuestionData.set(payload);
        host.questionToDisplaySig.set(payload.question.questionText?.trim() ?? '');
        host.cdRef.markForCheck();
      });
  }

  async runOnInit(host: Host): Promise<void> {
    host.questions$ = this.quizService.questions$;
    this.subscribeToRouteEvents(host);

    const quizId = await host.initializeQuizId();
    if (!quizId) return;
    host.quizId.set(quizId);

    try { localStorage.setItem('lastQuizId', quizId); } catch {}

    host.initializeQuestionIndex();

    let freshFromResults = false;
    try {
      freshFromResults = sessionStorage.getItem('freshStartFromResults') === 'true';
      sessionStorage.removeItem('freshStartFromResults');
    } catch {}

    if (freshFromResults) {
      this.quizResetService.performRestartServiceResets(host.quizId(), host.totalQuestions() || 20);
      this.dotStatusService.clearAllMaps();
      this.quizPersistence.clearClickConfirmedDotStatus(host.totalQuestions() || 20);
      this.quizPersistence.clearAllPersistedDotStatus(host.quizId());
      this.selectedOptionService.lastClickedCorrectByQuestion.clear();
      this.selectedOptionService.clearRefreshBackup();
      this.selectedOptionService.clearState();
      host.answeredQuestionIndices.clear();
      host.progressSig.set(0);
      try {
        for (let i = 0; i < 100; i++) {
          sessionStorage.removeItem('quiz_selection_' + i);
          sessionStorage.removeItem('displayMode_' + i);
          sessionStorage.removeItem('feedbackText_' + i);
        }
        sessionStorage.removeItem('selectedOptionsMap');
        sessionStorage.removeItem('rawSelectionsMap');
        sessionStorage.removeItem('answeredQuestionIndices');
        sessionStorage.removeItem('quizProgress');
        sessionStorage.removeItem('quizProgressQuizId');
      } catch {}
    }

    const cleared = this.quizResetService.clearStaleProgressAndDotStateForFreshStart(
      host.currentQuestionIndex(), host.quizId(), host.totalQuestions()
    );
    if (cleared) host.progressSig.set(0);

    this.fetchTotalQuestions(host);
    this.subscribeToQuestionIndex(host);
    this.bridgeQuestionPayload(host);

    await this.loadQuestions(host);
    host.isQuizLoaded.set(true);

    for (const [idx, status] of this.selectedOptionService.clickConfirmedDotStatus) {
      if (status === 'correct' || status === 'wrong') {
        host.answeredQuestionIndices.add(idx);
      }
    }
    if (host.answeredQuestionIndices.size > 0) {
      host.progressSig.set(Math.round((host.answeredQuestionIndices.size / host.totalQuestions()) * 100));
    }

    if (host.progressSig() === 0 && !freshFromResults) {
      try {
        const savedQuizId = sessionStorage.getItem('quizProgressQuizId');
        const savedProgress = sessionStorage.getItem('quizProgress');
        if (savedQuizId === host.quizId() && savedProgress) {
          const parsed = parseInt(savedProgress, 10);
          if (!isNaN(parsed) && parsed > 0) {
            host.progressSig.set(parsed);
          }
          const savedIndices = sessionStorage.getItem('answeredQuestionIndices');
          if (savedIndices) {
            const indices: number[] = JSON.parse(savedIndices);
            for (const idx of indices) {
              host.answeredQuestionIndices.add(idx);
            }
          }
        }
      } catch {}
    }

    const initialIndex = host.currentQuestionIndex() || 0;
    this.quizService.setCurrentQuestionIndex(initialIndex);
    host.updateDotStatus(initialIndex);

    if (!this.selectedOptionService.isQuestionAnswered(initialIndex)) {
      this.timerService.restartForQuestion(initialIndex);
      setTimeout(() => {
        if (!this.selectedOptionService.isQuestionAnswered(initialIndex)) {
          this.timerService.restartForQuestion(initialIndex);
        }
      }, 300);
    }
    Promise.resolve().then(() => host.cdRef.detectChanges());

    this.subscribeToTimerExpiry(host);

    this.setupQuiz(host);
    this.fetchRouteParams(host);
    this.subscribeRouterAndInit(host);
    this.subscribeToRouteParams(host);

    host.quizInitializationService.initializeAnswerSync(host.destroyRef);

    host.resetQuestionState();

    const confirmedStatus = this.selectedOptionService.clickConfirmedDotStatus.get(host.currentQuestionIndex());
    const isAnsweredOnRefresh = confirmedStatus === 'correct' || confirmedStatus === 'wrong';
    if (isAnsweredOnRefresh) {
      setTimeout(() => {
        this.selectedOptionService.setAnswered(true, true);
        this.selectedOptionService.setNextButtonEnabled(true);
        this.nextButtonStateService.forceEnable(60000);
        host.cdRef.detectChanges();
      }, 100);
    }

    if (freshFromResults) {
      setTimeout(() => {
        host.answeredQuestionIndices.clear();
        host.progressSig.set(0);
        host.cdRef.detectChanges();
      }, 150);
    }
  }

  runOnDestroy(host: Host): void {
    try { host.subscriptions?.unsubscribe(); } catch {}
    try { this.dotStatusService.dotStatusCache.clear(); } catch {}
    try { this.dotStatusService.pendingDotStatusOverrides.clear(); } catch {}
    try { this.dotStatusService.activeDotClickStatus.clear(); } catch {}
    try { this.timerService.stopTimer(undefined, { force: true }); } catch {}
    try { this.nextButtonStateService.cleanupNextButtonStateStream(); } catch {}
    const tooltip = host.nextButtonTooltip?.();
    if (tooltip) {
      try {
        tooltip.disabled = true;
        tooltip.hide();
      } catch {}
    }
  }

  async runAfterViewInit(host: Host): Promise<void> {
    setTimeout(() => host.checkScrollIndicator(), 500);
    void host.quizQuestionLoaderService.loadQuestionContents(host.currentQuestionIndex());

    if (host.quizQuestionLoaderService.pendingOptions?.length) {
      const opts = host.quizQuestionLoaderService.pendingOptions;
      host.quizQuestionLoaderService.pendingOptions = null;
      Promise.resolve().then(() => {
        const qqcLate = host.quizQuestionComponent?.();
        if (qqcLate && opts?.length) {
          qqcLate.optionsToDisplay.set([...opts]);
        }
      });
    }

  }

  async runOnGlobalKey(host: Host, event: KeyboardEvent): Promise<void> {
    const tag = (event.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    const currentIdx = this.quizService.getCurrentQuestionIndex();
    const hasSelectionForCurrent =
      (this.selectedOptionService.getSelectedOptionsForQuestion?.(currentIdx) ?? []).length > 0;

    switch (event.key) {
      case 'ArrowRight':
      case 'Enter': {
        if (!hasSelectionForCurrent) return;
        if (host.shouldShowNextButton()) {
          event.preventDefault();
          await host.advanceToNextQuestion();
          return;
        }
        if (host.shouldShowResultsButton) {
          event.preventDefault();
          host.advanceToResults();
          return;
        }
        break;
      }
      case 'ArrowLeft': {
        if (!hasSelectionForCurrent) return;
        if (currentIdx > 0) {
          event.preventDefault();
          await host.advanceToPreviousQuestion();
        }
        break;
      }
    }
  }
}