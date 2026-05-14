import { DestroyRef, Injectable } from '@angular/core';

import { NextButtonStateService } from '../state/next-button-state.service';
import { QuizStateService } from '../state/quizstate.service';
import { SelectedOptionService } from '../state/selectedoption.service';

@Injectable({ providedIn: 'root' })
export class QuizInitializationService {
  constructor(
    private nextButtonStateService: NextButtonStateService,
    private quizStateService: QuizStateService,
    private selectedOptionService: SelectedOptionService
  ) {}

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