import { ChangeDetectionStrategy, Component, computed, OnInit, Signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';

import { QuizMetadata } from '../../../shared/models/QuizMetadata.model';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { TimerService } from '../../../shared/services/features/timer/timer.service';

@Component({
  selector: 'codelab-results-challenge',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './challenge.component.html',
  styleUrls: ['./challenge.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ChallengeComponent implements OnInit {
  readonly quizzes = this.quizDataService.quizzesSig;
  quizName = '';
  currentQuizId = '';

  private readonly correctAnswersCount: Signal<number> = this.quizService.correctAnswersCountSig;
  readonly percentageCorrect = computed(() => {
    const total = this.quizService.totalQuestions;
    if (!total) return 0;
    return Math.round((100 * this.correctAnswersCount()) / total);
  });

  quizMetadata: Partial<QuizMetadata> = {
    totalQuestions: this.quizService.totalQuestions,
    totalQuestionsAttempted: this.quizService.totalQuestions,
    correctAnswersCount: this.quizService.correctAnswersCountSig,
    percentage: this.percentageCorrect(),
    completionTime: this.timerService.calculateTotalElapsedTime(
      this.timerService.elapsedTimes
    )
  };
  codelabUrl = 'https://www.codelab.fun';

  constructor(
    private quizService: QuizService,
    private quizDataService: QuizDataService,
    private timerService: TimerService,
    private activatedRoute: ActivatedRoute
  ) {}

  ngOnInit(): void {
    // Get quizId from service (most reliable) or from route params
    this.currentQuizId = this.quizService.quizId ||
      this.activatedRoute.snapshot.paramMap.get('quizId') ||
      this.activatedRoute.parent?.snapshot.paramMap.get('quizId') || '';
    this.quizName = this.currentQuizId;
  }
}