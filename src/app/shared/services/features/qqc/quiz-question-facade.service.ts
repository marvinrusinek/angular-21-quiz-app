import { Injectable } from '@angular/core';

import { QqcComponentOrchestratorService } from './qqc-component-orchestrator.service';
import { QqcDisplayStateManagerService } from './qqc-display-state-manager.service';
import { QqcExplanationDisplayService } from './qqc-explanation-display.service';
import { QqcExplanationFlowService } from './qqc-explanation-flow.service';
import { QqcExplanationManagerService } from './qqc-explanation-manager.service';
import { QqcFeedbackManagerService } from './qqc-feedback-manager.service';
import { QqcInitializerService } from './qqc-initializer.service';
import { QqcLifecycleService } from './qqc-lifecycle.service';
import { QqcNavigationHandlerService } from './qqc-navigation-handler.service';
import { QqcOptionClickOrchestratorService } from './qqc-option-click-orchestrator.service';
import { QqcOptionSelectionService } from './qqc-option-selection.service';
import { QqcQuestionLoaderService } from './qqc-question-loader.service';
import { QqcResetManagerService } from './qqc-reset-manager.service';
import { QqcSubscriptionWiringService } from './qqc-subscription-wiring.service';
import { QqcTimerEffectService } from './qqc-timer-effect.service';

/**
 * Facade that bundles every Qqc-prefixed sub-service consumed by
 * QuizQuestionComponent. Lets the component inject one service instead of
 * fifteen, while QQC's getters re-expose each member so the existing
 * `host.<service>` access pattern used by the orchestrators keeps working.
 */
@Injectable({ providedIn: 'root' })
export class QuizQuestionFacadeService {
  constructor(
    public readonly componentOrchestrator: QqcComponentOrchestratorService,
    public readonly displayStateManager: QqcDisplayStateManagerService,
    public readonly explanationDisplay: QqcExplanationDisplayService,
    public readonly explanationFlow: QqcExplanationFlowService,
    public readonly explanationManager: QqcExplanationManagerService,
    public readonly feedbackManager: QqcFeedbackManagerService,
    public readonly initializer: QqcInitializerService,
    public readonly lifecycle: QqcLifecycleService,
    public readonly navigationHandler: QqcNavigationHandlerService,
    public readonly clickOrchestrator: QqcOptionClickOrchestratorService,
    public readonly optionSelection: QqcOptionSelectionService,
    public readonly questionLoader: QqcQuestionLoaderService,
    public readonly resetManager: QqcResetManagerService,
    public readonly subscriptionWiring: QqcSubscriptionWiringService,
    public readonly timerEffect: QqcTimerEffectService
  ) {}
}
