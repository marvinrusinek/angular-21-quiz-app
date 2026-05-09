import { ComponentRef, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { debounceTime, take } from 'rxjs/operators';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

type Host = any;

/**
 * Orchestrates QQC question loading and dynamic component initialization.
 * Extracted from QqcComponentOrchestratorService.
 */
@Injectable({ providedIn: 'root' })
export class QqcOrchQuestionLoadService {

  async runLoadDynamicComponent(host: Host, question: QuizQuestion, options: Option[]): Promise<void> {
    try {
      if (
        !question ||
        !Array.isArray(options) ||
        !options.length ||
        !host.dynamicAnswerContainer ||
        !('questionText' in question)
      ) return;

      let isMultipleAnswer = false;
      try {
        isMultipleAnswer = await firstValueFrom(
          host.quizQuestionManagerService.isMultipleAnswerQuestion(question)
        );
      } catch {
        return;
      }

      host.dynamicAnswerContainer.clear();
      await Promise.resolve();
      const componentRef: ComponentRef<any> = await host.dynamicComponentService.loadComponent(
        host.dynamicAnswerContainer,
        isMultipleAnswer,
        host.onOptionClicked.bind(host)
      );
      if (!componentRef?.instance) return;
      const instance = componentRef.instance;

      const configured = host.questionLoader.configureDynamicInstance({
        instance,
        componentRef,
        question,
        options,
        isMultipleAnswer,
        currentQuestionIndex: host.currentQuestionIndex(),
        navigatingBackwards: false,
        defaultConfig: host.getDefaultSharedOptionConfig?.(),
        onOptionClicked: host.onOptionClicked.bind(host)
      });
      host.questionData.set(configured.questionData);
      host.sharedOptionConfig = configured.sharedOptionConfig;
      host.cdRef.markForCheck();
      await (instance as any).initializeSharedOptionConfig(configured.clonedOptions);
      if (!Object.prototype.hasOwnProperty.call(instance, 'onOptionClicked')) {
        instance.onOptionClicked = host.onOptionClicked.bind(host);
      }
      host.updateShouldRenderOptions(instance.optionsToDisplay());
      if (host.displayStateManager.computeRenderReadiness(instance.optionsToDisplay())) {
        host.shouldRenderOptions.set(true);
      }
      try { componentRef.changeDetectorRef.markForCheck(); } catch {}
    } catch (error) {
    }
  }

  async runLoadQuestion(host: Host, signal?: AbortSignal): Promise<boolean> {
    host.readyForExplanationDisplay = false;
    host.isExplanationReady = false;
    host.isExplanationLocked = true;
    host.forceQuestionDisplay = true;

    const shouldPreserveVisualState = host.questionLoader.canRenderQuestionInstantly(
      host.questionsArray,
      host.currentQuestionIndex()
    );
    const explanationSnapshot = host.explanationManager.captureExplanationSnapshot({
      preserveVisualState: shouldPreserveVisualState,
      index: host.currentQuestionIndex(),
      explanationToDisplay: host.explanationToDisplay(),
      quizId: host.quizId(),
      isAnswered: host.isAnswered as boolean,
      displayMode: host.displayMode(),
      shouldDisplayExplanation: host.shouldDisplayExplanation,
      explanationVisible: host.explanationVisible,
      displayExplanation: host.displayExplanation,
      displayStateAnswered: host.displayState?.answered
    });
    const shouldKeepExplanationVisible = explanationSnapshot.shouldRestore;

    host.questionLoader.performPreLoadReset({
      shouldPreserveVisualState,
      shouldKeepExplanationVisible,
      currentQuestionIndex: host.currentQuestionIndex()
    });

    if (shouldPreserveVisualState) {
      host.isLoading = false;
    } else {
      host.isLoading = true;
      host.quizStateService.setLoading(true);
      host.quizStateService.setAnswerSelected(false);
      if (!host.quizStateService.isLoading()) host.quizStateService.startLoading();
    }

    try {
      host.selectedOptionId = null;
      const lockedIndex = host.currentQuestionIndex();

      await host.resetQuestionStateBeforeNavigation({
        preserveVisualState: shouldPreserveVisualState,
        preserveExplanation: shouldKeepExplanationVisible
      });

      if (!shouldKeepExplanationVisible) {
        const clearResult = host.questionLoader.performPostResetExplanationClear();
        host.renderReady.set(false);
        host.displayState = clearResult.displayState;
        host.forceQuestionDisplay = clearResult.forceQuestionDisplay;
        host.readyForExplanationDisplay = clearResult.readyForExplanationDisplay;
        host.isExplanationReady = clearResult.isExplanationReady;
        host.isExplanationLocked = clearResult.isExplanationLocked;
        host.feedbackText = clearResult.feedbackText;
      } else {
        const restoreResult = host.explanationFlow.computeRestoreAfterReset({
          questionIndex: lockedIndex,
          explanationText: explanationSnapshot.explanationText,
          questionState: explanationSnapshot.questionState,
          quizId: host.quizId(),
          quizServiceQuizId: host.quizService.quizId,
          currentQuizId: host.quizService.getCurrentQuizId(),
        });
        if (!restoreResult.shouldSkip) {
          host.explanationToDisplay.set(restoreResult.explanationText);
          host.updateDisplayMode(restoreResult.displayMode);
          host.applyDisplayState(restoreResult.displayState);
          host.applyExplanationFlags(restoreResult);
          host.emitExplanationChange(restoreResult.explanationText, true);
        }
      }

      const loadResult = await host.questionLoader.performLoadQuestionPostReset({
        currentQuestionIndex: host.currentQuestionIndex(),
        questionsArray: host.questionsArray,
        quizId: host.quizId(),
        signal,
        questions: host.questions
      });

      if (!loadResult) return false;
      if (loadResult.shouldRedirect) {
        await host.router.navigate(['/results', host.quizId()]);
        return false;
      }

      host.questionsArray = loadResult.questionsArray;
      host.currentQuestion.set(loadResult.currentQuestion);
      host.optionsToDisplay.set(loadResult.optionsToDisplay);
      host.questionToDisplay = loadResult.questionToDisplay;
      host.updateShouldRenderOptions(host.optionsToDisplay());

      const banner = host.feedbackManager.computeCorrectAnswersBanner({
        currentQuestion: host.currentQuestion(),
        currentQuestionIndex: host.currentQuestionIndex()
      });
      host.quizService.updateCorrectAnswersText(banner.bannerText);

      if (host.sharedOptionComponent) host.sharedOptionComponent.initializeOptionBindings();
      host.cdRef.markForCheck();

      if (host.currentQuestion() && host.optionsToDisplay()?.length > 0) {
        host.questionAndOptionsReady.emit();
        host.quizService.emitQuestionAndOptions(
          host.currentQuestion(),
          host.optionsToDisplay(),
          host.currentQuestionIndex()
        );
      }

      return true;
    } catch (error) {
      host.feedbackText = 'Error loading question. Please try again.';
      host.currentQuestion.set(null);
      host.optionsToDisplay.set([]);
      return false;
    } finally {
      host.isLoading = false;
      host.quizStateService.setLoading(false);
    }
  }

  runSetupRouteChangeHandler(host: Host): void {
    host.subscriptionWiring.createRouteChangeHandlerSubscription({
      activatedRoute: host.activatedRoute,
      getTotalQuestions: () => host.totalQuestions,
      parseRouteIndex: (rawParam: string | null) =>
        host.initializer.handleRouteChangeParsing({ rawParam, totalQuestions: host.totalQuestions }),
      onRouteChange: async (zeroBasedIndex: number, _displayIndex: number) => {
        host.currentQuestionIndex.set(zeroBasedIndex);
        host.explanationVisible = false;
        host.explanationText.set('');

        const routeResult = await host.questionLoader.performRouteChangeUpdate({
          zeroBasedIndex,
          questionsArray: host.questionsArray,
          loadQuestion: () => host.loadQuestion(),
          isAnyOptionSelected: (idx: number) => host.isAnyOptionSelected(idx),
          updateExplanationText: (idx: number) => host.updateExplanationText(idx),
          shouldDisplayExplanation: host.shouldDisplayExplanation,
          questionForm: host.questionForm
        });

        if (!routeResult) return;
        host.currentQuestion.set(routeResult.currentQuestion);
        host.optionsToDisplay.set(routeResult.optionsToDisplay);

        if (host.shouldDisplayExplanation) {
          host.showExplanationChange.emit(true);
          const transition = host.explanationDisplay.computeExplanationModeTransition(
            host.shouldDisplayExplanation,
            host.displayMode()
          );
          if (transition) {
            host.applyDisplayState(transition.displayState);
            host.updateDisplayMode(transition.displayMode);
            const f = transition.explanationFlags;
            host.shouldDisplayExplanation = f.shouldDisplayExplanation;
            host.explanationVisible = f.explanationVisible;
            host.forceQuestionDisplay = f.forceQuestionDisplay;
            host.readyForExplanationDisplay = f.readyForExplanationDisplay;
            host.isExplanationReady = f.isExplanationReady;
            host.isExplanationLocked = f.isExplanationLocked;
          }
        }
      }
    });
  }

  async runInitializeQuiz(host: Host): Promise<void> {
    if (host.initialized) return;
    host.initialized = true;

    host.quizId.set(host.activatedRoute.snapshot.paramMap.get('quizId'));
    host.isLoading = true;
    try {
      const result = await host.initializer.performFullQuizInit({
        currentQuestionIndex: host.currentQuestionIndex(),
        questionsArray: host.questionsArray,
        routeQuizId: host.quizId(),
        setQuestionOptions: () => host.setQuestionOptions(),
        questionLoader: host.questionLoader,
        prepareExplanationForQuestion: (p: any) => host.initializer.prepareExplanationForQuestion(p),
        getExplanationText: (idx: number) => host.explanationManager.getExplanationText(idx)
      });
      if (result) {
        host.questionsArray = result.questionsArray;
        host.questions = result.questions;
        host.quizId.set(result.quizId);
      }
    } finally {
      host.isLoading = false;
    }
  }

  async runInitializeQuizDataAndRouting(host: Host): Promise<void> {
    const result = 
      await host.questionLoader.performQuizDataAndRoutingInit(
        { quizId: host.quizId() }
      );
    if (!result) return;

    host.questions = result.questions;
    host.questionsArray = result.questions;
    if (result.quiz) host.quiz = result.quiz;
    if (!host.quiz) return;

    host.quizService.questionsLoaded$.pipe(
      take(1), debounceTime(100)
    ).subscribe((loaded: boolean) => {
      if (loaded) host.setupRouteChangeHandler();
    });
  }
}