import { inject, Service } from '@angular/core';

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
@Service()
export class QuizQuestionFacadeService {
  // ── injects ─────────────────────────────────────────────────────
  public readonly clickOrchestrator = inject(QqcOptionClickOrchestratorService);
  public readonly componentOrchestrator = inject(QqcComponentOrchestratorService);
  public readonly displayStateManager = inject(QqcDisplayStateManagerService);
  public readonly explanationDisplay = inject(QqcExplanationDisplayService);
  public readonly explanationFlow = inject(QqcExplanationFlowService);
  public readonly explanationManager = inject(QqcExplanationManagerService);
  public readonly feedbackManager = inject(QqcFeedbackManagerService);
  public readonly initializer = inject(QqcInitializerService);
  public readonly lifecycle = inject(QqcLifecycleService);
  public readonly navigationHandler = inject(QqcNavigationHandlerService);
  public readonly optionSelection = inject(QqcOptionSelectionService);
  public readonly questionLoader = inject(QqcQuestionLoaderService);
  public readonly resetManager = inject(QqcResetManagerService);
  public readonly subscriptionWiring = inject(QqcSubscriptionWiringService);
  public readonly timerEffect = inject(QqcTimerEffectService);
}
