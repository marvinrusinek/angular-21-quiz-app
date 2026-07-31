import { DestroyRef, Service, inject } from '@angular/core';

import { NextButtonStateService } from '../state/next-button-state.service';
import { QuizStateService } from '../state/quizstate.service';
import { SelectedOptionService } from '../state/selectedoption.service';

@Service()
export class QuizInitializationService {
  // ── injects ─────────────────────────────────────────────────────
  private nextButtonStateService = inject(NextButtonStateService);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);

  // ── public methods ──────────────────────────────────────────────
  initializeAnswerSync(destroyRef: DestroyRef): void {
    this.nextButtonStateService.initializeNextButtonStateStream(
      this.selectedOptionService.isAnswered$,
      this.quizStateService.isLoading$,
      this.quizStateService.isNavigating$,
      destroyRef,
      this.quizStateService.interactionReady$
    );
  }
}