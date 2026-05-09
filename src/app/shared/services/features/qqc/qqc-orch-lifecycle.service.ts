import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { filter, take } from 'rxjs/operators';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

type Host = any;

/**
 * Orchestrates QQC lifecycle methods (ngOnInit, ngAfterViewInit, ngOnChanges, ngOnDestroy).
 * Extracted from QqcComponentOrchestratorService.
 */
@Injectable({ providedIn: 'root' })
export class QqcOrchLifecycleService {

  async runOnInit(host: Host): Promise<void> {
    const qIndex = host.quizService.getCurrentQuestionIndex();
    host.lifecycle.performRefTrace({ questions: host.quizService.questions, qIndex });

    host.idxSub = host.lifecycle.createIndexTimerSubscription({
      currentQuestionIndex$: host.quizService.currentQuestionIndex$,
      elapsedTime$: host.timerService.elapsedTime$,
      timePerQuestion: host.timerService.timePerQuestion,
      normalizeIndex: (idx: number) => host.normalizeIndex(idx),
      resetPerQuestionState: (i0: number) => host.resetPerQuestionState(i0),
      deleteHandledOnExpiry: (i0: number) => host.handledOnExpiry.delete(i0),
      emitPassiveNow: (i0: number) => host.emitPassiveNow(i0),
      prewarmResolveFormatted: (i0: number) => {
        if (!host._formattedByIndex?.has?.(i0)) {
          host.resolveFormatted(i0, { useCache: true, setCache: true }).catch(() => {});
        }
      },
      onTimerExpiredFor: (i0: number) => host.onTimerExpiredFor(i0)
    });

    host.subscriptionWiring.createCurrentQuestionIndexSubscription((index: number) => {
      host.currentQuestionIndex.set(index);
    });

    host.subscriptionWiring.createQuestionPayloadSubscription({
      onPayload: (payload: any) => {
        host.currentQuestion.set(payload.question);
        host.optionsToDisplay.set(payload.options);
        host.explanationToDisplay.set(payload.explanation ?? '');
        host.updateShouldRenderOptions(host.optionsToDisplay());
      }
    });

    host.shufflePreferenceSubscription = host.subscriptionWiring.createShufflePreferenceSubscription(
      (shouldShuffle: boolean) => { host.shuffleOptions = shouldShuffle; }
    );

    const navSubs = host.subscriptionWiring.createNavigationEventSubscriptions({
      onNavigationSuccess: () => host.resetUIForNewQuestion(),
      onNavigatingBack: () => {
        if (host.sharedOptionComponent) {
          host.sharedOptionComponent.isNavigatingBackwards = true;
        }
        host.resetUIForNewQuestion();
      },
      onNavigationToQuestion: ({ question, options }: { question: QuizQuestion; options: Option[] }) => {
        if (!host.containerInitialized && host.dynamicAnswerContainer) {
          host.loadDynamicComponent(question, options);
          host.containerInitialized = true;
        }
        host.sharedOptionConfig = null;
      },
      onExplanationReset: () => host.resetExplanation(),
      onRenderReset: () => { host.renderReady.set(false); },
      onResetUIForNewQuestion: () => host.resetUIForNewQuestion()
    });
    for (const sub of navSubs) {
      host.displaySubscriptions.push(sub);
    }

    host.subscriptionWiring.createPreResetSubscription({
      destroy$: host.destroy$,
      onPreReset: (idx: number) => host.resetPerQuestionState(idx),
      getLastResetFor: () => host.lastResetFor,
      setLastResetFor: (idx: number) => { host.lastResetFor = idx; }
    });

    host.subscriptionWiring.createRouteParamSubscription({
      activatedRoute: host.activatedRoute,
      onRouteChange: async (questionIndex: number) => {
        host.explanationVisible = false;
        host.explanationText.set('');
        try {
          const question = await firstValueFrom(host.quizService.getQuestionByIndex(questionIndex));
          if (!question) return;
        } catch {}
      }
    });

    const initialIdx = host.lifecycle.computeInitialQuestionIndex(host.activatedRoute);
    host.currentQuestionIndex.set(initialIdx.currentQuestionIndex);
    host.fixedQuestionIndex = initialIdx.fixedQuestionIndex;

    const loaded = await host.loadQuestion();
    if (!loaded) return;

    host.subscriptionWiring.createTimerExpiredSubscription({
      destroy$: host.destroy$,
      timerExpired$: host.timerService.expired$,
      onExpired: () => {
        const idx = host.normalizeIndex(host.currentQuestionIndex() ?? 0);
        host.onQuestionTimedOut(idx);
      }
    });

    host.subscriptionWiring.createTimerStopSubscription({
      destroy$: host.destroy$,
      timerStop$: host.timerService.stop$,
      onTimerStopped: () => {
        const reason = host.timedOut ? 'timeout' : 'stopped';
        host.handleTimerStoppedForActiveQuestion(reason);
      }
    });

    try {
      Object.getPrototypeOf(Object.getPrototypeOf(host)).ngOnInit?.call(host);

      host.populateOptionsToDisplay();

      host.displayModeSubscription = host.subscriptionWiring.createDisplayModeSubscription(
        host.currentQuestionIndex()
      );

      host.renderReady$ = host.lifecycle.createRenderReadyObservable({
        questionPayload$: host.questionPayload$,
        setCurrentQuestion: (q: QuizQuestion | null) => { host.currentQuestion.set(q); },
        setOptionsToDisplay: (opts: Option[]) => { host.optionsToDisplay.set(opts); },
        setExplanationToDisplay: (text: string) => { host.explanationToDisplay.set(text); },
        setRenderReady: (val: boolean) => { host.renderReady.set(val); },
        // renderReadySubject was replaced with the renderReady signal
        // in commit 2e084f59; .set() drives both the signal and any
        // toObservable-derived stream consumers.
        emitRenderReady: (val: boolean) => host.renderReady.set(val)
      });
      host.renderReadySubscription = host.renderReady$.subscribe();

      document.addEventListener('visibilitychange', host.onVisibilityChange.bind(host));

      host.questionLoader.initializeComponentState({
        questionsArray: host.questionsArray,
        currentQuestionIndex: host.currentQuestionIndex(),
      }).then((result: any) => {
        if (!result) return;
        host.questionsArray = result.questionsArray;
        host.currentQuestionIndex.set(result.currentQuestionIndex);
        host.currentQuestion.set(result.currentQuestion);
        host.generateFeedbackText(host.currentQuestion()).then(
          (text: string) => { host.feedbackText = text; },
          () => { host.feedbackText = 'Unable to generate feedback.'; }
        );
      });

      host.questionLoader.waitForQuestionData({
        currentQuestionIndex: host.currentQuestionIndex(),
        quizId: host.quizService.quizId,
      }).then((waitResult: any) => {
        if (!waitResult.currentQuestion) return;
        host.currentQuestionIndex.set(waitResult.currentQuestionIndex);
        host.currentQuestion.set(waitResult.currentQuestion);
        host.optionsToDisplay.set(waitResult.optionsToDisplay);
        host.quizService.getCurrentOptions(host.currentQuestionIndex()).pipe(take(1)).subscribe((options: Option[]) => {
          host.optionsToDisplay.set(Array.isArray(options) ? options : []);
          const previouslySelectedOption = host.optionsToDisplay().find((opt: Option) => opt.selected);
          if (previouslySelectedOption) {
            host.applyOptionFeedback(previouslySelectedOption);
          }
        });
        host.initializeForm();
        host.questionForm.updateValueAndValidity();
        window.scrollTo(0, 0);
      });

      if (host.question()) {
        host.data.set(host.questionLoader.buildInitialData(host.question(), host.options()));
      }
      host.initializeForm();
      host.quizStateService.setLoading(true);

      await host.initializeQuiz();
      await host.initializeQuizDataAndRouting();

      const quizQuestionSub = host.initializer.initializeQuizQuestion({
        onQuestionsLoaded: (_questions: QuizQuestion[]) => {}
      });
      if (quizQuestionSub) {
        host.questionsObservableSubscription = quizQuestionSub;
      }

      const questionIndexParam = host.activatedRoute.snapshot.paramMap.get('questionIndex');
      const firstQuestionIndex = host.initializer.parseQuestionIndexFromRoute(questionIndexParam);
      const firstQResult = host.initializer.setQuestionFirst({
        index: firstQuestionIndex,
        questionsArray: host.questionsArray
      });
      if (firstQResult) {
        host.currentQuestion.set(firstQResult.currentQuestion);
        host.optionsToDisplay.set(firstQResult.optionsToDisplay);
        if (host.lastProcessedQuestionIndex !== firstQResult.questionIndex || firstQResult.questionIndex === 0) {
          host.lastProcessedQuestionIndex = firstQResult.questionIndex;
        }
        setTimeout(() => {
          host.updateExplanationIfAnswered(firstQResult.questionIndex, firstQResult.currentQuestion!);
        }, 50);
      }

      if (host.currentQuestionIndex === 0) {
        const initialMessage = 'Please start the quiz by selecting an option.';
        if (host.selectionMessage() !== initialMessage) {
          host.selectionMessage.set(initialMessage);
        }
      } else {
        host.resetManager.clearSelection(host.correctAnswers, host.currentQuestion());
      }

      host.sharedVisibilitySubscription = host.subscriptionWiring.createVisibilitySubscription({
        onHidden: () => host.handlePageVisibilityChange(true),
        onVisible: () => host.handlePageVisibilityChange(false)
      });

      host.subscriptionWiring.createRouteListener({
        activatedRoute: host.activatedRoute,
        getQuestionsLength: () => host.questions?.length ?? 0,
        onRouteChange: (adjustedIndex: number) => {
          host.quizService.updateCurrentQuestionIndex(adjustedIndex);
          host.fetchAndSetExplanationText(adjustedIndex);
        }
      });

      const resetSubs = host.subscriptionWiring.createResetSubscriptions({
        onResetFeedback: () => host.resetFeedback(),
        onResetState: () => host.resetState()
      });
      host.resetFeedbackSubscription = resetSubs[0];
      host.resetStateSubscription = resetSubs[1];

      host.subscriptionWiring.createTotalQuestionsSubscription({
        quizId: host.quizId()!,
        destroy$: host.destroy$,
        onTotal: (totalQuestions: number) => { host.totalQuestions = totalQuestions; }
      });
    } catch (error) {
    }
  }

  async runAfterViewInit(host: Host): Promise<void> {
    const idx = host.fixedQuestionIndex ?? host.currentQuestionIndex() ?? 0;
    host.resetForQuestion(idx);

    host.lifecycle.deferRenderReadySubscription({
      sharedOptionComponent: host.sharedOptionComponent,
      subscribeToRenderReady: () => {
        if (!host.sharedOptionComponent) return;
        host.sharedOptionComponent.renderReady$
          .pipe(filter((ready: boolean) => ready === true), take(1))
          .subscribe(() => host.cdRef.detectChanges());
      }
    });

    host.lifecycle.createOptionsLoaderSubscription({
      options$: host.quizQuestionLoaderService.options$,
      setCurrentOptions: (opts: Option[]) => { host.currentOptions = opts; }
    });

    const index = host.currentQuestionIndex();

    const setupResult = await host.questionLoader.performAfterViewInitQuestionSetup({
      questionsArray: host.questionsArray,
      currentQuestionIndex: index,
      getFormattedExplanation: (q: QuizQuestion, i: number) => host.explanationManager.getFormattedExplanation(q, i),
      updateExplanationUI: (i: number, text: string) => host.updateExplanationUI(i, text)
    });

    if (!setupResult) {
      setTimeout(() => host.ngAfterViewInit(), 50);
      return;
    }
  }

  async runOnChanges(host: Host, changes: any): Promise<void> {
    const fetClear = host.displayStateManager.shouldClearFetEarlyShown({
      newIndex: changes['currentQuestionIndex']?.currentValue,
      prevIndex: changes['currentQuestionIndex']?.previousValue
    });
    if (fetClear.shouldClear && host._fetEarlyShown instanceof Set) {
      host._fetEarlyShown.delete(fetClear.indexToClear);
    }

    if (changes['questionPayload'] && host.questionPayload) {
      host.hydrateFromPayload(host.questionPayload);
      host.questionPayloadSig.set(host.questionPayload);
      setTimeout(() => {
        if (host.displayStateManager.shouldTriggerHydrationFallback({
          renderReady: host.renderReady(),
          options: host.optionsToDisplay()
        })) {
          host.renderReady.set(true);
          host.cdRef.detectChanges();
        }
      }, 150);
    }

    if (changes['currentQuestionIndex'] && !changes['currentQuestionIndex'].firstChange) {
      host.explanationVisible = false;
      host.explanationText.set('');
    }

    if (changes['question']) {
      host.optionsToDisplay.set(host.resetManager.clearOptionStateForQuestion(host.previousQuestionIndex(), host.optionsToDisplay()));
      host.cdRef.detectChanges();
    }

    if (changes['question'] || changes['options']) {
      host.unselectOption();
      host.handleQuestionAndOptionsChange(changes['question'], changes['options']);
      if (host.currentQuestionIndex() != null) {
        host.restoreSelectionsAndIconsForQuestion(host.quizService.currentQuestionIndex);
      }
      host.previousQuestionIndex.set(host.currentQuestionIndex());
    }

    const isRenderReady = host.displayStateManager.computeRenderReadyFromInputs({
      questionDataText: host.questionData()?.questionText,
      currentQuestionText: host.currentQuestion()?.questionText,
      options: host.options()
    });

    if (isRenderReady) {
      setTimeout(() => host.renderReady.set(true), 0);
    } else {
      host.renderReady.set(false);
    }
  }

  runOnDestroy(host: Host): void {
    try { document.removeEventListener('visibilitychange', host.onVisibilityChange.bind(host)); } catch {}
    try { host.destroy$?.next(); } catch {}
    try { host.destroy$?.complete(); } catch {}
    host.idxSub?.unsubscribe();
    host.questionsObservableSubscription?.unsubscribe();
    host.sharedVisibilitySubscription?.unsubscribe();
    host.resetFeedbackSubscription?.unsubscribe();
    host.resetStateSubscription?.unsubscribe();
    host.displayModeSubscription?.unsubscribe();
    host.renderReadySubscription?.unsubscribe();
    host.shufflePreferenceSubscription?.unsubscribe();
    try { host.nextButtonStateService.cleanupNextButtonStateStream(); } catch {}
  }
}