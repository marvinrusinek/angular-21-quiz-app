import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
  viewChild,
  ViewEncapsulation
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router } from '@angular/router';

import { Option } from '../../../shared/models/Option.model';
import { QuizQuestion } from '../../../shared/models/QuizQuestion.model';

import { swallow } from '../../../shared/utils/error-logging';

import { AssessmentIntegrityService } from '../../../shared/services/features/interview/assessment-integrity.service';
import { InterviewSessionService } from '../../../shared/services/features/interview/interview-session.service';
import { InterviewTimerService } from '../../../shared/services/features/timer/interview-timer.service';
import { AssessmentIntegrityWarningDialogComponent } from '../../../components/dialogs/assessment-integrity-warning-dialog/assessment-integrity-warning-dialog.component';
import {
  KeyboardShortcutsDialogComponent,
  KeyboardShortcutsDialogData
} from '../../../components/dialogs/keyboard-shortcuts-dialog/keyboard-shortcuts-dialog.component';

import { InterviewPaginatorComponent } from '../../../components/interview/interview-paginator/interview-paginator.component';
import { InterviewOptionsComponent } from '../../../components/interview/interview-options/interview-options.component';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';
import {
  InterviewSubmitDialogComponent,
  InterviewSubmitDialogData
} from '../../../components/dialogs/interview-submit-dialog/interview-submit-dialog.component';

/**
 * Interview session shell.
 *
 * The question text is rendered directly inside the regular quiz question box
 * (the topic quizzes' `mat-card.quiz-card` container). We do NOT route it through
 * `codelab-quiz-content`: that heading component only produces text when the full
 * `codelab-quiz-question` pipeline runs alongside it (it reads shared state that
 * pipeline primes), and that pipeline can't drive a synthetic in-memory
 * assessment. Rendering the text directly guarantees it always shows; deferred
 * feedback means the heading is always the question text (never FET), by design.
 *
 * Options use InterviewOptionsComponent — native radio (single) / checkbox
 * (multiple), styled neutrally with correctness colors/icons/explanations
 * suppressed. Navigation moves the session index signal (no URL change).
 */
@Component({
  selector: 'codelab-interview-session',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatTooltipModule,
    InterviewPaginatorComponent,
    InterviewOptionsComponent,
    ThemeToggleComponent
  ],
  templateUrl: './interview-session.component.html',
  styleUrls: ['./interview-session.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewSessionComponent implements OnInit, OnDestroy {
  private readonly session = inject(InterviewSessionService);
  private readonly timer = inject(InterviewTimerService);
  private readonly integrity = inject(AssessmentIntegrityService);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject(ElementRef<HTMLElement>);

  // Focus is returned here when the keyboard-shortcuts dialog closes.
  private readonly shortcutsBtn = viewChild<ElementRef<HTMLButtonElement>>('shortcutsBtn');

  readonly currentIndex = this.session.currentIndex;
  readonly total = this.session.total;
  readonly answeredIndices = this.session.answeredIndices;

  // Assessment Integrity Mode (browser-based deterrent — Interview Mode only).
  readonly focusChanges = this.integrity.focusLossCount;
  readonly fullscreenSupported = this.integrity.fullscreenSupported();
  // Drives the "Full Screen Enabled" indicator; stays correct when the user
  // exits fullscreen with Esc/F11 rather than through the button.
  readonly isFullscreen = this.integrity.isFullscreen;
  private warningOpen = false;

  // Total-assessment countdown (calm typography, NOT the per-question Scoreboard).
  readonly timeRemaining = this.timer.formatted;
  readonly isLowTime = this.timer.isLowTime;

  // The "Show Results" (submit) affordance appears on the final question.
  readonly isLastQuestion = computed(
    () => this.total() > 0 && this.currentIndex() === this.total() - 1
  );

  constructor() {
    // Timer expiry → auto-submit ONCE, no confirmation. Set up before the timer
    // starts (in ngOnInit) so an expiry can never be missed.
    this.timer.expired$
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.submit(true));

    // When the user returns after a focus-loss with a pending warning, show the
    // (accessible, themed) warning dialog. The timer keeps running throughout.
    this.integrity.warningOnReturn$
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.openIntegrityWarning());
  }

  readonly currentQuestion = computed<QuizQuestion | null>(
    () => this.session.assessment()?.questions?.[this.currentIndex()] ?? null
  );

  readonly questionText = computed<string>(() => this.currentQuestion()?.questionText ?? '');
  readonly currentOptions = computed<Option[]>(() => this.currentQuestion()?.options ?? []);

  readonly selectedIds = computed<number[]>(
    () => this.session.answersByIndex()[this.currentIndex()] ?? []
  );

  ngOnInit(): void {
    if (!this.session.hasActiveSession()) {
      this.router.navigate(['/interview']);
      return;
    }
    this.session.activateDeferredFeedback();
    this.startTimer();

    // Assessment Integrity Mode (deterrent, Interview Mode only). A fresh start
    // resets the count; a resume keeps the restored count. Begin watching for
    // focus loss — listeners auto-clean on destroy via the DestroyRef.
    if (!this.session.wasRestored()) {
      this.integrity.reset();
    }
    this.integrity.activate(this.destroyRef);
    // Resumed with a warning still pending (focus lost, then refreshed) → surface
    // it now that the user is back.
    if (this.integrity.warningPending()) {
      this.openIntegrityWarning();
    }
  }

  ngOnDestroy(): void {
    // Stop the countdown, and — only when NOT submitted (i.e. the user abandoned
    // the assessment) — tear the session down + restore immediate feedback. On
    // submit, the data is kept for the Results page (submit() already reset the
    // feedback policy).
    this.timer.stop();
    if (this.session.status() !== 'submitted') {
      this.session.clear();
    }
    // Reset the integrity policy when leaving the assessment (the count was
    // already copied into the InterviewResult on submit). Listeners are removed
    // via the DestroyRef passed to activate().
    this.integrity.reset();
  }

  // Manual (early) submit — from the "Show Results" button. Confirms first. The
  // countdown is PAUSED while the dialog is open (the confirmation shouldn't cost
  // the user time) and resumed if they choose to continue.
  onShowResults(): void {
    if (this.session.status() !== 'active') return;
    this.timer.pause();

    const answered = this.answeredIndices().size;
    const ref = this.dialog.open<InterviewSubmitDialogComponent, InterviewSubmitDialogData, boolean>(
      InterviewSubmitDialogComponent,
      {
        width: '360px',
        panelClass: 'themed-confirm-dialog',
        autoFocus: 'dialog',
        data: {
          answered,
          unanswered: Math.max(0, this.total() - answered),
          timeRemaining: this.timeRemaining()
        }
      }
    );
    ref.afterClosed().subscribe((confirmed) => {
      if (confirmed) {
        this.submit(false);
      } else {
        // Continue Assessment (or dismissed) → resume the countdown and persist
        // the new expiry so a refresh keeps the correct remaining time.
        const expiresAt = this.timer.resume();
        this.session.setTiming(expiresAt, this.timer.durationSeconds);
      }
    });
  }

  // Finalize the assessment: stop the timer, score + store the result, and go to
  // the Results page. Idempotent via the status guard (a manual submit and a
  // timer-expiry submit racing produce exactly one result + navigation).
  private submit(byExpiry: boolean): void {
    if (this.session.status() !== 'active') return;
    const timeUsed = this.timer.elapsedSeconds();
    const timeRemaining = this.timer.remainingSeconds();
    this.timer.stop();
    // Copy the integrity focus-change count into the result (neutral info only —
    // never affects the score).
    this.session.submit(timeUsed, timeRemaining, byExpiry, this.integrity.focusLossCount());
    this.router.navigate(['/interview/results']);
  }

  // ── Assessment Integrity Mode ───────────────────────────────────
  // Show the accessible, themed warning once per return (no stacking). The timer
  // keeps running while it's open. On dismiss, clear the pending flag.
  private openIntegrityWarning(): void {
    if (this.warningOpen) return;
    this.warningOpen = true;
    const ref = this.dialog.open(AssessmentIntegrityWarningDialogComponent, {
      width: '360px',
      panelClass: 'themed-confirm-dialog',
      autoFocus: 'dialog',
      restoreFocus: true
    });
    ref.afterClosed().subscribe(() => {
      this.warningOpen = false;
      this.integrity.acknowledgeWarning();
    });
  }

  /**
   * Open the shared keyboard-shortcuts dialog in INTERVIEW mode. Same component,
   * config and design language as the topic-quiz header — only `data.mode`
   * differs, so the two surfaces never duplicate a template.
   *
   * Accessibility:
   *  - `autoFocus: 'dialog'` puts initial focus inside the dialog (on the
   *    container, so the title is announced rather than a button label).
   *  - MatDialog installs a focus trap; Tab/Shift+Tab stay within the dialog.
   *  - Escape closes it (MatDialog default).
   *  - `restoreFocus: true` returns focus to whatever was focused on open; the
   *    explicit refocus below guarantees it lands back on the shortcuts button
   *    even if something else moved focus while the dialog was open.
   *
   * Keyboard isolation: Interview Mode registers NO global key handler (unlike
   * the topic quiz's runOnGlobalKey), so there is nothing to switch off. The
   * focus trap is what keeps keystrokes — including the arrow keys that move
   * between radio options — from reaching the assessment behind the dialog.
   */
  openKeyboardShortcuts(): void {
    const ref = this.dialog.open(KeyboardShortcutsDialogComponent, {
      panelClass: 'keyboard-shortcuts-dialog',
      width: '90vw',
      maxWidth: '460px',
      autoFocus: 'dialog',
      restoreFocus: true,
      ariaLabelledBy: 'ksd-title',
      ariaDescribedBy: 'ksd-desc',
      // Material leaves this false by default; setting it makes assistive tech
      // treat the dialog as modal and ignore the assessment behind it.
      ariaModal: true,
      data: { mode: 'interview' } as KeyboardShortcutsDialogData
    });

    ref
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.shortcutsBtn()?.nativeElement?.focus());
  }

  // Optional, user-initiated fullscreen (browsers require a gesture). No-op if
  // unsupported/denied — the assessment works either way.
  enterFullscreen(): void {
    const el = document.documentElement ?? this.host.nativeElement;
    this.integrity.enterFullscreen(el).catch((err) => swallow('interview-session#enterFullscreen', err));
  }

  // Scoped copy deterrents — bound only to the assessment content box in the
  // template (never global). Do not block form controls, buttons, or navigation.
  blockCopy(event: Event): void {
    event.preventDefault();
  }

  // Start the total-assessment countdown once (survives question navigation).
  // Duration comes from the generated assessment; a `?interviewSeconds=` query
  // param overrides it so Playwright can exercise expiry without waiting 30 min.
  private startTimer(): void {
    const assessment = this.session.assessment();
    if (!assessment) return;

    if (this.session.wasRestored() && this.session.expiresAt() > 0) {
      // Resume after a refresh: restore the countdown from the persisted expiry
      // timestamp so the remaining time is correct (never reset to full). If it
      // already elapsed, the timer emits expiry → auto-submit.
      this.timer.restore(this.session.expiresAt(), this.session.timerDurationSeconds());
      return;
    }

    // Fresh start: begin the countdown and record its timing for resume.
    const duration = this.readDurationOverride() ?? assessment.durationSeconds;
    this.timer.start(duration);
    this.session.setTiming(this.timer.expiresAt, duration);
  }

  private readDurationOverride(): number | null {
    try {
      // Stashed by the builder from a `?interviewSeconds=` query param (test-only
      // hook so Playwright can exercise expiry without waiting the full duration).
      const raw = sessionStorage.getItem('__interviewSeconds');
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  // Paginator / prev / next → move the session index (no router navigation).
  // Bring the new question to the top (the user may have scrolled down).
  onNavigate(index: number): void {
    this.session.goTo(index);
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      swallow('interview-session#onNavigate', err);
    }
  }

  // Persist the current question's selection (drives the answered counter).
  onSelectionChange(optionIds: number[]): void {
    this.session.setAnswer(this.currentIndex(), optionIds);
  }
}
