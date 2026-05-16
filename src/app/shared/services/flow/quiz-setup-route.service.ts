import { Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, ParamMap, Params, Router } from '@angular/router';
import { distinctUntilChanged, filter, map, tap } from 'rxjs/operators';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';
import { QuizService } from '../data/quiz.service';
import { QuizStateService } from '../state/quizstate.service';
import { SelectedOptionService } from '../state/selectedoption.service';
import { NextButtonStateService } from '../state/next-button-state.service';
import { TimerService } from '../features/timer/timer.service';
import { SelectionMessageService } from '../features/selection-message/selection-message.service';
import { QuizDotStatusService } from './quiz-dot-status.service';
import { QuizContentLoaderService } from './quiz-content-loader.service';
import { QuizResetService } from './quiz-reset.service';
import { QuizRouteService } from './quiz-route.service';
import { QuizNavigationService } from './quiz-navigation.service';
import { QuizPersistenceService } from '../state/quiz-persistence.service';
import type { QuizComponent } from '../../../containers/quiz/quiz.component';

type Host = QuizComponent;

/**
 * Handles route subscriptions, URL-driven navigation, and question-index tracking for QuizComponent.
 * Extracted from QuizSetupService.
 */
@Injectable({ providedIn: 'root' })
export class QuizSetupRouteService {
  constructor(
    private router: Router,
    private quizService: QuizService,
    private quizStateService: QuizStateService,
    private selectedOptionService: SelectedOptionService,
    private nextButtonStateService: NextButtonStateService,
    private timerService: TimerService,
    private selectionMessageService: SelectionMessageService,
    private dotStatusService: QuizDotStatusService,
    private quizContentLoaderService: QuizContentLoaderService,
    private quizResetService: QuizResetService,
    private quizRouteService: QuizRouteService,
    private quizNavigationService: QuizNavigationService,
    private quizPersistence: QuizPersistenceService
  ) {}

  // â”€â”€ Route events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  subscribeToRouteEvents(
    host: Host,
    loadQuestions: (host: Host) => Promise<void>
  ): void {
    this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(async () => {
        const { routeQuizId, index: idx, isQuizSwitch } =
          this.quizRouteService.parseNavigationEndParams(host.activatedRoute, host.quizId);

        if (isQuizSwitch && routeQuizId) {
          this.quizNavigationService.resetForNewQuiz();
          this.quizResetService.performQuizSwitchResets(routeQuizId);
          this.resetComponentStateForQuizSwitch(host, routeQuizId);
          await loadQuestions(host);
          host.isQuizLoaded.set(true);
        }

        host.currentQuestionIndex.set(idx);
        this.quizService.setCurrentQuestionIndex(idx);
        host.updateDotStatus(idx);

        // Force-update combinedQuestionData so the template always
        // has question data after URL navigation. Prefer quizService.questions
        // getter which returns shuffled data when shuffle is active.
        const question = this.quizService.questions?.[idx]
          ?? host.questionsArray?.[idx] ?? null;
        if (question && question.options?.length > 0) {
          const payload = {
            question,
            options: question.options,
            explanation: question.explanation
          };
          host.combinedQuestionData.set(payload);
          host.questionToDisplaySig.set(question.questionText?.trim() ?? '');
          host.cdRef.detectChanges();

          // Force question text (with multi-answer banner) into <h3 #qText>
          const displayHTML = this.buildQuestionDisplayHTML(question);
          if (displayHTML) {
            const writeH3 = () => {
              try {
                const h3 = document.querySelector('codelab-quiz-content h3');
                if (h3 && !h3.innerHTML.trim()) {
                  h3.innerHTML = displayHTML;
                }
              } catch {}
            };
            setTimeout(writeH3, 0);
            setTimeout(writeH3, 100);
            setTimeout(writeH3, 300);
            setTimeout(writeH3, 600);
          }

          // Retry after microtask to ensure child components have rendered
          Promise.resolve().then(() => {
            host.combinedQuestionData.set(payload);
            host.cdRef.detectChanges();
          });
        }
      });
  }

  private resetComponentStateForQuizSwitch(host: Host, routeQuizId: string): void {
    host.questionsArray = [];
    host.currentQuestion.set(null);
    host.optionsToDisplaySig.set([]);
    host.combinedQuestionData.set(null);
    host.questionToDisplaySig.set('');
    host.explanationToDisplay.set('');
    host.currentQuestionIndex.set(0);
    host.lastLoggedIndex = -1;
    host.navigatingToResults = false;
    host.isQuizLoaded.set(false);
    host.isQuizDataLoaded.set(false);
    host.totalQuestions.set(0);
    host.progressSig.set(0);
    host.quizId = routeQuizId;
    this.quizService.setQuizId(routeQuizId);
  }

  fetchTotalQuestions(host: Host): void {
    this.quizService.getTotalQuestionsCount(host.quizId)
      .pipe()
      .subscribe((total: number) => {
        host.totalQuestions.set(total);
        host.cdRef.markForCheck();
      });
  }

  subscribeToQuestionIndex(host: Host): void {
    host.indexSubscription = this.quizService.currentQuestionIndex$
      .pipe(distinctUntilChanged())
      .subscribe((idx: number) => {
        const prevIdx = host.lastLoggedIndex;
        host.lastLoggedIndex = idx;
        host.currentQuestionIndex.set(idx);
        const { question, isNavigation } = this.quizContentLoaderService.handleQuestionIndexTransition({
          idx, prevIdx, quizId: host.quizId, questionsArray: host.questionsArray
        });

        if (question) {
          host.currentQuestion.set(question);
          host.questionToDisplaySig.set(question.questionText?.trim() ?? '');
          host.combinedQuestionData.set({
            question, options: question.options, explanation: question.explanation
          });
        }
        host.cdRef.markForCheck();

        if (isNavigation) {
          host.explanationToDisplay.set('');
          host.optionsToDisplaySig.set([]);
          host.updateDotStatus(idx);
        }
        // Nuclear clear: wipe ALL locks on navigation so disable state
        // from any prior question can't leak into the new one.
        try {
          const sos: any = this.selectedOptionService;
          sos._lockedByQuestion?.clear?.();
          sos._questionLocks?.clear?.();
          const sms: any = this.selectionMessageService;
          sms._singleAnswerCorrectLock?.clear?.();
          sms._singleAnswerIncorrectLock?.clear?.();
          sms._multiAnswerInProgressLock?.clear?.();
          sms._multiAnswerCompletionLock?.clear?.();
          sms._multiAnswerPreLock?.clear?.();
        } catch {}

        // Start the timer on both initial load and navigation (unless answered)
        if (!this.selectedOptionService.isQuestionAnswered(idx)) {
          this.timerService.restartForQuestion(idx);
        }
      });
  }

  subscribeToRouteParams(host: Host): void {
    host.activatedRoute.paramMap
      .pipe(
        distinctUntilChanged(
          (prev: ParamMap, curr: ParamMap) =>
            prev.get('questionIndex') === curr.get('questionIndex') &&
            prev.get('quizId') === curr.get('quizId')
        )
      )
      .subscribe((params: ParamMap) => void this.handleParamMapChange(host, params));
  }

  private async handleParamMapChange(host: Host, params: ParamMap): Promise<void> {
    const quizId = params.get('quizId') ?? '';
    const indexParam = params.get('questionIndex');
    const index = Number(indexParam) - 1;
    if (!quizId || isNaN(index) || index < 0) return;

    if (host.quizId && host.quizId !== quizId) {
      this.dotStatusService.clearAllMaps();
      this.quizPersistence.clearClickConfirmedDotStatus(host.totalQuestions() || 20);
      host.progressSig.set(0);
      this.quizStateService.reset();
    }

    host.quizId = quizId;
    host.currentQuestionIndex.set(index);
    this.quizService.setQuizId(quizId);
    this.quizService.setCurrentQuestionIndex(index);
    this.timerService.stopTimer?.(undefined, { force: true });
    this.timerService.resetTimer();
    this.timerService.resetTimerFlagsFor(index);

    try {
      const result = await this.quizContentLoaderService.loadQuestionFromRouteChange({ quizId, index });
      if (!result.success || !result.question) return;

      host.totalQuestions.set(result.totalQuestions);
      host.currentQuestion.set(result.question);
      host.question.set(result.question);
      const payload = {
        question: result.question, options: result.options, explanation: result.explanation
      };
      host.combinedQuestionData.set(payload);
      host.questionToDisplaySig.set(result.question.questionText?.trim() ?? '');
      host.optionsToDisplaySig.set([...result.options]);
      host.explanationToDisplay.set(result.explanation);
      host.qaToDisplay = { question: result.question, options: result.options };
      host.shouldRenderOptions.set(true);
      host.cdRef.detectChanges();

      // Force question text (with multi-answer banner) into <h3 #qText>
      const displayHTML = this.buildQuestionDisplayHTML(result.question);
      if (displayHTML) {
        const writeH3 = () => {
          try {
            const h3 = document.querySelector('codelab-quiz-content h3');
            if (h3 && !h3.innerHTML.trim()) h3.innerHTML = displayHTML;
          } catch {}
        };
        setTimeout(writeH3, 0);
        setTimeout(writeH3, 100);
        setTimeout(writeH3, 300);
      }

      if (!result.hasValidSelections) this.timerService.restartForQuestion(index);
      localStorage.setItem('savedQuestionIndex', index.toString());
    } catch (error: any) {
      // param map change handling failed
    }
  }

  fetchRouteParams(host: Host): void {
    host.activatedRoute.params
      .pipe(takeUntilDestroyed(host.destroyRef))
      .subscribe((params: Params) => {
        host.quizId = params['quizId'];
        host.questionIndex = +params['questionIndex'];
        host.currentQuestionIndex.set(host.questionIndex - 1);
      });
  }

  subscribeRouterAndInit(host: Host): void {
    host.routerSubscription = host.activatedRoute.data
      .pipe(takeUntilDestroyed(host.destroyRef))
      .subscribe((data: any) => {
        const quizData = data['quizData'];
        if (!quizData?.questions?.length) {
          void this.router.navigate(['/select']);
          return;
        }
        host.quizId = quizData.quizId;
        host.questionIndex = +host.activatedRoute.snapshot.params['questionIndex'];
      });
  }

  setupNavigation(host: Host): void {
    host.activatedRoute.params
      .pipe(
        takeUntilDestroyed(host.destroyRef),
        map((params: Params) => +params['questionIndex']),
        distinctUntilChanged(),
        tap((currentIndex: number) => {
          host.isNavigatedByUrl = true;
          void this.updateContentBasedOnIndex(host, currentIndex);
        })
      )
      .subscribe();
  }

  async updateContentBasedOnIndex(host: Host, index: number): Promise<void> {
    const adjustedIndex = index - 1;
    const total = host.quiz()?.questions?.length ?? 0;
    if (adjustedIndex < 0 || adjustedIndex >= total) return;

    this.quizContentLoaderService.lockAndPurgeFet(adjustedIndex);

    if (host.previousIndex() === adjustedIndex && !host.isNavigatedByUrl) return;

    host.currentQuestionIndex.set(adjustedIndex);
    host.previousIndex.set(adjustedIndex);
    this.quizService.currentQuestionIndexSig.set(adjustedIndex);
    this.quizService.currentQuestionIndexSubject.next(adjustedIndex);

    host.explanationToDisplay.set('');
    this.quizContentLoaderService.resetDisplayExplanationText(host.currentQuestionIndex());
    this.quizContentLoaderService.clearAllOptionStates();
    this.nextButtonStateService.setNextButtonState(false);

    await new Promise<void>((res) => requestAnimationFrame(() => res()));

    try {
      await this.loadQuestionByRouteIndex(host, index);
      this.quizContentLoaderService.unlockFetGateAfterRender(
        adjustedIndex,
        () => host.currentQuestionIndex(),
        () => host.cdRef.detectChanges()
      );
      setTimeout(() => this.quizContentLoaderService.enableAllOptionPointerEvents(), 200);
    } catch (error: any) {
      // content update failed
    } finally {
      host.isNavigatedByUrl = false;
    }
  }

  async loadQuestionByRouteIndex(host: Host, routeIndex: number): Promise<void> {
    try {
      const result = await this.quizContentLoaderService.loadQuestionByRoute({
        routeIndex, quiz: host.quiz(), quizId: host.quizId, totalQuestions: host.totalQuestions(),
      });
      if (result.questionIndex === -1) {
        void this.router.navigate(['/question/', host.quizId, 1]);
        return;
      }
      if (!result.success || !result.question) return;
      host.currentQuestionIndex.set(result.questionIndex);
      this.timerService.resetTimer();
      this.timerService.startTimer(this.timerService.timePerQuestion, this.timerService.isCountdown(), true);
      this.resetFeedbackState(host);
      host.currentQuestion.set(result.question);
      host.combinedQuestionData.set({
        question: result.question, options: result.question.options ?? [], explanation: result.question.explanation ?? ''
      });
      host.questionToDisplaySig.set(result.questionText);
      host.optionsToDisplaySig.set(result.optionsWithIds);
      setTimeout(() => {
        this.quizContentLoaderService.restoreSelectedOptionsFromSession(host.optionsToDisplaySig());
        setTimeout(() => {
          const prev = host.optionsToDisplaySig().find((opt: Option) => opt.selected);
          if (prev) this.selectedOptionService.reapplySelectionForQuestion(prev, host.currentQuestionIndex());
        }, 50);
      }, 50);
    } catch {
      host.cdRef.markForCheck();
    }
  }

  private resetFeedbackState(host: Host): void {
    for (const option of host.optionsToDisplaySig()) {
      option.feedback = '';
      option.showIcon = false;
      option.selected = false;
    }
    host.cdRef.detectChanges();
  }

  /**
   * Build question display HTML including the multi-answer banner.
   * Uses pristine quizInitialState for accurate correct-answer count.
   */
  buildQuestionDisplayHTML(question: QuizQuestion): string {
    const rawQ = (question.questionText ?? '').trim();
    if (!rawQ) return '';

    const opts = question.options ?? [];
    let numCorrect = opts.filter((o: Option) => o?.correct === true).length;

    // Cross-check against pristine data for accurate count
    try {
      const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
      const qText = nrm(rawQ);
      const bundle: any[] = (this.quizService as any)?.quizInitialState ?? [];
      for (const quiz of bundle) {
        for (const pq of (quiz?.questions ?? [])) {
          if (nrm(pq?.questionText) !== qText) continue;
          const pc = (pq?.options ?? []).filter(
            (o: any) => o?.correct === true || String(o?.correct) === 'true'
          ).length;
          if (pc > numCorrect) numCorrect = pc;
          break;
        }
        if (numCorrect > 1) break;
      }
    } catch {}

    if (numCorrect > 1 && opts.length > 0) {
      const pluralSuffix = numCorrect === 1 ? 'answer is' : 'answers are';
      const banner = `(${numCorrect} ${pluralSuffix} correct)`;
      return `${rawQ} <span class="correct-count">${banner}</span>`;
    }
    return rawQ;
  }
}