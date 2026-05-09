import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, Input, OnChanges, OnInit, SimpleChanges, ViewEncapsulation, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatRadioModule } from '@angular/material/radio';
import { MatIconModule } from '@angular/material/icon';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { correctAnswerAnim } from '../../../../../animations/animations';
import { OptionBindings } from '../../../../../shared/models/OptionBindings.model';
import { FeedbackProps } from '../../../../../shared/models/FeedbackProps.model';
import { SharedOptionConfig } from '../../../../../shared/models/SharedOptionConfig.model';

import { HighlightOptionDirective } from '../../../../../directives/highlight-option.directive';
import { SharedOptionConfigDirective } from '../../../../../directives/shared-option-config.directive';

import { OptionService } from '../../../../../shared/services/options/view/option.service';
import { QuizService } from '../../../../../shared/services/data/quiz.service';
import { SelectedOptionService } from '../../../../../shared/services/state/selectedoption.service';
import { TimerService } from '../../../../../shared/services/features/timer/timer.service';

export type OptionUIEventKind = 'change' | 'interaction' | 'contentClick';

export interface OptionUIEvent {
  optionId: number;
  displayIndex: number;
  kind: OptionUIEventKind;
  inputType: 'radio' | 'checkbox';
  nativeEvent: any;
}

@Component({
  selector: 'app-option-item',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatCheckboxModule,
    MatRadioModule,
    MatIconModule,
    HighlightOptionDirective,
    SharedOptionConfigDirective
  ],
  templateUrl: './option-item.component.html',
  styleUrls: ['./option-item.component.scss'],
  encapsulation: ViewEncapsulation.None,
  animations: [correctAnswerAnim],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class OptionItemComponent implements OnChanges, OnInit {
  @Input() b!: OptionBindings;
  @Input() i!: number;
  readonly optionUI = output<OptionUIEvent>();  // ONE output
  readonly type = input<'single' | 'multiple'>('single');
  readonly form = input.required<FormGroup>();
  readonly shouldResetBackground = input(false);
  readonly feedbackConfig = input<FeedbackProps>();
  readonly sharedOptionConfig = input.required<SharedOptionConfig>();
  readonly currentQuestionIndex = input(0);
  readonly timerExpired = input(false);

  private _wasSelected = false;
  private _lastQuestionIndex = -1;
  // Tracks whether this component instance has seen a real user click.
  // Used to gate destructive visual-state clears in ngOnChanges: on
  // refresh the parent may briefly emit currentQuestionIndex=0 before
  // the real index resolves, and the second ngOnChanges would wipe the
  // refresh-restored state if we cleared unconditionally.
  private _userHasClicked = false;
  // Tracks whether the timer expired for the current question. Used to
  // clear timer-expiry highlighting on question change even when the
  // user never clicked an option (_userHasClicked is false).
  private _wasTimerExpired = false;
  // Direct timer expiry flag — set by subscribing to timerService.expired$
  // directly, bypassing the parent OnPush binding chain.
  private _directTimerExpired = false;
  private _directTimerExpiredForIndex = -1;

  private destroyRef = inject(DestroyRef);
  private cdRef = inject(ChangeDetectorRef);

  constructor(
    private optionService: OptionService,
    private quizService: QuizService,
    private selectedOptionService: SelectedOptionService,
    private timerService: TimerService
  ) {}

  ngOnInit(): void {
    this.timerService.expired$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this._directTimerExpired = true;
        this._directTimerExpiredForIndex = this.timerService.expiredForQuestionIndex;
        this.cdRef.markForCheck();
        this.cdRef.detectChanges();
      });

    // Re-check on every selection mutation. isDisabled() reads selections
    // and pristine corrects for multi-answer mode; without this, sibling
    // OnPush option-items don't re-evaluate when the user picks a new
    // option (their `b` input ref doesn't always change in the click path).
    this.selectedOptionService.selectedOptionsMap$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.applyMultiAnswerDisableState();
        this.cdRef.markForCheck();
        this.cdRef.detectChanges();
      });
  }

  // Computes the multi-answer disable state for this option from
  // pristine quiz data + currently saved selections, then writes it
  // onto b.disabled. Belt-and-suspenders alongside isDisabled():
  // legacy code paths read b.disabled directly, so keeping it in
  // sync ensures consistent state.
  private applyMultiAnswerDisableState(): void {
    try {
      if (!this.b?.option) return;
      const _qIdx = this.currentQuestionIndex() ?? this.quizService.currentQuestionIndex;

      const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
      const liveQT = nrm(
        (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[_qIdx]?.questionText
        ?? (this.quizService as any)?.questions?.[_qIdx]?.questionText
      );
      if (!liveQT) return;

      const bundle: any[] = (this.quizService as any)?.quizInitialState ?? [];
      let pristineCorrectTexts: Set<string> | null = null;
      for (const quiz of bundle) {
        let found = false;
        for (const pq of (quiz?.questions ?? [])) {
          if (nrm(pq?.questionText) !== liveQT) continue;
          pristineCorrectTexts = new Set(
            (pq?.options ?? [])
              .filter((o: any) =>
                o?.correct === true || String(o?.correct) === 'true' ||
                o?.correct === 1 || o?.correct === '1'
              )
              .map((o: any) => nrm(o?.text))
              .filter((t: string) => !!t)
          );
          found = true;
          break;
        }
        if (found) break;
      }
      if (!pristineCorrectTexts || pristineCorrectTexts.size < 2) return;

      const selectionsMap = this.selectedOptionService.selectedOptionsMapSig();
      const selections = selectionsMap.get(_qIdx) ?? [];
      const selectedTexts = new Set(
        selections.map((s: any) => nrm(s?.text)).filter((t: string) => !!t)
      );
      const allPristineCorrectSelected =
        [...pristineCorrectTexts].every(t => selectedTexts.has(t));

      if (!allPristineCorrectSelected) return;

      const myText = nrm(this.b.option.text);
      if (!selectedTexts.has(myText)) {
        this.b.disabled = true;
        if (this.b.option) (this.b.option as any).active = false;
      }
    } catch { /* never throw from a CD-triggered method */ }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['currentQuestionIndex']) {
      const nextQuestionIndex = Number(this.currentQuestionIndex() ?? -1);
      if (Number.isFinite(nextQuestionIndex) && nextQuestionIndex !== this._lastQuestionIndex) {
        // Clear stale visual state when navigating AWAY from a question.
        // Gate on _userHasClicked OR _wasTimerExpired so timer-expired
        // highlighting (correct answers revealed on timeout) is also
        // cleared when the user advances without having clicked.
        if (this._lastQuestionIndex !== -1 && (this._userHasClicked || this._wasTimerExpired)) {
          this._wasSelected = false;
          this._wasTimerExpired = false;
          this._directTimerExpired = false;
          this._directTimerExpiredForIndex = -1;
          if (this.b) {
            this.b.isSelected = false;
            this.b.disabled = false;
            this.b.cssClasses = {};
            if (this.b.option) {
              this.b.option.selected = false;
              this.b.option.highlight = false;
              this.b.option.showIcon = false;
            }
          }
          this._userHasClicked = false;
        }
        this._lastQuestionIndex = nextQuestionIndex;
      }
    }

    // Track timer expiry so we can clear highlighting on question change
    // even when the user never clicked an option.
    if (this.isTimerExpiredForThisQuestion() && !this._wasTimerExpired) {
      this._wasTimerExpired = true;
    }

    if (changes['shouldResetBackground'] && this.shouldResetBackground()) {
      this._wasSelected = false;
    }

    // Sticky: once selected, stays highlighted for the rest of the question.
    // GUARD: only latch during live interaction (_userHasClicked).
    // On refresh, transient init paths (processOptionBindings, generateOptionBindings)
    // can briefly set b.isSelected = true on options the user never clicked.
    // rehydrateUiFromState resets them, but ngOnChanges fires BEFORE rehydrate,
    // so _wasSelected would already be latched — causing ghost highlights
    // (e.g. 2nd correct answer in multi-answer). Gating on _userHasClicked
    // ensures only actual user clicks latch the highlight.
    if (this.b?.isSelected && this._userHasClicked) this._wasSelected = true;
  }

  /**
   * Authoritative timer-expired check: the `timerExpired` input may be
   * stale (set for Q1 but not yet cleared when Q2 renders). Cross-check
   * against TimerService.expiredForQuestionIndex so a stale input from
   * Q1 doesn't disable/highlight Q2's options.
   */
  private isTimerExpiredForThisQuestion(): boolean {
    const qIdx = this.currentQuestionIndex() ?? this.quizService.currentQuestionIndex;

    // Signal-based check: reading expiredForQuestionIndexSig() inside a
    // template-bound method lets Angular auto-track the dependency and
    // re-render this OnPush component when the signal changes.
    const expiredIdx = this.timerService.expiredForQuestionIndexSig();
    if (expiredIdx >= 0 && expiredIdx === qIdx) return true;

    // Direct subscription flag (belt-and-suspenders)
    if (this._directTimerExpired && this._directTimerExpiredForIndex === qIdx) {
      return true;
    }

    // Legacy fallback: parent input-based check
    if (!this.timerExpired()) return false;

    const expiredPlain = this.timerService.expiredForQuestionIndex;
    return expiredPlain < 0 || expiredPlain === qIdx;
  }

  get optionId(): number {
    return (this.b?.option?.optionId != null && this.b.option.optionId !== -1)
      ? Number(this.b.option.optionId) : this.i;
  }

  private get inputType(): 'radio' | 'checkbox' {
    return this.type() === 'multiple' ? 'checkbox' : 'radio';
  }

  getOptionDisplayText(): string {
    return this.optionService.getOptionDisplayText(this.b.option, this.i);
  }

  private isOptionCorrect(): boolean {
    const opt = this.b?.option as any;
    if (
      opt?.correct === true ||
      String(opt?.correct) === 'true' ||
      opt?.correct === 1 ||
      opt?.correct === '1' ||
      this.b?.isCorrect === true
    ) return true;

    // Fallback: check authoritative question data from quiz service.
    // Binding options may lack the `correct` flag after regeneration.
    const qIdx = this.currentQuestionIndex() ?? this.quizService.currentQuestionIndex;
    const question = (this.quizService as any).questions?.[qIdx];
    if (question?.options && opt?.text) {
      const optText = (opt.text as string).trim().toLowerCase();
      const match = question.options.find(
        (o: any) => o?.text && (o.text as string).trim().toLowerCase() === optText
      );
      if (match?.correct === true || String(match?.correct) === 'true') {
        return true;
      }
    }

    return false;
  }

  getOptionIcon(option?: any, i?: number): string {
    if (this.isTimerStamped()) {
      return this.isStampedCorrect() ? 'check' : 'close';
    }
    if (this.shouldShowFeedback() || this.shouldShowCorrectOnTimeout()) {
      return this.isOptionCorrect() ? 'check' : 'close';
    }
    return this.b.optionIcon || '';
  }

  getOptionClasses(): { [key: string]: boolean } {
    const classes = { ...this.b.cssClasses };

    // If the timer-expiry handler pre-stamped CSS classes on this binding
    // FOR THIS question, return them directly — do NOT let downstream
    // logic overwrite them. Stale stamps from a previous question fall
    // through to the normal class-derivation path.
    if (this.isTimerStamped()) return classes;

    if (this.isTimerExpiredForThisQuestion()) {
      // Preserve the user's selected state on timer expiry: a selected
      // wrong option must still paint red with its close icon.
      const wasSelected = this.b?.isSelected
        || !!this.b?.option?.highlight
        || this._wasSelected
        || this.isSelectedForCurrentQuestion();
      const showCorrect = this.shouldShowCorrectOnTimeout();
      classes['correct-option'] = showCorrect;
      classes['incorrect-option'] = wasSelected && !this.isOptionCorrect();
      return classes;
    }

    const isCorrect = this.isOptionCorrect();
    const shouldHighlight = this.shouldHighlightOption();

    if (shouldHighlight) {
      if (isCorrect) {
        classes['correct-option'] = true;
        classes['incorrect-option'] = false;
      } else {
        classes['incorrect-option'] = true;
        classes['correct-option'] = false;
      }
    } else {
      // Explicitly clear all highlight classes to prevent stale cssClasses from leaking
      classes['correct-option'] = false;
      classes['incorrect-option'] = false;
      classes['highlighted'] = false;
      classes['selected'] = false;
      classes['selected-option'] = false;
    }

    return classes;
  }

  getOptionCursor(): string {
    return this.b.optionCursor || 'default';
  }

  /**
   * True when this is a single-answer question, no correct option has been
   * selected yet, and this binding is not currently selected. Used to apply
   * the `.sa-trying` class which forces clear background + clickable cursor
   * and pointer-events:auto via SCSS, beating any Material-added disabled
   * styling that might leak through other code paths.
   */
  isSingleAnswerTrying(): boolean {
    // Lockstep with isDisabled(): a single-answer option that isn't
    // selected and isn't currently disabled is by definition "still
    // open for the user to try." Deriving it this way avoids drift
    // between two parallel implementations of "is the user mid-attempt."
    if (this.type() !== 'single') return false;
    if (this.b?.isSelected) return false;
    return !this.isDisabled();
  }

  /**
   * True when this option should render with the dark-gray locked-out
   * visual: not currently selected, AND isDisabled() says it's locked.
   * Drives the `.locked-option` CSS class — the SCSS gray rule keys off
   * that class instead of Material's mat-mdc-radio-disabled, so the
   * gray styling never depends on Material's class-application timing.
   */
  isVisuallyLocked(): boolean {
    if (this.b?.isSelected) return false;
    return this.isDisabled();
  }

  isDisabled(): boolean {
    // Timer-expiry handler stamped all bindings as disabled
    if (this.isTimerStamped()) return true;

    let _type = this.type();
    const _qIdx = this.currentQuestionIndex() ?? this.quizService.currentQuestionIndex;

    // RENDERING-LAYER PRISTINE GUARD: trust quizInitialState over the
    // [type] input binding. If pristine says this question has >1
    // correct option, force multi-mode regardless of what the parent
    // template passed. This catches cases where isMultiMode resolved
    // false in the template (e.g. Q2 of dependency-injection quiz)
    // due to mutated/missing live binding flags.
    if (_type !== 'multiple') {
      try {
        const nrmDis = (t: any) => String(t ?? '').trim().toLowerCase();
        const liveQT = nrmDis(this.b?.option?.text)
          ? nrmDis(
              (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[_qIdx]?.questionText
              ?? (this.quizService as any)?.questions?.[_qIdx]?.questionText
            )
          : '';
        if (liveQT) {
          const bundleDis: any[] = (this.quizService as any)?.quizInitialState ?? [];
          outerDis: for (const quizDis of bundleDis) {
            for (const pqDis of (quizDis?.questions ?? [])) {
              if (nrmDis(pqDis?.questionText) !== liveQT) continue;
              const pristineCC = (pqDis?.options ?? []).filter(
                (o: any) =>
                  o?.correct === true || String(o?.correct) === 'true' ||
                  o?.correct === 1 || o?.correct === '1'
              ).length;
              if (pristineCC > 1) _type = 'multiple';
              break outerDis;
            }
          }
        }
      } catch { /* ignore */ }
    }

    // For MULTIPLE mode, disable purely by data: when the user has
    // selected every pristine-correct option, every other (unselected,
    // incorrect) option becomes disabled. Reads selectedOptionsMapSig
    // directly so Angular's signal tracking auto-marks this OnPush
    // component dirty whenever selections mutate (no need for manual
    // markForCheck or input-ref-change tricks).
    if (_type === 'multiple') {
      if (this.isTimerExpiredForThisQuestion()) return true;

      const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
      const liveQT = nrm(
        (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[_qIdx]?.questionText
        ?? (this.quizService as any)?.questions?.[_qIdx]?.questionText
      );
      const bundle: any[] = (this.quizService as any)?.quizInitialState ?? [];
      let pristineCorrectTexts: Set<string> | null = null;
      if (liveQT) {
        outerVerify: for (const quiz of bundle) {
          for (const pq of (quiz?.questions ?? [])) {
            if (nrm(pq?.questionText) !== liveQT) continue;
            pristineCorrectTexts = new Set(
              (pq?.options ?? [])
                .filter((o: any) =>
                  o?.correct === true || String(o?.correct) === 'true' ||
                  o?.correct === 1 || o?.correct === '1'
                )
                .map((o: any) => nrm(o?.text))
                .filter((t: string) => !!t)
            );
            break outerVerify;
          }
        }
      }

      if (pristineCorrectTexts && pristineCorrectTexts.size > 0) {
        // Read the signal directly — registers as a template dependency
        // so this OnPush component re-renders when selections change.
        const selectionsMap = this.selectedOptionService.selectedOptionsMapSig();
        const selections = selectionsMap.get(_qIdx) ?? [];
        const selectedTexts = new Set(
          selections.map((s: any) => nrm(s?.text)).filter((t: string) => !!t)
        );
        const allPristineCorrectSelected =
          [...pristineCorrectTexts].every(t => selectedTexts.has(t));
        if (allPristineCorrectSelected) {
          const myText = nrm(this.b?.option?.text);
          return !selectedTexts.has(myText);
        }
      }

      // Fallback to the legacy flag path if pristine resolution failed
      // (no quizInitialState match, etc.).
      const perfectMap = 
        (this.quizService as any)?._multiAnswerPerfect as Map<number, boolean> | undefined;
      if (perfectMap?.get(_qIdx) === true && this.b?.disabled === true) {
        return true;
      }
      return false;
    }

    // In single-answer mode, correct options must stay clickable until the
    // correct answer has been selected (so user can recover from a wrong pick).
    const optCorrectFlag = this.b?.option?.correct ?? (this.b?.option as any)?.isCorrect;
    const thisIsCorrect = optCorrectFlag === true || String(optCorrectFlag) === 'true' || optCorrectFlag === 1 || optCorrectFlag === '1';

    if (thisIsCorrect) {
      // Only disable this correct option if a correct answer was already selected
      const clickConfirmed = this.selectedOptionService.clickConfirmedDotStatus.get(_qIdx);
      if (clickConfirmed !== 'correct') return false;
    }

    // SINGLE-ANSWER GUARD: if any sibling selection for the current question
    // is correct, lock every non-selected option. Strictly question-scoped via
    // questionIndex on the selection record, so navigation cannot leak.
    // Runs BEFORE the b.disabled early-return so a stale/incorrect b.disabled=true
    // flag (set by upstream pipelines that don't recompute on incorrect-only
    // single-answer clicks) doesn't lock the unclicked siblings — the user must
    // be able to recover from an incorrect pick by clicking another option.
    if (this.type() === 'single') {
      const qIdx = this.currentQuestionIndex() ?? this.quizService.currentQuestionIndex;
      // Read the signal directly — auto-tracks as a template dependency so
      // OnPush re-evaluates this method on every selection mutation.
      const selectionsMapSA = this.selectedOptionService.selectedOptionsMapSig();
      let selections: any[] = selectionsMapSA.get(qIdx) ?? [];
      if (selections.length === 0) {
        selections = this.selectedOptionService.getSelectedOptionsForQuestion(qIdx) ?? [];
      }
      if (selections.length === 0) {
        selections = this.selectedOptionService.getRefreshBackup(qIdx);
      }
      // Durable fallback: on navigate-away-and-back, single-answer clicks
      // may have trimmed the in-memory map to just the last click (or
      // cleared it entirely). The per-question sessionStorage key still
      // holds the merged history from saveState(), which is what we need
      // here to detect that a correct answer was already chosen so the
      // unclicked siblings stay locked (dark gray).
      // IMPORTANT: only read this fallback inside isDisabled() — do NOT
      // expose it through getSelectedOptionsForQuestion, otherwise the
      // highlight path would also see these entries and paint red on
      // the unclicked option.
      if (selections.length === 0) {
        try {
          const raw = sessionStorage.getItem('sel_Q' + qIdx);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
              selections = parsed as any[];
            }
          }
        } catch { /* ignore */ }
      }
      const filtered = selections.filter((s: any) => {
        const sQ = s?.questionIndex ?? s?.qIdx ?? s?.questionIdx;
        return sQ === undefined || sQ === null || sQ === -1 || Number(sQ) === Number(qIdx);
      });
      if (filtered.length === 0) return false;

      // Resolve correct flags from canonical question (use display order for shuffled mode)
      const isShuffled = this.quizService?.isShuffleEnabled?.()
        && Array.isArray((this.quizService as any)?.shuffledQuestions)
        && (this.quizService as any)?.shuffledQuestions?.length > 0;
      const canonicalQ: any = isShuffled
        ? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]
          ?? (this.quizService as any)?.shuffledQuestions?.[qIdx]
        : (this.quizService as any)?.questions?.[qIdx];
      const canonicalOpts: any[] = canonicalQ?.options ?? [];
      const isCorrectFlag = (v: any) => v === true || String(v) === 'true' || v === 1 || v === '1';

      const anyCorrectSelected = filtered.some((s: any) => {
        const sIdx = s?.displayIndex ?? s?.index ?? s?.idx;
        const sId = s?.optionId;
        // Match by canonical index
        if (typeof sIdx === 'number' && sIdx >= 0) {
          const co = canonicalOpts[sIdx];
          if (co && isCorrectFlag(co.correct ?? co.isCorrect)) return true;
        }
        // Or by id
        if (sId != null) {
          const co = canonicalOpts.find((o: any) => o?.optionId === sId);
          if (co && isCorrectFlag(co.correct ?? co.isCorrect)) return true;
        }
        // Or by selection record's own flag
        return isCorrectFlag(s?.correct ?? s?.isCorrect);
      });

      // No correct yet → all options remain clickable so the user can recover.
      // Do NOT consult b.disabled here; upstream pipelines occasionally leave
      // it stale on incorrect-only single-answer clicks (the lock policy
      // returns disabled=false but the WRITE site doesn't always reach it),
      // and honoring that flag is what was making the siblings appear locked.
      if (!anyCorrectSelected) return false;

      // Correct was selected: lock self unless this binding is the selected one.
      // Prev-clicked entries (selected:false + showIcon:true + highlight:true)
      // must NOT count as self-selected here — they represent the user's
      // earlier wrong click that should now render dark gray/disabled after
      // the correct answer has been chosen.
      const selfSelected = filtered.some((s: any) => {
        if (s?.selected === false) return false;
        const sIdx = s?.displayIndex ?? s?.index ?? s?.idx;
        if (typeof sIdx === 'number' && sIdx === this.i) return true;
        const sId = s?.optionId;
        return sId != null && this.b?.option?.optionId != null && String(sId) === String(this.b.option.optionId);
      });
      return !selfSelected;
    }

    if (this.b?.disabled === true) return true;

    return false;
  }

  /**
   * True when the timer-expiry handler pre-stamped this binding for the
   * CURRENT question. Stamps are scoped to the question index they were
   * applied for; a stale stamp from a previous question is ignored so
   * Q2's options don't inherit Q1's expired state.
   */
  private isTimerStamped(): boolean {
    const stamped = (this.b as any)?._timerExpiredStamped;
    if (!stamped) return false;

    const stampedFor = (this.b as any)?._timerExpiredStampedForIndex;
    if (stampedFor == null) return true;  // legacy stamps with no scope

    const qIdx = this.currentQuestionIndex() ?? this.quizService.currentQuestionIndex;
    return stampedFor === qIdx;
  }

  /** True when this binding was stamped as a correct option by the timer handler. */
  private isStampedCorrect(): boolean {
    return this.isTimerStamped() && this.b?.cssClasses?.['correct-option'] === true;
  }

  shouldShowIcon(option?: any, i?: number): boolean {
    if (this.isTimerStamped()) {
      if (this.isStampedCorrect()) return true;
      return !!this.b?.isSelected || this._wasSelected;
    }
    if (this.isTimerExpiredForThisQuestion()) {
      // Show icon for correct options AND for any option the user
      // actually selected (so a selected wrong answer keeps its X).
      if (this.shouldShowCorrectOnTimeout()) return true;
      return this.b?.isSelected
        || !!this.b?.option?.highlight
        || this._wasSelected
        || this.isSelectedForCurrentQuestion();
    }

    // Hard Guard: On refresh (user hasn't clicked), ONLY trust the
    // authoritative saved selection state. The binding flags
    // (highlight, showIcon, isSelected) can be transiently set by
    // processOptionBindings / synchronizeOptionBindings before
    // rehydrate clears them, causing a flash. _wasSelected is only
    // true after a live user click, so it's safe.
    if (!this._userHasClicked && !this._wasSelected) {
      // During LIVE interaction (user clicked a sibling, not this option),
      // the click pipeline (OIS/OUS/SOC backstop) authoritatively sets
      // b.option.showIcon=false on non-clicked, non-history options.
      // Trust that flag to prevent service-level false positives from
      // effectiveId collisions or stale entries.
      // On refresh/initial-load, showIcon is typically undefined (not
      // explicitly false), so the service check below still runs.
      if (this.b?.option?.showIcon === false) return false;

      // No live click this session → only show icon if a saved
      // selection actually matches this exact binding position.
      return this.isSelectedForCurrentQuestion();
    }

    const hasAnyPerBindingSignal =
      this.b?.option?.showIcon === true
      || this.b?.isSelected === true
      || !!this.b?.option?.highlight
      || this._wasSelected;
    if (!hasAnyPerBindingSignal) {
      if (this.b?.disabled === true) return false;
      if (!this.isSelectedForCurrentQuestion()) return false;
    }

    return this.shouldHighlightOption();
  }

  shouldShowCorrectOnTimeout(): boolean {
    if (!this.isTimerExpiredForThisQuestion()) return false;

    // When the timer expires, reveal ALL correct answers regardless of whether
    // they were flagged for icons or highlighted before.
    return this.isOptionCorrect();
  }

  getOptionBackgroundColor(): string | null {
    // Timer-expiry handler stamped this binding — use stamped classes for color
    if (this.isTimerStamped()) {
      if (this.isStampedCorrect()) return '#43e756';
      const wasSelected = this.b?.isSelected || this._wasSelected;
      return wasSelected && !this.isStampedCorrect() ? '#ff0000' : null;
    }
    if (this.isTimerExpiredForThisQuestion()) {
      if (this.shouldShowCorrectOnTimeout()) return '#43e756';
      // Keep the user's wrong selection red on timer expiry.
      const wasSelected = this.b?.isSelected
        || !!this.b?.option?.highlight
        || this._wasSelected
        || this.isSelectedForCurrentQuestion();
      return wasSelected && !this.isOptionCorrect() ? '#ff0000' : null;
    }

    const _sh = this.shouldHighlightOption();
    if (!_sh) {
      // Single-answer suppression: while no correct option has been selected
      // for this question, never gray any non-selected option. Upstream
      // pipelines occasionally leak b.disabled=true onto previously-clicked
      // and never-clicked single-answer bindings, which would otherwise
      // paint them gray after the user picks a 2nd incorrect option. The
      // user must remain free to keep trying with a clear visual state.
      const _qIdxSA = this.currentQuestionIndex() ?? this.quizService.currentQuestionIndex;
      if (this.type() === 'single' && !this.b?.isSelected) {
        const nrmSA = (t: any) => String(t ?? '').trim().toLowerCase();
        const liveQTSA = nrmSA(
          (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[_qIdxSA]?.questionText
          ?? (this.quizService as any)?.questions?.[_qIdxSA]?.questionText
        );
        const bundleSA: any[] = (this.quizService as any)?.quizInitialState ?? [];
        let pristineCorrectTextsSA: Set<string> | null = null;
        if (liveQTSA) {
          outerSA: for (const qSA of bundleSA) {
            for (const pqSA of (qSA?.questions ?? [])) {
              if (nrmSA(pqSA?.questionText) !== liveQTSA) continue;
              pristineCorrectTextsSA = new Set(
                (pqSA?.options ?? [])
                  .filter((o: any) =>
                    o?.correct === true || String(o?.correct) === 'true' ||
                    o?.correct === 1 || o?.correct === '1'
                  )
                  .map((o: any) => nrmSA(o?.text))
                  .filter((t: string) => !!t)
              );
              break outerSA;
            }
          }
        }
        if (pristineCorrectTextsSA && pristineCorrectTextsSA.size === 1) {
          const selectionsMapSA = this.selectedOptionService.selectedOptionsMapSig();
          const selectionsSA = selectionsMapSA.get(_qIdxSA) ?? [];
          const noCorrectSelectedSA = !selectionsSA.some((s: any) => {
            const txt = nrmSA(s?.text);
            return !!txt && pristineCorrectTextsSA!.has(txt);
          });
          if (noCorrectSelectedSA) return null;
        }
      }

      // Dark gray for disabled unselected options (e.g. remaining
      // incorrect after all correct answers selected in multi-answer)
      if (this.b?.disabled && !this.b?.isSelected) return '#a0a0a0';

      // Multi-answer data-driven gray: when the user has selected every
      // pristine-correct option for this question, every unselected
      // (incorrect) option goes gray. Mirrors the isDisabled() check so
      // visuals stay in lockstep without depending on _multiAnswerPerfect
      // or b.disabled flags being set in sync.
      if (this.type() === 'multiple' && !this.b?.isSelected) {
        const _qIdx = this.currentQuestionIndex() ?? this.quizService.currentQuestionIndex;
        const nrmBg = (t: any) => String(t ?? '').trim().toLowerCase();
        const liveQTBg = nrmBg(
          (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[_qIdx]?.questionText
          ?? (this.quizService as any)?.questions?.[_qIdx]?.questionText
        );
        const bundleBg: any[] = (this.quizService as any)?.quizInitialState ?? [];
        let pristineCorrectTextsBg: Set<string> | null = null;
        if (liveQTBg) {
          outerBg: for (const qBg of bundleBg) {
            for (const pqBg of (qBg?.questions ?? [])) {
              if (nrmBg(pqBg?.questionText) !== liveQTBg) continue;
              pristineCorrectTextsBg = new Set(
                (pqBg?.options ?? [])
                  .filter((o: any) =>
                    o?.correct === true || String(o?.correct) === 'true' ||
                    o?.correct === 1 || o?.correct === '1'
                  )
                  .map((o: any) => nrmBg(o?.text))
                  .filter((t: string) => !!t)
              );
              break outerBg;
            }
          }
        }
        if (pristineCorrectTextsBg && pristineCorrectTextsBg.size > 0) {
          // Read the signal directly so OnPush auto-tracks selection changes.
          const selectionsMapBg = this.selectedOptionService.selectedOptionsMapSig();
          const selectionsBg = selectionsMapBg.get(_qIdx) ?? [];
          const selectedTextsBg = new Set(
            selectionsBg.map((s: any) => nrmBg(s?.text)).filter((t: string) => !!t)
          );
          const allPristineCorrectSelectedBg =
            [...pristineCorrectTextsBg].every(t => selectedTextsBg.has(t));
          const myTextBg = nrmBg(this.b?.option?.text);
          if (allPristineCorrectSelectedBg && !selectedTextsBg.has(myTextBg)) {
            return '#a0a0a0';
          }
        }
        // Legacy flag fallback
        const perfectMap =
          (this.quizService as any)?._multiAnswerPerfect as Map<number, boolean> | undefined;
        if (perfectMap?.get(_qIdx) === true && !this.isOptionCorrect()) {
          return '#a0a0a0';
        }
      }
      return null;
    }

    // Green if correct, red if incorrect
    return this.isOptionCorrect() ? '#43e756' : '#ff0000';
  }

  private getSelectionsForCurrentBinding(): any[] {
    let qIndex = this.currentQuestionIndex() ?? this.quizService.currentQuestionIndex;

    // On page refresh, the input signal and quiz service may both
    // still be 0 (BehaviorSubject default) before the route resolver
    // updates them with the URL-derived index. Fall back to the URL
    // so saved selections for Q2+ are found on first render.
    if (qIndex === 0) {
      try {
        const m = window.location.pathname.match(/\/question\/[^/]+\/(\d+)/);
        if (m) {
          const urlIdx = Number(m[1]) - 1;
          if (Number.isFinite(urlIdx) && urlIdx > 0) qIndex = urlIdx;
        }
      } catch { /* ignore */ }
    }

    const selections = this.selectedOptionService.getSelectedOptionsForQuestion(qIndex) ?? [];
    if (selections.length > 0) return selections;
    
    // Visual-only fallback: check refresh backup for highlight/disable state
    return this.selectedOptionService.getRefreshBackup(qIndex);
  }

  private matchesBindingSelection(sel: any): boolean {
    let qIndex =
      this.currentQuestionIndex() ?? this.quizService.currentQuestionIndex;

    // Same URL fallback as getSelectionsForCurrentBinding — on refresh
    // the input may still be 0 before the route resolves.
    if (qIndex === 0) {
      try {
        const m = window.location.pathname.match(/\/question\/[^/]+\/(\d+)/);
        if (m) {
          const urlIdx = Number(m[1]) - 1;
          if (Number.isFinite(urlIdx) && urlIdx > 0) qIndex = urlIdx;
        }
      } catch { /* ignore */ }
    }

    const selQIdx =
      sel.questionIndex ?? (sel as any).qIdx ?? (sel as any).questionIdx;

    // Strict Question Context Check
    if (selQIdx !== undefined && selQIdx !== null && selQIdx !== -1) {
      if (Number(selQIdx) !== qIndex) return false;
    }

    // Saved record must represent an actual selection. `selected: false`
    // is an unselect trace — ignore it so a never-clicked binding that
    // happens to share an index with an unselect entry never lights up.
    // EXCEPTION: entries with explicit showIcon/highlight are previously-
    // clicked wrong options saved by the correct-click handler — they
    // MUST match so the red+X icon restores on refresh.
    if (sel?.selected === false && !sel?.showIcon && !sel?.highlight) {
      return false;
    }

    // TEXT MATCH (most reliable — immune to synthetic ID mismatches
    // and index collisions from different init paths).
    const selText = ((sel as any)?.text ?? '').trim().toLowerCase();
    const bText = (this.b?.option?.text ?? '').trim().toLowerCase();
    if (selText && bText) return selText === bText;

    // Prefer `displayIndex` — that's what setSelectedOption enriches with
    // and it is stable across refresh. `sel.index` can be a stale legacy
    // field with an unrelated value (e.g. an array position), causing a
    // false positive against this binding's `this.i`. Fall back to
    // `index`/`idx` only when displayIndex is missing.
    const rawIdx =
      sel?.displayIndex ?? (sel as any)?.index ?? (sel as any)?.idx;
    const normalizedSelectedIndex =
      rawIdx != null && Number.isFinite(Number(rawIdx)) ? Number(rawIdx) : null;

    if (normalizedSelectedIndex != null) {
      if (normalizedSelectedIndex !== this.i) return false;

      // Position matches — cross-check optionId to prevent false
      // positives when options reload in a different order or when
      // stale displayIndex values leak from a prior session.
      const selId = sel?.optionId;
      const bId = this.b?.option?.optionId;
      const selIdIsReal =
        selId != null && selId !== -1 && String(selId) !== '-1';
      const bIdIsReal =
        bId != null && bId !== -1 && String(bId) !== '-1';
      return !selIdIsReal || !bIdIsReal || String(selId) === String(bId);
    }

    // Fallback: match by optionId only when no index data exists on the
    // selection record (e.g. refresh-backup data after deserialization).
    // Require a real, non-sentinel id on BOTH sides so that multiple
    // bindings sharing a -1/null optionId don't all match the same record.
    const selId = sel?.optionId;
    const bId = this.b?.option?.optionId;
    const selIdIsReal =
      selId != null && selId !== -1 && String(selId) !== '-1';
    const bIdIsReal =
      bId != null && bId !== -1 && String(bId) !== '-1';
    return selIdIsReal && bIdIsReal && String(selId) === String(bId);
  }

  shouldShowFeedback(): boolean {
    if (this.isTimerStamped()) return true;
    return this.shouldHighlightOption() || this.shouldShowCorrectOnTimeout();
  }

  onChanged(event: any): void {
    this._userHasClicked = true;
    this.optionUI.emit({
      optionId: this.optionId,
      displayIndex: this.i,
      kind: 'change',
      inputType: this.inputType,
      nativeEvent: event
    });
  }

  onContentClick(event: MouseEvent): void {
    event.stopPropagation();  // prevents double firing with parent (click)
    this._userHasClicked = true;
    this.optionUI.emit({
      optionId: this.optionId,
      displayIndex: this.i,
      kind: 'contentClick',
      inputType: this.inputType,
      nativeEvent: event
    });
  }

  shouldHighlightOption(): boolean {
    // Catch in-place mutations from rehydrateUiFromState that bypass
    // ngOnChanges (same object reference, no @Input change detected).
    // Only latch if (a) the user has actually clicked, or (b) the
    // binding's selection is confirmed by authoritative saved state.
    // Without the guard, transient b.isSelected from stale option.selected
    // data latches _wasSelected and bypasses the refresh guard below.
    if (this.b?.isSelected && !this._wasSelected) {
      if (this._userHasClicked || this.isSelectedForCurrentQuestion()) {
        this._wasSelected = true;
      }
    }

    // On refresh (no live click), ONLY trust authoritative saved
    // selection state — not binding flags which can be transiently
    // stale from processOptionBindings / hydrateOptions / setOptionBindingsIfChanged.
    if (!this._userHasClicked && !this._wasSelected) {
      // During live interaction, trust the binding's highlight flag
      // when explicitly false — prevents service-level false positives.
      if (this.b?.option?.highlight === false) return false;
      
      return this.isSelectedForCurrentQuestion();
    }

    if (this.type() === 'multiple') {
      // For multi-answer, trust the sharedOptionConfig as the final authority.
      // The config uses the durableSet (actual user clicks) to determine
      // highlight eligibility. Without this guard, transient binding state
      // from intermediate change-detection cycles can latch _wasSelected
      // on options the user never clicked (e.g. the 2nd correct answer).
      const cfg = this.sharedOptionConfig();
      if (cfg?.option && !cfg.option.highlight && !cfg.isOptionSelected) {
        return false;
      }
      return this.isOptionIndividuallySelected() || !!this.b.option?.highlight ||
        this._wasSelected;
    }
    return this.b.isSelected || !!this.b.option?.highlight || this._wasSelected
      || this.isSelectedForCurrentQuestion();
  }

  private isOptionIndividuallySelected(): boolean {
    return (
      this.b.isSelected ||
      this.b.checked ||
      this.b.option?.selected === true ||
      this.isSelectedForCurrentQuestion()
    );
  }

  private isSelectedForCurrentQuestion(): boolean {
    const selections = this.getSelectionsForCurrentBinding();
    return selections.some((s: any) => this.matchesBindingSelection(s));
  }
}