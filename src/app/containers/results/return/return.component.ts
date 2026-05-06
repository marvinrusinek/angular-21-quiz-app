import { ChangeDetectionStrategy, Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatListModule } from '@angular/material/list';

import { QuizService } from '../../../shared/services/data/quiz.service';
import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { ExplanationTextService } from '../../../shared/services/features/explanation/explanation-text.service';
import { SelectedOptionService } from '../../../shared/services/state/selectedoption.service';
import { TimerService } from '../../../shared/services/features/timer/timer.service';
import { QuizDotStatusService } from '../../../shared/services/flow/quiz-dot-status.service';
import { QuizPersistenceService } from '../../../shared/services/state/quiz-persistence.service';
import { ThemeService } from '../../../shared/services/ui/theme.service';

@Component({
  selector: 'codelab-results-return',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatListModule],
  templateUrl: './return.component.html',
  styleUrls: ['./return.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ReturnComponent implements OnInit {
  readonly quizId = signal<string>('');
  readonly codelabUrl = 'https://www.codelab.fun';

  constructor(
    private quizService: QuizService,
    private quizDataService: QuizDataService,
    private selectedOptionService: SelectedOptionService,
    private explanationTextService: ExplanationTextService,
    private timerService: TimerService,
    private dotStatusService: QuizDotStatusService,
    private quizPersistence: QuizPersistenceService,
    private themeService: ThemeService,
    private router: Router
  ) { }

  ngOnInit(): void {
    this.quizId.set(this.quizService.quizId);
  }

  restartQuiz(): void {
    if (!this.quizId()) {
      this.quizId.set(this.quizService.quizId);
    }

    // Reset score FIRST before anything else
    this.quizService.resetScore();
    localStorage.removeItem('correctAnswersCount');
    localStorage.removeItem('questionCorrectness');

    // Clear “results snapshot”
    this.quizService.clearFinalResult();

    const id = this.quizId();

    // Clear session state (answered, selections, resume index, completion flags)
    if (id) {
      this.quizService.resetQuizSessionForNewRun(id);
      this.selectedOptionService.clearState();
    }

    this.quizService.resetAll();
    this.quizService.resetQuestions();
    this.explanationTextService.resetExplanationState();

    this.timerService.clearTimerState();

    // Clear ALL dot status sources so dots reset to gray
    this.dotStatusService.clearAllMaps();
    this.selectedOptionService.clickConfirmedDotStatus.clear();
    this.selectedOptionService.lastClickedCorrectByQuestion.clear();
    this.selectedOptionService.clearRefreshBackup();
    this.quizService.questionCorrectness.clear();
    if (id) {
      this.selectedOptionService.clearAllSelectionsForQuiz(id);
      this.quizPersistence.clearAllPersistedDotStatus(id);
      this.quizPersistence.clearClickConfirmedDotStatus(20);
    }
    try {
      for (let i = 0; i < 100; i++) {
        sessionStorage.removeItem('dot_confirmed_' + i);
        sessionStorage.removeItem('sel_Q' + i);
        sessionStorage.removeItem('quiz_selection_' + i);
        sessionStorage.removeItem('displayMode_' + i);
        sessionStorage.removeItem('feedbackText_' + i);
      }
      sessionStorage.removeItem('selectedOptionsMap');
      sessionStorage.removeItem('rawSelectionsMap');
      sessionStorage.removeItem('selectionHistory');
      sessionStorage.removeItem('isAnswered');
      sessionStorage.removeItem('answeredQuestionIndices');
      const lsKeysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('quiz_dot_status_') || key.startsWith('quiz_progress_'))) {
          lsKeysToRemove.push(key);
        }
      }
      for (const key of lsKeysToRemove) {
        localStorage.removeItem(key);
      }
      sessionStorage.setItem('freshStartFromResults', 'true');
    } catch {}

    // Reset to light mode when restarting
    if (this.themeService.isDark()) {
      this.themeService.toggle();
    }

    try { sessionStorage.removeItem('resultsActiveSection'); } catch {}

    if (id) {
      void this.router.navigate(['/quiz/question', id, 1]);
    }
  }

  selectQuiz(): void {
    this.selectedOptionService.clearState();

    const id = this.quizId() || this.quizService.quizId;

    // Only mark as completed (checkmark) if score is 100%
    let isPerfect = false;
    try {
      const snapshot = JSON.parse(sessionStorage.getItem('finalResult') || '{}');
      isPerfect = snapshot.total > 0 && snapshot.correct === snapshot.total;
    } catch {}
    if (id) {
      try {
        if (isPerfect) {
          const existing = JSON.parse(sessionStorage.getItem('completedQuizIds') || '[]');
          if (!existing.includes(id)) {
            existing.push(id);
          }
          sessionStorage.setItem('completedQuizIds', JSON.stringify(existing));
        } else {
          const existing = JSON.parse(sessionStorage.getItem('startedQuizIds') || '[]');
          if (!existing.includes(id)) {
            existing.push(id);
          }
          sessionStorage.setItem('startedQuizIds', JSON.stringify(existing));
        }
      } catch {}
    }

    // Clear quiz status so non-perfect quizzes don't show as completed
    if (id) {
      if (isPerfect) {
        this.quizDataService.updateQuizStatus(id, 'completed');
      } else {
        this.quizDataService.updateQuizStatus(id, 'started');
      }
    }

    this.quizService.resetAll();
    this.quizService.resetQuestions();
    this.explanationTextService.resetExplanationState();
    this.timerService.clearTimerState();

    // Reset to light mode when leaving results
    if (this.themeService.isDark()) {
      this.themeService.toggle();
    }

    try { sessionStorage.removeItem('resultsActiveSection'); } catch {}

    this.quizId.set('');
    this.router.navigate(['/select/']);
  }
}