import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, computed, effect,
  input, OnInit, signal
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
  readonly quizzes = this.quizDataService.quizzesSig;
  // Signal input aliased to "quizId" so parent template binding stays the same.
  // Internal code may reassign the backing field, so we mirror via effect().
  readonly quizIdInput = input<string>('', { alias: 'quizId' });
  private readonly quizIdSig = signal('');
  get quizId(): string { return this.quizIdSig(); }
  set quizId(v: string) { this.quizIdSig.set(v); }

  readonly milestoneName = computed(() => {
    const qId = this.quizIdSig();
    if (!qId) return '';
    const cached = this.quizDataService.getCachedQuizById(qId);
    if (cached?.milestone) return cached.milestone;
    const found = this.quizzes().find(q => q.quizId === qId);
    return found?.milestone ?? qId;
  });
  readonly viewMode=
    input<'score' | 'resources' | 'all'>('all');

  readonly quizMetadata = signal<Partial<QuizMetadata>>({});
  resources: Resource[] = [];
  status: QuizStatus = QuizStatus.STARTED;
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
    // Priority: Input quizId > Service quizId > Stored quizId
    if (!this.quizId) {
      this.quizId = this.quizService.quizId || localStorage.getItem('quizId') || '';
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
      totalQuestions: this.quizService.totalQuestions,
      totalQuestionsAttempted: this.quizService.totalQuestions,
      correctAnswersCount: this.quizService.correctAnswersCountSig,
      percentage: this.calculatePercentageOfCorrectlyAnsweredQuestions(),
      completionTime: totalElapsedTime
    });

    // Ensure resources are loaded for this quiz
    if (this.quizId) {
      this.quizService.loadResourcesForQuiz(this.quizId);
    }
    this.resources = this.quizService.resources;
    this.status = QuizStatus.COMPLETED;
    this.calculateElapsedTime();
    this.sendQuizStatusToQuizService();

    // Force change detection for OnPush when navigating back or tab switching
    this.cdRef.markForCheck();
    this.cdRef.detectChanges();
  }

  calculateElapsedTime(): void {
    const completionTime = this.quizMetadata().completionTime ?? 0;
    this.completionTimeSig.set(completionTime);
  }

  calculatePercentageOfCorrectlyAnsweredQuestions(): number {
    const total = this.quizService.totalQuestions;
    if (total === 0) return 0; // Prevent NaN

    return Math.round(
      (100 * this.quizService.correctAnswersCountSig()) / total
    );
  }

  private sendQuizStatusToQuizService(): void {
    this.quizService.setQuizStatus(this.status);
  }
}