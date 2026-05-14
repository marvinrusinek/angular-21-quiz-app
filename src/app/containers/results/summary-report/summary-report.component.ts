import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, computed, effect,
  input, OnInit, signal
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { Observable, of } from 'rxjs';
import { take } from 'rxjs/operators';

import { Quiz } from '../../../shared/models/Quiz.model';
import { QuizMetadata } from '../../../shared/models/QuizMetadata.model';
import { QuizScore } from '../../../shared/models/QuizScore.model';
import { SummaryIconsComponent } from './summary-icons/summary-icons.component';
import { SummaryStatsComponent } from './summary-stats/summary-stats.component';
import { MatTooltipModule } from '@angular/material/tooltip';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { TimerService } from '../../../shared/services/features/timer/timer.service';

@Component({
  selector: 'codelab-results-summary',
  standalone: true,
  imports: [
    CommonModule,
    DatePipe,
    SummaryIconsComponent,
    SummaryStatsComponent,
    MatTooltipModule
  ],
  templateUrl: './summary-report.component.html',
  styleUrls: ['./summary-report.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SummaryReportComponent implements OnInit {
  // Signal input aliased to "quizId" so parent template binding stays the same.
  // Internal code may reassign the backing field, so we mirror via effect().
  readonly quizIdInput = input<string>('', { alias: 'quizId' });
  quizId = '';
  readonly viewMode = input<'summary' | 'highscores' | 'all'>('all');

  quizzes$: Observable<Quiz[]> = of([]);
  quizName$: Observable<string> = of('');
  readonly quizMetadata = signal<Partial<QuizMetadata>>({});
  readonly quizPercentage = computed(() => this.quizMetadata().percentage ?? 0);
  readonly completionTimeSig = signal(0);
  readonly elapsedMinutes = computed(() => Math.floor(this.completionTimeSig() / 60));
  readonly elapsedSeconds = computed(() => this.completionTimeSig() % 60);
  readonly checkedShuffle = signal(false);
  checkedShuffle$: Observable<boolean> = of(false);
  readonly highScores = signal<QuizScore[]>([]);
  quizMilestones: Record<string, string> = {};
  readonly currentScore = signal<QuizScore | null>(null);  // current quiz attempt score
  readonly codelabUrl = 'https://www.codelab.fun';

  constructor(
    private quizService: QuizService,
    private quizDataService: QuizDataService,
    private timerService: TimerService,
    private cdRef: ChangeDetectorRef
  ) {
    let firstRun = true;
    effect(() => {
      const incoming = this.quizIdInput();
      if (incoming) this.quizId = incoming;
      if (firstRun) {
        firstRun = false;
        return;
      }
      this.initComponent();
    });
  }

  ngOnInit(): void {
    this.initComponent();
  }

  private initComponent(): void {
    if (!this.quizId) {
      this.quizId = this.quizService.quizId || localStorage.getItem('quizId') || '';
    }

    try {
      // Initialize quizMetadata in initComponent when service data is available
      this.quizMetadata.set({
        totalQuestions: this.quizService.totalQuestions,
        totalQuestionsAttempted: this.quizService.totalQuestions,
        correctAnswersCount: this.quizService.correctAnswersCountSig,
        percentage:
          this.quizService.calculatePercentageOfCorrectlyAnsweredQuestions(),
        completionTime: this.timerService.calculateTotalElapsedTime(
          this.timerService.elapsedTimes
        )
      });

      this.quizzes$ = this.quizDataService.getQuizzes();
      this.quizzes$.pipe(take(1)).subscribe((quizzes) => {
        this.quizMilestones = quizzes.reduce<Record<string, string>>((acc, quiz) => {
          acc[quiz.quizId] = quiz.milestone;
          return acc;
        }, {});
        this.cdRef.markForCheck();
      });

      this.quizName$ = of(this.quizId);
      this.checkedShuffle$ = this.quizService.checkedShuffle$;
      this.checkedShuffle.set(this.quizService.isShuffleEnabled());
      this.calculateElapsedTime();
      this.quizService.saveHighScores();
      this.highScores.set(this.quizService.highScores);

      // Create current score object for display
      this.currentScore.set({
        quizId: this.quizId,
        attemptDateTime: new Date(),
        score: this.quizMetadata().percentage ?? 0,
        totalQuestions: this.quizService.totalQuestions
      });
    } catch (error) {
      // Fallback to ensure UI doesn't look broken
      this.currentScore.set({
        quizId: this.quizId || 'Unknown',
        attemptDateTime: new Date(),
        score: 0,
        totalQuestions: 0
      });
    }

    // Force change detection for OnPush when navigating back or tab switching
    this.cdRef.markForCheck();
    this.cdRef.detectChanges();
  }

  calculateElapsedTime(): void {
    const completionTime = this.quizMetadata().completionTime ?? 0;
    this.completionTimeSig.set(completionTime);
  }

  getMilestoneLabel(quizId: string): string {
    return this.quizMilestones[quizId] ?? quizId;
  }
}