import { computed, inject, Injectable, OnDestroy, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Subject, Subscription, timer } from 'rxjs';
import { finalize, takeUntil, tap } from 'rxjs/operators';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { readSessionJson } from '../../../utils/session-storage';
import { isOptionCorrect } from '../../../utils/is-option-correct';

interface StopTimerAttemptOptions {
  questionIndex?: number,
  optionsSnapshot?: Option[],
  onBeforeStop?: () => void,
  onStop?: (elapsedMs?: number) => void  // allow elapsed to be delivered
}

@Injectable({ providedIn: 'root' })
export class TimerService implements OnDestroy {
  timePerQuestion = 30;
  completionTime = Number(sessionStorage.getItem('completionTime')) || 0;
  elapsedTimes: number[] = readSessionJson<number[]>('elapsedTimes', []);

  isTimerRunning = false;  // tracks whether the timer is currently running
  isTimerStoppedForCurrentQuestion = false;
  stoppedForQuestion = new Set<number>();

  // Signals
  private isStop = new Subject<void>();

  // Signal-first sources of truth
  readonly elapsedTimeSig = signal<number>(0);
  public elapsedTime$ = toObservable(this.elapsedTimeSig);

  private static _initTimerType(): 'countdown' | 'stopwatch' {
    try {
      return localStorage.getItem('timerType') === 'stopwatch'
        ? 'stopwatch' : 'countdown';
    } catch {
      return 'countdown';
    }
  }
  readonly timerTypeSig = signal<'countdown' | 'stopwatch'>(TimerService._initTimerType());
  public timerType$ = toObservable(this.timerTypeSig);
  /** Derived from timerTypeSig — single source of truth. */
  readonly isCountdown = computed(() => this.timerTypeSig() === 'countdown');

  readonly stopSig = signal<number>(0);
  public stop$ = toObservable(this.stopSig);

  private timerSubscription: Subscription | null = null;
  private stopTimerSignalSubscription: Subscription | null = null;

  private expiredSubject = new Subject<void>();
  public expired$ = this.expiredSubject.asObservable();

  private _authoritativeStop = false;
  private hasExpiredForRun = false;
  /** Signal version â€” read this in OnPush templates so Angular auto-tracks it. */
  public readonly expiredForQuestionIndexSig = signal(-1);

  private quizService = inject(QuizService);
  private selectedOptionService = inject(SelectedOptionService);

  constructor() {
    this.setupTimer();
    this.listenForCorrectSelections();
  }

  private setupTimer(): void {
    this.stopTimerSignalSubscription =
      this.selectedOptionService.stopTimer$.subscribe(() => {
        if (!this.isTimerRunning) return;
        this.stopTimer(undefined, { force: true });
      });
  }

  ngOnDestroy(): void {
    this.timerSubscription?.unsubscribe();
    this.stopTimerSignalSubscription?.unsubscribe();
  }

  private listenForCorrectSelections(): void {
    this.stopTimerSignalSubscription =
      this.selectedOptionService.stopTimer$.subscribe(() => {
        if (!this.isTimerRunning) return;
        this.handleStopTimerSignal();
      });
  }

  private handleStopTimerSignal(): void {
    if (!this.isTimerRunning) return;

    const activeQuestionIndex = this.normalizeQuestionIndex(
      this.quizService?.currentQuestionIndex
    );
    if (activeQuestionIndex < 0) {
      this.stopTimer(undefined, { force: true });
      return;
    }

    // Must grant authority before calling attemptStopTimerForQuestion
    this._authoritativeStop = true;

    const stopped = this.attemptStopTimerForQuestion({
      questionIndex: activeQuestionIndex,
      onStop: (elapsed?: number) => {
        if (elapsed != null && activeQuestionIndex != null) {
          console.log('[TIMER-DIAG] capture(handleStopTimerSignal) idx=', activeQuestionIndex, 'elapsed=', elapsed);
          this.elapsedTimes[activeQuestionIndex] = elapsed;
          this.saveTimerState();
        }
      }
    });

    if (!stopped) this.stopTimer(undefined, { force: true });
  }

  setTimerType(type: 'countdown' | 'stopwatch'): void {
    if (this.timerTypeSig() === type) return;

    this.timerTypeSig.set(type);
    try {
      localStorage.setItem('timerType', type);
    } catch {
      // ignore storage failures
    }
  }

  // Starts the timer
  startTimer(
    duration: number = this.timePerQuestion,
    isCountdown: boolean = true,
    forceRestart: boolean = false
  ): void {
    console.log('[TIMER-DIAG] startTimer called currentIdx=', this.quizService?.currentQuestionIndex,
      'forceRestart=', forceRestart, 'isTimerRunning=', this.isTimerRunning,
      'isStoppedForCurrent=', this.isTimerStoppedForCurrentQuestion, 'hasExpired=', this.hasExpiredForRun);
    if (this.isTimerStoppedForCurrentQuestion && !forceRestart) return;

    // Anti-thrash: ignore any (re)start that happens within 5s of a previous
    // start, regardless of running state. The init chain repeatedly fires
    // stop+start; suppressing the duplicates lets the tick stream survive.
    const nowMs = Date.now();
    // Once expired for this question, refuse all further starts until
    // restartForQuestion is called for a new question.
    if (this.hasExpiredForRun) return;
    
    if (this._lastStartedAtMs > 0 && (nowMs - this._lastStartedAtMs) < this.timePerQuestion * 1000) {
      // Re-arm running flag in case a rogue stop slipped through
      if (!this.isTimerRunning && this.timerSubscription) {
        this.isTimerRunning = true;
      }
      return;
    }

    if (this.isTimerRunning) {
      if (!forceRestart) return;  // prevent restarting an already running timer
      this.stopTimer(undefined, { force: true });
    }
    this._lastStartedAtMs = nowMs;

    if (forceRestart) this.isTimerStoppedForCurrentQuestion = false;

    this.isTimerRunning = true;  // mark timer as running
    this.hasExpiredForRun = false;

    // Show initial value immediately
    this.elapsedTimeSig.set(0);

    // Start ticking after 1s so the initial value stays visible for a second
    const timer$ = timer(1000, 1000).pipe(
      tap((tick) => {
        // Tick starts at 0 after 1s â†’ elapsed = tick + 1 (1,2,3,â€¦)
        const elapsed = tick + 1;

        this.elapsedTimeSig.set(elapsed);

        // If reached the duration, emit expiration once (stop only for countdown)
        if (elapsed >= duration && !this.hasExpiredForRun) {
          this.hasExpiredForRun = true;
          this.expiredForQuestionIndexSig.set(this.quizService.currentQuestionIndex);
          this.expiredSubject.next();
          if (isCountdown) this.stopTimer(undefined, { force: true });
        }
      }),
      takeUntil(this.isStop),
      finalize(() => {
        this.isTimerRunning = false;
      })
    );

    this.timerSubscription = timer$.subscribe();
  }

  // Stops the timer
  stopTimer(
    callback?: (elapsedTime: number) => void,
    options: { force?: boolean; bypassAntiThrash?: boolean } = {}
  ): void {
    // Authoritative Stop Guard: Blocks rogue direct calls
    if (!options.force && !this._authoritativeStop) return;

    // Reset authority immediately to prevent re-entry / double stop paths
    this._authoritativeStop = false;

    void options;  // prevent unused-parameter warning (intentional)

    if (!this.isTimerRunning) return;

    // Anti-thrash: ignore stops fired immediately after a fresh start
    // (init-chain churn). Only honor stops once the timer has had a chance
    // to actually tick, OR if expiry has been reached.
    const sinceStart = Date.now() - this._lastStartedAtMs;
    if (sinceStart < this.timePerQuestion * 1000 && !this.hasExpiredForRun && !options.bypassAntiThrash) {
      return;
    }

    // End the ticking subscription
    if (this.timerSubscription) {
      this.timerSubscription.unsubscribe();
      this.timerSubscription = null;
    }

    this.isTimerRunning = false;  // mark the timer as stopped
    this.isTimerStoppedForCurrentQuestion = true;  // prevent restart for current question
    this.stopSig.update(v => v + 1);  // emit stop signal to stop the timer
    this.isStop.next();

    if (callback) callback(this.elapsedTimeSig());
  }

  // Resets the timer
  resetTimer(): void {

    // Anti-thrash: ignore resets after a start is in flight or after expiry,
    // until restartForQuestion explicitly clears the flags for a new question.
    if (this.hasExpiredForRun) return;

    const sinceStart = Date.now() - this._lastStartedAtMs;
    if (this._lastStartedAtMs > 0 && sinceStart < this.timePerQuestion * 1000) {
      return;
    }

    if (this.isTimerRunning) this.stopTimer(undefined, { force: true });

    this.isTimerRunning = false;
    this.isTimerStoppedForCurrentQuestion = false;  // allow restart for the new question
    this.hasExpiredForRun = false;

    this.elapsedTimeSig.set(0);  // reset elapsed time for observers
  }

  public attemptStopTimerForQuestion(
    options: StopTimerAttemptOptions = {}
  ): boolean {
    // Guard: NOTHING may stop the timer without authority
    if (!this._authoritativeStop) return false;

    const questionIndex = this.normalizeQuestionIndex(
      typeof options.questionIndex === 'number'
        ? options.questionIndex
        : this.quizService?.currentQuestionIndex
    );

    if (questionIndex == null || questionIndex < 0) return false;

    // If we get here, all correct answers are selected.
    // Mark this question as stopped FIRST so subsequent restartForQuestion
    // re-emits bail out, regardless of whether the underlying stopTimer
    // path runs (it may early-return when the timer isn't running, or be
    // rejected by anti-thrash without bypass).
    this.selectedOptionService.stopTimerEmitted = true;
    this.isTimerStoppedForCurrentQuestion = true;
    this.stoppedForQuestion.add(questionIndex);

    // If the timer isn't running, nothing to stop
    if (!this.isTimerRunning) {
      return true;  // return true since the answer is correct, even if timer isn't running
    }

    // Fire sound (or any UX) BEFORE stopping so teardown doesn't stop it
    try {
      options.onBeforeStop?.();
    } catch { }

    try {
      // Stop the timer with force AND bypass anti-thrash. Anti-thrash
      // exists to absorb init-chain churn; an explicit stop after a
      // correct-answer click is intentional and must not be ignored
      // even if the click lands within the original start window.
      this.stopTimer(options.onStop, { force: true, bypassAntiThrash: true });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stops the timer if the answer conditions are met.
   *
   * Single-answer â†’ stop when the clicked option is correct.
   * Multiple-answer â†’ stop when all correct answers are selected.
   */
  public async stopTimerIfApplicable(
    question: QuizQuestion,
    questionIndex: number,
    selectedOptionsFromQQC: Array<SelectedOption | Option> | null
  ): Promise<void> {
    try {
      // Basic validation
      if (this.isTimerStoppedForCurrentQuestion) return;
      if (!question || !Array.isArray(question.options)) return;

      const normalizedIndex = this.normalizeQuestionIndex(questionIndex);
      if (normalizedIndex < 0) return;

      // Determine correct answers
      const correctOptions = question.options.filter((opt) => opt.correct);
      const correctOptionIds = correctOptions.map((opt) => String(opt.optionId));
      const isMultiple = correctOptionIds.length > 1;

      // Build SELECTED set
      //  - For MULTIPLE: prefer SelectedOptionService
      //  - For SINGLE: use QQC payload
      let selectedOptionsFinal: Array<SelectedOption | Option> = [];

      if (isMultiple) {
        // pull from SelectedOptionService for this question
        const fromStore =
          this.selectedOptionService?.getSelectedOptionsForQuestion(
            normalizedIndex
          ) ?? [];

        if (fromStore.length > 0) {
          selectedOptionsFinal = fromStore;
        } else {
          selectedOptionsFinal = selectedOptionsFromQQC ?? [];
        }
      } else {
        // single-answer: payload is fine
        selectedOptionsFinal = selectedOptionsFromQQC ?? [];
      }

      const selectedIds = selectedOptionsFinal.map((o) =>
        String((o as any).optionId ?? '')
      );

      let shouldStop = false;

      // MULTIPLE-ANSWER LOGIC (match computeCorrectness)
      if (isMultiple) {
        const selectedSet = new Set(selectedIds);

        const selectedCorrectCount = correctOptionIds.filter((id) =>
          selectedSet.has(id)
        ).length;

        // Exact match: all and only correct options selected
        shouldStop =
          correctOptionIds.length > 0 &&
          selectedCorrectCount === correctOptionIds.length;
      }

      // Single-answer logic
      else {
        const firstSelected = selectedOptionsFinal[0] as any;
        const isCorrect = isOptionCorrect(firstSelected);
        shouldStop = isCorrect;
      }

      // Stop timer if conditions met
      if (!shouldStop) return;

      const stopped = this.attemptStopTimerForQuestion({
        questionIndex: normalizedIndex,
        onStop: (elapsed?: number) => {
          if (elapsed != null) {
            console.log('[TIMER-DIAG] capture(stopTimerIfApplicable) idx=', normalizedIndex, 'elapsed=', elapsed);
            this.elapsedTimes[normalizedIndex] = elapsed;
            this.saveTimerState();
          }
        }
      });

      if (!stopped) this.stopTimer(undefined, { force: true });
    } catch {
      // stopTimerIfApplicable failed
    }
  }

  public stopTimerForQuestion(questionIndex: number): void {
    const idx = this.normalizeQuestionIndex(questionIndex);
    if (idx < 0) return;

    // Prevent double-stops
    if (this.isTimerStoppedForCurrentQuestion) return;

    // Authoritative Stop â€” grant authority immediately before stopping
    this._authoritativeStop = true;

    const stopped = this.attemptStopTimerForQuestion({
      questionIndex: idx,
      onStop: (elapsed?: number) => {
        if (elapsed != null) {
          console.log('[TIMER-DIAG] capture(stopTimerForQuestion) idx=', idx, 'elapsed=', elapsed);
          this.elapsedTimes[idx] = elapsed;
          this.saveTimerState();
        }
      }
    });

    if (!stopped) {
      // Force is allowed, but stopTimer() will still clear authority
      this.stopTimer(undefined, { force: true });
    }
  }

  /**
   * Convenience: stop, reset, clear flags, and start a fresh timer for a question.
   * Consolidates the 4-step pattern used across QuizComponent navigation paths.
   */
  private _runningForQuestion: number | null = null;
  private _lastStartedAtMs = 0;

  public restartForQuestion(questionIndex: number): void {
    // Block re-entry if this question is already running, expired, or
    // was already stopped via a correct-answer click. Without the
    // stoppedForQuestion check, a downstream re-emit of the same
    // question payload would clear _lastStartedAtMs and fully restart
    // the timer from 0 on an already-answered question.
    if (
      this._runningForQuestion === questionIndex &&
      (this.isTimerRunning || this.hasExpiredForRun || this.stoppedForQuestion.has(questionIndex))
    ) {
      return;
    }

    // Correctly-answered questions don't re-run their timer — freeze at the
    // recorded seconds-remaining instead. Gate ONLY on the durable dot-status
    // (a selection-based check falsely fires for unanswered questions that
    // hold stale selections, freezing them at a bogus value).
    if (this.selectedOptionService?.clickConfirmedDotStatus?.get?.(questionIndex) === 'correct') {
      this.freezeAtRecordedTime(questionIndex);
      return;
    }

    this._runningForQuestion = questionIndex;
    // Clear expiry/start guards so this fresh question can run
    this.hasExpiredForRun = false;
    this.expiredForQuestionIndexSig.set(-1);
    this._lastStartedAtMs = 0;
    this.stopTimer?.(undefined, { force: true });
    this.resetTimer();
    this.resetTimerFlagsFor(questionIndex);
    this.startTimer(this.timePerQuestion, this.isCountdown(), true);
  }

  // Freeze the timer at the time recorded when the question was answered, so a
  // revisited answered question shows the (frozen) time taken rather than a
  // fresh countdown. Falls back to 0-remaining (elapsed = full) when no time
  // was captured (e.g. after a hard refresh that clears in-memory elapsedTimes).
  public freezeAtRecordedTime(questionIndex: number): void {
    if (questionIndex == null || questionIndex < 0) return;

    // Tear down any active tick subscription DIRECTLY — stopTimer's authority
    // and anti-thrash guards can no-op here (e.g. right after a fresh start),
    // which would leave the countdown ticking past the frozen value.
    if (this.timerSubscription) {
      this.timerSubscription.unsubscribe();
      this.timerSubscription = null;
    }
    this.isTimerRunning = false;
    this.isTimerStoppedForCurrentQuestion = true;  // prevent non-forced restart
    this.hasExpiredForRun = false;
    this._runningForQuestion = questionIndex;
    this.stoppedForQuestion.add(questionIndex);

    // Only paint the recorded seconds-remaining when we actually have a
    // positive recorded time. No bogus 0:00 fallback — leave the current
    // display untouched if nothing was captured (the timer is still stopped).
    const taken = this.elapsedTimes[questionIndex];
    console.log('[TIMER-DIAG] freezeAtRecordedTime idx=', questionIndex,
      'elapsedTimes[idx]=', taken, 'timePerQuestion=', this.timePerQuestion,
      '=> display=', (typeof taken === 'number' && taken > 0) ? Math.max(this.timePerQuestion - taken, 0) : '(unchanged)',
      'currentElapsedSig=', this.elapsedTimeSig());
    if (typeof taken === 'number' && taken > 0) {
      this.elapsedTimeSig.set(taken);
    }
  }

  public resetTimerFlagsFor(questionIndex: number): void {
    if (questionIndex == null || questionIndex < 0) return;

    this.isTimerStoppedForCurrentQuestion = false;

    if (this.selectedOptionService) {
      this.selectedOptionService.stopTimerEmitted = false;
    }

    this.stoppedForQuestion.delete(questionIndex);
  }

  public async requestStopEvaluationFromClick(
    questionIndex: number,
    _selectedOption: SelectedOption | null
  ): Promise<void> {
    const normalizedIndex = this.normalizeQuestionIndex(questionIndex);
    const q = this.quizService?.questions?.[normalizedIndex];
    if (!q) return;

    // Always convert SelectedOption â†’ SelectedOption[]
    const selectedOptionsArray =
      this.selectedOptionService.getSelectedOptionsForQuestion(normalizedIndex);

    // Now fully valid call
    await this.stopTimerIfApplicable(q, normalizedIndex, selectedOptionsArray);
  }

  public calculateTotalElapsedTime(elapsedTimes: number[]): number {
    if (!elapsedTimes || !Array.isArray(elapsedTimes)) return 0;

    try {
      const total = elapsedTimes.reduce((acc: number, cur: number) => {
        // Ensure both values are valid numbers
        const a = typeof acc === 'number' ? acc : 0;
        const c = typeof cur === 'number' ? cur : 0;
        return a + c;
      }, 0);

      this.completionTime = total;
      this.saveTimerState();
      return total;
    } catch {
      return 0;
    }
  }

  private normalizeQuestionIndex(index: number | null | undefined): number {
    if (!Number.isFinite(index as number)) return -1;

    const normalized = Math.trunc(index as number);
    const questions = this.quizService?.questions;

    if (!Array.isArray(questions) || questions.length === 0) return normalized;
    if (questions[normalized] != null) return normalized;

    const potentialOneBased = normalized - 1;
    if (
      potentialOneBased >= 0 &&
      potentialOneBased < questions.length &&
      questions[potentialOneBased] != null
    ) {
      return potentialOneBased;
    }

    return Math.min(Math.max(normalized, 0), questions.length - 1);
  }

  public allowAuthoritativeStop(): void {
    this._authoritativeStop = true;
  }

  private saveTimerState(): void {
    try {
      sessionStorage.setItem('elapsedTimes', JSON.stringify(this.elapsedTimes));
      sessionStorage.setItem('completionTime', String(this.completionTime));
    } catch {
      // ignore
    }
  }

  public clearTimerState(): void {
    this.elapsedTimes = [];
    this.completionTime = 0;
    try {
      sessionStorage.removeItem('elapsedTimes');
      sessionStorage.removeItem('completionTime');
    } catch {
      // ignore
    }
  }
}