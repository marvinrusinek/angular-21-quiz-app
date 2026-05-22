import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, computed, effect,
  inject, input, OnInit, signal
} from '@angular/core';
import { CommonModule } from '@angular/common';

import { QuizStatus } from '../../../shared/models/quiz-status.enum'
import { Quiz } from '../../../shared/models/Quiz.model';

import { QuizMetadata } from '../../../shared/models/QuizMetadata.model';
import { Resource } from '../../../shared/models/Resource.model';

import { QuizService } from '../../../shared/services/data/quiz.service';
import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { TimerService } from '../../../shared/services/features/timer/timer.service';

@Component({
  selector: 'codelab-results-statistics',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './statistics.component.html',
  styleUrls: ['./statistics.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StatisticsComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly quizDataService = inject(QuizDataService);
  private readonly quizService = inject(QuizService);
  private readonly timerService = inject(TimerService);
  private readonly cdRef = inject(ChangeDetectorRef);

  // ── inputs ──────────────────────────────────────────────────────
  // Signal input aliased to "quizId" so parent template binding stays the same.
  // Internal code may reassign the backing field, so we mirror via effect().
  readonly quizIdInput = input<string>('', { alias: 'quizId' });
  readonly viewMode =
    input<'score' | 'resources' | 'all'>('all');

  // ── remaining variables ─────────────────────────────────────────
  readonly quizzes = this.quizDataService.quizzesSig;
  readonly quizId = signal('');

  readonly milestoneName = computed(() => {
    const qId = this.quizId();
    if (!qId) return '';
    const cached = this.quizDataService.getCachedQuizById(qId);
    if (cached?.milestone) return cached.milestone;
    const found = this.quizzes().find(q => q.quizId === qId);
    return found?.milestone ?? qId;
  });

  readonly quizMetadata = signal<Partial<QuizMetadata>>({});
  readonly resources = signal<Resource[]>([]);
  readonly completionTimeSig = signal(0);
  readonly elapsedMinutes = computed(() => Math.floor(this.completionTimeSig() / 60));
  readonly elapsedSeconds = computed(() => this.completionTimeSig() % 60);
  readonly percentage = computed(() => this.quizMetadata().percentage ?? 0);

  CONGRATULATIONS =
    'https://raw.githubusercontent.com/marvinrusinek/angular-9-quiz-app/master/src/assets/images/congratulations.jpg';
  NOT_BAD =
    'https://raw.githubusercontent.com/marvinrusinek/angular-9-quiz-app/master/src/assets/images/not-bad.jpg';
  TRY_AGAIN =
    'https://raw.githubusercontent.com/marvinrusinek/angular-9-quiz-app/master/src/assets/images/try-again.jpeg';

  constructor() {
    let firstRun = true;
    effect(() => {
      const incoming = this.quizIdInput();
      if (incoming) this.quizId.set(incoming);
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

  calculateElapsedTime(): void {
    const completionTime = this.quizMetadata().completionTime ?? 0;
    this.completionTimeSig.set(completionTime);
  }

  calculatePercentageOfCorrectlyAnsweredQuestions(): number {
    const total = this.quizService.totalQuestions();
    if (total === 0) return 0; // Prevent NaN

    return Math.round(
      (100 * this.quizService.correctAnswersCountSig()) / total
    );
  }

  private initComponent(): void {
    // Priority: Input quizId > Service quizId > Stored quizId
    if (!this.quizId()) {
      this.quizId.set(this.quizService.quizId || localStorage.getItem('quizId') || '');
    }

    // Calculate elapsed time from array or use completionTime as fallback
    let totalElapsedTime = this.timerService.calculateTotalElapsedTime(
      this.timerService.elapsedTimes
    );

    // Fallback: if elapsedTimes is empty, use the direct completionTime property
    if (totalElapsedTime === 0 && this.timerService.completionTime > 0) {
      totalElapsedTime = this.timerService.completionTime;
    }

    // Initialize quizMetadata in initComponent when service data is available
    this.quizMetadata.set({
      totalQuestions: this.quizService.totalQuestions(),
      totalQuestionsAttempted: this.quizService.totalQuestions(),
      correctAnswersCount: this.quizService.correctAnswersCountSig,
      percentage: this.calculatePercentageOfCorrectlyAnsweredQuestions(),
      completionTime: totalElapsedTime
    });

    // Ensure resources are loaded for this quiz
    if (this.quizId()) {
      this.quizService.loadResourcesForQuiz(this.quizId());
    }
    this.resources.set(this.quizService.resources);
    this.calculateElapsedTime();
    this.sendQuizStatusToQuizService();

    // Force change detection for OnPush when navigating back or tab switching
    this.cdRef.markForCheck();
    this.cdRef.detectChanges();
  }

  private sendQuizStatusToQuizService(): void {
    this.quizService.setQuizStatus(QuizStatus.COMPLETED);
  }
}
