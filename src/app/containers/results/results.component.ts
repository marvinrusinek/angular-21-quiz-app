import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, computed, DestroyRef,
  effect, HostListener, inject, OnInit, signal
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { CommonModule, NgOptimizedImage } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { take } from 'rxjs/operators';

import { QuizStatus } from '../../shared/models/quiz-status.enum';

import { SK_DOT_CONFIRMED, SK_SEL_Q, SK_SELECTED_OPTIONS_MAP, SK_SHUFFLED_QUESTIONS } from '../../shared/constants/session-keys';

import { FinalResult, ScoreAnalysisItem } from '../../shared/models/Final-Result.model';
import { Quiz } from '../../shared/models/Quiz.model';
import { QuizQuestion } from '../../shared/models/QuizQuestion.model';

import { QuizDataService } from '../../shared/services/data/quizdata.service';
import { QuizDotStatusService } from '../../shared/services/flow/quiz-dot-status.service';
import { QuizService } from '../../shared/services/data/quiz.service';
import { QuizStateService } from '../../shared/services/state/quizstate.service';
import { SelectedOptionService } from '../../shared/services/state/selectedoption.service';
import { ThemeService } from '../../shared/services/ui/theme.service';

import { AccordionComponent } from './accordion/accordion.component';
import { BackToTopComponent } from '../../components/back-to-top/back-to-top.component';
import { ChallengeComponent } from './challenge/challenge.component';
import { ReturnComponent } from './return/return.component';
import { StatisticsComponent } from './statistics/statistics.component';
import { SummaryReportComponent } from './summary-report/summary-report.component';

import { getQuizData } from '../../shared/quiz-data-cache';

@Component({
  selector: 'codelab-quiz-results',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatExpansionModule,
    MatIconModule,
    MatTooltipModule,
    NgOptimizedImage,
    BackToTopComponent,
    AccordionComponent,
    ChallengeComponent,
    ReturnComponent,
    StatisticsComponent,
    SummaryReportComponent
  ],
  templateUrl: './results.component.html',
  styleUrls: ['./results.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ResultsComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly dotStatusService = inject(QuizDotStatusService);
  private readonly quizDataService = inject(QuizDataService);
  private readonly quizService = inject(QuizService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly themeService = inject(ThemeService);
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly cdRef = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  // ── remaining variables ─────────────────────────────────────────
  readonly quizData: Quiz[] = getQuizData();
  readonly quizId = signal('');
  readonly indexOfQuizId = signal(0);
  readonly detailedSummaryQuestions = signal<QuizQuestion[]>([]);
  readonly headerLabel = signal('');

  readonly menuOpen = signal(false);
  readonly activeSection = signal<
    'score' | 'report' | 'summary' | 'highscores' | 'resources'
  >(this.restoreActiveSection());

  readonly finalResult = signal<FinalResult | null>(null);
  readonly scoreAnalysis = computed<ScoreAnalysisItem[]>(
    () => this.finalResult()?.analysis ?? []
  );

  readonly showScrollIndicator = signal(true);

  // Tracks whether ngOnInit already applied a synchronous snapshot, so the
  // finalResult$ effect skips re-applying when the observable later emits.
  private readonly hasSnapshot = signal(false);
  private readonly finalResultStream = toSignal(
    this.quizService.finalResult$,
    { initialValue: null as FinalResult | null }
  );

  constructor() {
    effect(() => {
      if (this.hasSnapshot()) return;
      const r = this.finalResultStream();
      if (!r) return;
      if (r.quizId) this.quizId.set(r.quizId);
      this.finalResult.set(r);
      this.applyFinalResultSnapshot(r);
      this.updateHeaderLabel(r.total);
      this.persistResultsToSession(r);
    });
  }

  ngOnInit(): void {
    window.scrollTo(0, 0);
    this.quizDataService.loadQuizzes().pipe(take(1)).subscribe();
    this.fetchQuizIdFromParams();
    this.setCompletedQuiz();
    this.findQuizIndex();

    this.detailedSummaryQuestions.set(
      this.quizService.getQuestionsInDisplayOrder()
    );

    this.updateHeaderLabel(
      this.quizService.totalQuestions() || this.detailedSummaryQuestions().length
    );

    // Try in-memory snapshot first
    let snapshot = this.quizService.getFinalResultSnapshot();

    // If no snapshot exists, build one from current service state
    if (!snapshot && this.quizService.totalQuestions() > 0) {
      const correct = this.quizService.correctAnswersCountSig();
      const total = this.quizService.totalQuestions();
      snapshot = {
        quizId: this.quizId() || this.quizService.quizId,
        correct,
        total,
        percentage: total > 0 ? Math.round((correct / total) * 100) : 0,
        analysis: [],
        completedAt: Date.now()
      };
    }

    if (snapshot) {
      this.hasSnapshot.set(true);
      if (snapshot.quizId) {
        this.quizId.set(snapshot.quizId);
      }
      this.finalResult.set(snapshot);
      this.applyFinalResultSnapshot(snapshot);
      this.updateHeaderLabel(snapshot.total);
      this.persistResultsToSession(snapshot);
    }
    // No snapshot: the constructor effect picks up finalResult$ emissions.
  }

  @HostListener('window:scroll', [])
  onWindowScroll(): void {
    this.showScrollIndicator.set(window.scrollY < 100);
  }

  toggleMenu(): void {
    this.menuOpen.update(prev => !prev);
  }

  closeMenu(): void {
    this.menuOpen.set(false);
  }

  setActiveSection(section: 'score' | 'report' | 'summary' | 'highscores' | 'resources'): void {
    this.activeSection.set(section);
    try { sessionStorage.setItem('resultsActiveSection', section); } catch {}
    this.closeMenu();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.cdRef.markForCheck();
  }

  selectQuiz(): void {
    const quizId = this.quizId() || this.quizService.quizId || '';

    // Only mark as completed (checkmark) if score is 100%
    const snapshot = this.finalResult();
    const isPerfect = snapshot && snapshot.total > 0 && snapshot.correct === snapshot.total;
    if (quizId) {
      try {
        if (isPerfect) {
          const existing = JSON.parse(sessionStorage.getItem('completedQuizIds') || '[]');
          if (!existing.includes(quizId)) {
            existing.push(quizId);
          }
          sessionStorage.setItem('completedQuizIds', JSON.stringify(existing));
        } else {
          const existing = JSON.parse(sessionStorage.getItem('startedQuizIds') || '[]');
          if (!existing.includes(quizId)) {
            existing.push(quizId);
          }
          sessionStorage.setItem('startedQuizIds', JSON.stringify(existing));
        }
      } catch {}
    }

    // Clear quiz status set by setCompletedQuiz() so non-perfect quizzes
    // don't show as completed on the selection screen
    if (quizId) {
      if (isPerfect) {
        this.quizDataService.updateQuizStatus(quizId, QuizStatus.COMPLETED);
      } else {
        this.quizDataService.updateQuizStatus(quizId, QuizStatus.STARTED);
      }
    }
    this.quizService.setCompletedQuizId(isPerfect ? quizId : '');
    this.quizService.quizCompleted = !!isPerfect;

    this.quizService.resetAll();
    this.quizService.resetQuestions();

    // Clear all in-memory dot/selection state
    this.dotStatusService.clearAllMaps();
    this.selectedOptionService.lastClickedCorrectByQuestion.clear();
    this.selectedOptionService.clearAllSelectionsForQuiz(quizId);
    this.selectedOptionService.clearRefreshBackup();
    this.selectedOptionService.clickConfirmedDotStatus.clear();
    this.quizStateService._answeredQuestionIndices?.clear();
    this.quizStateService._hasUserInteracted?.clear();

    // Signal to quiz component that this is a fresh start from results
    try { sessionStorage.setItem('freshStartFromResults', 'true'); } catch {}

    // Nuclear: wipe ALL quiz-related sessionStorage and localStorage
    try {
      for (let i = 0; i < 100; i++) {
        sessionStorage.removeItem(SK_SEL_Q + i);
        sessionStorage.removeItem(SK_DOT_CONFIRMED + i);
      }
      sessionStorage.removeItem('rawSelectionsMap');
      sessionStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
      sessionStorage.removeItem('selectionHistory');
      sessionStorage.removeItem('finalResult');
      sessionStorage.removeItem('resultsActiveSection');

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
      localStorage.removeItem('questionCorrectness');
      localStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
      localStorage.removeItem('userAnswers');
      localStorage.removeItem(SK_SHUFFLED_QUESTIONS);
    } catch {}

    // Reset to light mode when leaving results
    if (this.themeService.isDark()) {
      this.themeService.toggle();
    }

    this.quizId.set('');
    this.indexOfQuizId.set(0);
    this.router.navigate(['/select/']);
  }

  scrollDown(): void {
    window.scrollBy({ top: 500, behavior: 'smooth' });
  }

  private restoreActiveSection(): 'score' | 'report' | 'summary' | 'highscores' | 'resources' {
    try {
      const stored = sessionStorage.getItem('resultsActiveSection');
      if (stored === 'score' || stored === 'report' || stored === 'summary' || stored === 'highscores' || stored === 'resources') {
        return stored;
      }
    } catch {}
    return 'score';
  }

  private fetchQuizIdFromParams(): void {
    this.activatedRoute.paramMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const routeQuizId = params.get('quizId');
        if (routeQuizId) {
          this.quizId.set(routeQuizId);
          this.setCompletedQuiz();
          this.findQuizIndex();
          this.cdRef.markForCheck();
        }
      });
  }

  private setCompletedQuiz(): void {
    const id = this.quizId();
    if (id) {
      this.quizService.setCompletedQuizId(id);
      this.quizService.setQuizId(id);  // ensure service has correct ID for high scores
      this.quizService.setQuizStatus(QuizStatus.COMPLETED);

      // Update the quiz object's status so QuizSelectionComponent can show the icon
      this.quizDataService.updateQuizStatus(id, QuizStatus.COMPLETED);
    }
  }

  private findQuizIndex(): void {
    const id = this.quizId();
    if (id) {
      this.indexOfQuizId.set(
        this.quizData.findIndex((elem) => elem.quizId === id)
      );
    }
  }

  private applyFinalResultSnapshot(snapshot: FinalResult): void {
    this.quizService.totalQuestions.set(snapshot.total);
    this.quizService.sendCorrectCountToResults(snapshot.correct);
  }

  private updateHeaderLabel(totalQuestions: number): void {
    const questionCount = Number.isFinite(totalQuestions) && totalQuestions > 0
      ? totalQuestions
      : this.detailedSummaryQuestions().length;

    this.headerLabel.set(
      this.quizService.isShuffleEnabled()
        ? `${questionCount} questions, SHUFFLED`
        : `${questionCount} questions`
    );
  }

  private persistResultsToSession(result: FinalResult): void {
    try {
      sessionStorage.setItem('finalResult', JSON.stringify(result));
    } catch {}
  }
}
