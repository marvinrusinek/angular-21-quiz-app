import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef,
  effect, inject, input, OnInit, output, ViewEncapsulation
} from '@angular/core';
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
export class OptionItemComponent implements OnInit {
  readonly optionUI = output<OptionUIEvent>();
  readonly binding = input.required<OptionBindings>();
  readonly displayIndex = input.required<number>();
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
  // Direct timer expiry flag â€” set by subscribing to timerService.expired$
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
  ) {
    // Question-change cleanup. Replaces the prior ngOnChanges
    // `changes['currentQuestionIndex']` block â€” necessary because
    // currentQuestionIndex is now a signal input and signal-input
    // changes don't fire ngOnChanges.
    effect(() => {
      const nextQuestionIndex = Number(this.currentQuestionIndex() ?? -1);
      if (!Number.isFinite(nextQuestionIndex) ||
          nextQuestionIndex === this._lastQuestionIndex) return;
      // Clear stale visual state when navigating AWAY from a question.
      // Gate on _userHasClicked OR _wasTimerExpired so timer-expired
      // highlighting (correct answers revealed on timeout) is also
      // cleared when the user advances without having clicked.
      if (this._lastQuestionIndex !== -1 &&
          (this._userHasClicked || this._wasTimerExpired)) {
        this._wasSelected = false;
        this._wasTimerExpired = false;
        this._directTimerExpired = false;
        this._directTimerExpiredForIndex = -1;
        const b = this.binding();
        if (b) {
          b.isSelected = false;
          b.disabled = false;
          b.cssClasses = {};
          if (b.option) {
            b.option.selected = false;
            b.option.highlight = false;
            b.option.showIcon = false;
          }
        }
        this._userHasClicked = false;
      }
      this._lastQuestionIndex = nextQuestionIndex;
    });

    // shouldResetBackground reset. Truthy â†’ clear sticky highlight latch.
    effect(() => {
      if (this.shouldResetBackground()) this._wasSelected = false;
    });

    // Latch timer expiry so the question-change effect's cleanup branch
    // also clears timer-expired highlighting when the user advances
    // without ever having clicked an option.
    effect(() => {
      // Touch the timerExpired input so this effect re-runs on changes.
      this.timerExpired();
      if (this.isTimerExpiredForThisQuestion() && !this._wasTimerExpired) {
        this._wasTimerExpired = true;
      }
    });

    // Sticky highlight latch. Once the binding's isSelected goes true
    // during a live interaction (_userHasClicked), keep _wasSelected true
    // for the rest of the question. _userHasClicked guard prevents
    // transient init paths (processOptionBindings, generateOptionBindings)
    // from latching highlights on options the user never clicked.
    effect(() => {
      if (this.binding()?.isSelected && this._userHasClicked) {
        this._wasSelected = true;
      }
    });

    // Re-check on every selection mutation. isDisabled() reads selections
    // and pristine corrects for multi-answer mode; without this, sibling
    // OnPush option-items don't re-evaluate when the user picks a new
    // option (their `b` input ref doesn't always change in the click path).
    effect(() => {
      this.selectedOptionService.selectedOptionsMapSig();
      this.applyMultiAnswerDisableState();
      this.cdRef.markForCheck();
      this.cdRef.detectChanges();
    });
  }

  ngOnInit(): void {
    this.timerService.expired$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this._directTimerExpired = true;
        this._directTimerExpiredForIndex = this.timerService.expiredForQuestionIndexSig();
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
      if (!this.binding()?.option) return;
      const _qIdx = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();

      const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
      const liveQT =
        (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[_qIdx]?.questionText
        ?? (this.quizService as any)?.questions?.[_qIdx]?.questionText;
      const pristineCorrectTexts =
        this.quizService.getPristineCorrectTextsForQuestion(liveQT);
      if (pristineCorrectTexts.size < 2) return;

      const selectionsMap = this.selectedOptionService.selectedOptionsMapSig();
      const selections = selectionsMap.get(_qIdx) ?? [];
      const selectedTexts = new Set(
        selections.map((s: any) => nrm(s?.text)).filter((t: string) => !!t)
      );
      const allPristineCorrectSelected =
        [...pristineCorrectTexts].every(t => selectedTexts.has(t));

      if (!allPristineCorrectSelected) return;

      const myText = nrm(this.binding().option.text);
      if (!selectedTexts.has(myText)) {
        this.binding().disabled = true;
        if (this.binding().option) (this.binding().option as any).active = false;
      }
    } catch { /* never throw from a CD-triggered method */ }
  }


  /**
   * Authoritative timer-expired check: the `timerExpired` input may be
   * stale (set for Q1 but not yet cleared when Q2 renders). Cross-check
   * against TimerService.expiredForQuestionIndex so a stale input from
   * Q1 doesn't disable/highlight Q2's options.
   */
  private isTimerExpiredForThisQuestion(): boolean {
    const qIdx = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();

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

    const expiredPlain = this.timerService.expiredForQuestionIndexSig();
    return expiredPlain < 0 || expiredPlain === qIdx;
  }

  get optionId(): number {
    return (this.binding()?.option?.optionId != null && this.binding().option.optionId !== -1)
      ? Number(this.binding().option.optionId) : this.displayIndex();
  }

  private get inputType(): 'radio' | 'checkbox' {
    return this.type() === 'multiple' ? 'checkbox' : 'radio';
  }

  getOptionDisplayText(): string {
    return this.optionService.getOptionDisplayText(this.binding().option, this.displayIndex());
  }

  private isOptionCorrect(): boolean {
    const opt = this.binding()?.option as any;
    if (
      opt?.correct === true ||
      String(opt?.correct) === 'true' ||
      opt?.correct === 1 ||
      opt?.correct === '1' ||
      this.binding()?.isCorrect === true
    ) return true;

    // Fallback: check authoritative question data from quiz service.
    // Binding options may lack the `correct` flag after regeneration.
    const qIdx = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
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

  getOptionIcon(_option?: any, _i?: number): string {
    // AUTO-REVEAL backup: persistent custom flag wins over any state that
    // might wipe option.showIcon (mirrors the backup in
    // getOptionBackgroundColor that paints the green background).
    if ((this.binding() as any)?._autoRevealedCorrect === true ||
        (this.binding()?.option as any)?._autoRevealedCorrect === true) {
      return 'check';
    }
    if (this.isTimerStamped()) {
      return this.isStampedCorrect() ? 'check' : 'close';
    }
    if (this.shouldShowFeedback() || this.shouldShowCorrectOnTimeout()) {
      return this.isOptionCorrect() ? 'check' : 'close';
    }
    return this.binding().optionIcon || '';
  }

  getOptionClasses(): { [key: string]: boolean } {
    const classes = { ...this.binding().cssClasses };

    // If the timer-expiry handler pre-stamped CSS classes on this binding
    // FOR THIS question, return them directly â€” do NOT let downstream
    // logic overwrite them. Stale stamps from a previous question fall
    // through to the normal class-derivation path.
    if (this.isTimerStamped()) return classes;

    if (this.isTimerExpiredForThisQuestion()) {
      // Preserve the user's selected state on timer expiry: a selected
      // wrong option must still paint red with its close icon.
      const wasSelected = this.binding()?.isSelected
        || !!this.binding()?.option?.highlight
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
    return this.binding().optionCursor || 'default';
  }

  isDisabled(): boolean {
    // Timer-expiry handler stamped all bindings as disabled
    if (this.isTimerStamped()) return true;

    let _type = this.type();
    const _qIdx = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();

    // RENDERING-LAYER PRISTINE GUARD: trust quizInitialState over the
    // [type] input binding. If pristine says this question has >1
    // correct option, force multi-mode regardless of what the parent
    // template passed. This catches cases where isMultiMode resolved
    // false in the template (e.g. Q2 of dependency-injection quiz)
    // due to mutated/missing live binding flags.
    if (_type !== 'multiple' && this.binding()?.option?.text) {
      const liveQT =
        (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[_qIdx]?.questionText
        ?? (this.quizService as any)?.questions?.[_qIdx]?.questionText;
      const pristineCC =
        this.quizService.getPristineCorrectTextsForQuestion(liveQT).size;
      if (pristineCC > 1) _type = 'multiple';
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
      const pristineCorrectTexts =
        this.quizService.getPristineCorrectTextsForQuestion(liveQT);

      if (pristineCorrectTexts.size > 0) {
        // Read the signal directly â€” registers as a template dependency
        // so this OnPush component re-renders when selections change.
        const selectionsMap = this.selectedOptionService.selectedOptionsMapSig();
        const selections = selectionsMap.get(_qIdx) ?? [];
        const selectedTexts = new Set(
          selections.map((s: any) => nrm(s?.text)).filter((t: string) => !!t)
        );
        const allPristineCorrectSelected =
          [...pristineCorrectTexts].every(t => selectedTexts.has(t));
        if (allPristineCorrectSelected) {
          const myText = nrm(this.binding()?.option?.text);
          return !selectedTexts.has(myText);
        }
      }

      // Fallback to the legacy flag path if pristine resolution failed
      // (no quizInitialState match, etc.).
      const perfectMap = 
        (this.quizService as any)?._multiAnswerPerfect as Map<number, boolean> | undefined;
      if (perfectMap?.get(_qIdx) === true && this.binding()?.disabled === true) {
        return true;
      }
      return false;
    }

    // SINGLE-ANSWER MODE â€” single, direct rule:
    //   Lock = NOT-selected AND a pristine-correct option is already selected
    //          for this question.
    // The currently-selected option is never disabled.
    // While no correct option has been selected, every option stays clickable.
    if (this.binding()?.isSelected) return false;

    const qIdx = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
    // Read signal directly â€” OnPush auto-tracks selection mutations.
    const selectionsMapSig = this.selectedOptionService.selectedOptionsMapSig();
    const selections = selectionsMapSig.get(qIdx) ?? [];
    if (selections.length === 0) return false;

    // Resolve pristine correct texts for this question via questionText match
    // against quizInitialState (immutable structuredClone of QUIZ_DATA).
    const nrmSA = (t: any) => String(t ?? '').trim().toLowerCase();
    const isShufSA = this.quizService?.isShuffleEnabled?.()
      && Array.isArray((this.quizService as any)?.shuffledQuestions)
      && (this.quizService as any)?.shuffledQuestions?.length > 0;
    const liveSAQ: any = isShufSA
      ? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]
        ?? (this.quizService as any)?.shuffledQuestions?.[qIdx]
      : (this.quizService as any)?.questions?.[qIdx];
    const correctTextsSA =
      this.quizService.getPristineCorrectTextsForQuestion(liveSAQ?.questionText);

    // Lock as soon as the selection record itself is flagged correct, OR
    // its text matches a pristine correct text. The flag fallback covers
    // the case where the cache lookup misses (stale questionText / wrong
    // qIdx). Selection records are spread from the binding option which
    // carries `correct: true` for the canonical correct option from JSON.
    const hasCorrectSelection = selections.some((s: any) => {
      if (s?.correct === true || String(s?.correct) === 'true' ||
          s?.correct === 1 || s?.correct === '1') {
        return true;
      }
      return correctTextsSA.has(nrmSA(s?.text));
    });
    return hasCorrectSelection;
  }

  /**
   * True when the timer-expiry handler pre-stamped this binding for the
   * CURRENT question. Stamps are scoped to the question index they were
   * applied for; a stale stamp from a previous question is ignored so
   * Q2's options don't inherit Q1's expired state.
   */
  private isTimerStamped(): boolean {
    const stamped = (this.binding() as any)?._timerExpiredStamped;
    if (!stamped) return false;

    const stampedFor = (this.binding() as any)?._timerExpiredStampedForIndex;
    if (stampedFor == null) return true;  // legacy stamps with no scope

    const qIdx = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
    return stampedFor === qIdx;
  }

  /** True when this binding was stamped as a correct option by the timer handler. */
  private isStampedCorrect(): boolean {
    return this.isTimerStamped() && this.binding()?.cssClasses?.['correct-option'] === true;
  }

  shouldShowIcon(_option?: any, _i?: number): boolean {
    // AUTO-REVEAL backup: persistent custom flag wins over downstream
    // pipelines that wipe option.showIcon back to false (mirrors the
    // backup in getOptionBackgroundColor that paints the green background).
    if ((this.binding() as any)?._autoRevealedCorrect === true ||
        (this.binding()?.option as any)?._autoRevealedCorrect === true) {
      return true;
    }
    if (this.isTimerStamped()) {
      if (this.isStampedCorrect()) return true;
      return !!this.binding()?.isSelected || this._wasSelected;
    }
    if (this.isTimerExpiredForThisQuestion()) {
      // Show icon for correct options AND for any option the user
      // actually selected (so a selected wrong answer keeps its X).
      if (this.shouldShowCorrectOnTimeout()) return true;
      return this.binding()?.isSelected
        || !!this.binding()?.option?.highlight
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
      if (this.binding()?.option?.showIcon === false) return false;

      // No live click this session â†’ only show icon if a saved
      // selection actually matches this exact binding position.
      return this.isSelectedForCurrentQuestion();
    }

    const hasAnyPerBindingSignal =
      this.binding()?.option?.showIcon === true
      || this.binding()?.isSelected === true
      || !!this.binding()?.option?.highlight
      || this._wasSelected;
    if (!hasAnyPerBindingSignal) {
      if (this.binding()?.disabled === true) return false;
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
    // Timer-expiry handler stamped this binding â€” use stamped classes for color
    if (this.isTimerStamped()) {
      if (this.isStampedCorrect()) return '#43e756';
      const wasSelected = this.binding()?.isSelected || this._wasSelected;
      return wasSelected && !this.isStampedCorrect() ? '#ff0000' : null;
    }
    if (this.isTimerExpiredForThisQuestion()) {
      if (this.shouldShowCorrectOnTimeout()) return '#43e756';
      // Keep the user's wrong selection red on timer expiry.
      const wasSelected = this.binding()?.isSelected
        || !!this.binding()?.option?.highlight
        || this._wasSelected
        || this.isSelectedForCurrentQuestion();
      return wasSelected && !this.isOptionCorrect() ? '#ff0000' : null;
    }

    // AUTO-REVEAL backup: persistent custom flag wins over any state that
    // might cause shouldHighlightOption() to return false. Paints green
    // directly via inline style.
    if ((this.binding() as any)?._autoRevealedCorrect === true ||
        (this.binding()?.option as any)?._autoRevealedCorrect === true) {
      return '#43e756';
    }
    if (this.isOptionCorrect()) {
      const _qIdxARBg = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
      const perfectMapARBg =
        (this.quizService as any)?._multiAnswerPerfect as Map<number, boolean> | undefined;
      if (perfectMapARBg?.get(_qIdxARBg) === true ||
          this.binding()?.cssClasses?.['correct-option'] === true) {
        return '#43e756';
      }
    }

    const _sh = this.shouldHighlightOption();
    if (!_sh) {
      // Single-answer suppression: while no correct option has been selected
      // for this question, never gray any non-selected option. Upstream
      // pipelines occasionally leak b.disabled=true onto previously-clicked
      // and never-clicked single-answer bindings, which would otherwise
      // paint them gray after the user picks a 2nd incorrect option. The
      // user must remain free to keep trying with a clear visual state.
      const _qIdxSA = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
      if (this.type() === 'single' && !this.binding()?.isSelected) {
        const nrmSA = (t: any) => String(t ?? '').trim().toLowerCase();
        const liveQTSA =
          (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[_qIdxSA]?.questionText
          ?? (this.quizService as any)?.questions?.[_qIdxSA]?.questionText;
        const pristineCorrectTextsSA =
          this.quizService.getPristineCorrectTextsForQuestion(liveQTSA);
        if (pristineCorrectTextsSA.size === 1) {
          const selectionsMapSA = this.selectedOptionService.selectedOptionsMapSig();
          const selectionsSA = selectionsMapSA.get(_qIdxSA) ?? [];
          const noCorrectSelectedSA = !selectionsSA.some((s: any) => {
            const txt = nrmSA(s?.text);
            return !!txt && pristineCorrectTextsSA.has(txt);
          });
          if (noCorrectSelectedSA) return null;
        }
      }

      // Dark gray for disabled unselected options (e.g. remaining
      // incorrect after all correct answers selected in multi-answer)
      if (this.binding()?.disabled && !this.binding()?.isSelected) return '#a0a0a0';

      // Multi-answer data-driven gray: when the user has selected every
      // pristine-correct option for this question, every unselected
      // (incorrect) option goes gray. Mirrors the isDisabled() check so
      // visuals stay in lockstep without depending on _multiAnswerPerfect
      // or b.disabled flags being set in sync.
      if (this.type() === 'multiple' && !this.binding()?.isSelected) {
        const _qIdx = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
        const nrmBg = (t: any) => String(t ?? '').trim().toLowerCase();
        const liveQTBg =
          (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[_qIdx]?.questionText
          ?? (this.quizService as any)?.questions?.[_qIdx]?.questionText;
        const pristineCorrectTextsBg =
          this.quizService.getPristineCorrectTextsForQuestion(liveQTBg);
        if (pristineCorrectTextsBg.size > 0) {
          // Read the signal directly so OnPush auto-tracks selection changes.
          const selectionsMapBg = this.selectedOptionService.selectedOptionsMapSig();
          const selectionsBg = selectionsMapBg.get(_qIdx) ?? [];
          const selectedTextsBg = new Set(
            selectionsBg.map((s: any) => nrmBg(s?.text)).filter((t: string) => !!t)
          );
          const allPristineCorrectSelectedBg =
            [...pristineCorrectTextsBg].every(t => selectedTextsBg.has(t));
          const myTextBg = nrmBg(this.binding()?.option?.text);
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
    let qIndex = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();

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
      this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();

    // Same URL fallback as getSelectionsForCurrentBinding â€” on refresh
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
    // is an unselect trace â€” ignore it so a never-clicked binding that
    // happens to share an index with an unselect entry never lights up.
    // EXCEPTION: entries with explicit showIcon/highlight are previously-
    // clicked wrong options saved by the correct-click handler â€” they
    // MUST match so the red+X icon restores on refresh.
    if (sel?.selected === false && !sel?.showIcon && !sel?.highlight) {
      return false;
    }

    // TEXT MATCH (most reliable â€” immune to synthetic ID mismatches
    // and index collisions from different init paths).
    const selText = ((sel as any)?.text ?? '').trim().toLowerCase();
    const bText = (this.binding()?.option?.text ?? '').trim().toLowerCase();
    if (selText && bText) return selText === bText;

    // Prefer `displayIndex` â€” that's what setSelectedOption enriches with
    // and it is stable across refresh. `sel.index` can be a stale legacy
    // field with an unrelated value (e.g. an array position), causing a
    // false positive against this binding's `this.i`. Fall back to
    // `index`/`idx` only when displayIndex is missing.
    const rawIdx =
      sel?.displayIndex ?? (sel as any)?.index ?? (sel as any)?.idx;
    const normalizedSelectedIndex =
      rawIdx != null && Number.isFinite(Number(rawIdx)) ? Number(rawIdx) : null;

    if (normalizedSelectedIndex != null) {
      if (normalizedSelectedIndex !== this.displayIndex()) return false;

      // Position matches â€” cross-check optionId to prevent false
      // positives when options reload in a different order or when
      // stale displayIndex values leak from a prior session.
      const selId = sel?.optionId;
      const bId = this.binding()?.option?.optionId;
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
    const bId = this.binding()?.option?.optionId;
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
      displayIndex: this.displayIndex(),
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
      displayIndex: this.displayIndex(),
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
    if (this.binding()?.isSelected && !this._wasSelected) {
      if (this._userHasClicked || this.isSelectedForCurrentQuestion()) {
        this._wasSelected = true;
      }
    }

    // AUTO-REVEAL: persistent custom flag stamped by the auto-reveal block
    // (soc-answer-processing line ~840). Survives the post-click binding
    // spread AND the updateBindingSnapshots cssClasses rebuild that wipes
    // option.highlight-derived classes. Checked first so the green
    // highlight wins regardless of any downstream class/flag mutations.
    if ((this.binding() as any)?._autoRevealedCorrect === true ||
        (this.binding()?.option as any)?._autoRevealedCorrect === true) {
      return true;
    }
    // Secondary auto-reveal signals: _multiAnswerPerfect map (cross-mechanism
    // flag) AND cssClasses['correct-option'] (set by auto-reveal, kept by
    // {...b} spread but wiped by updateBindingSnapshots).
    if (this.isOptionCorrect()) {
      const _qIdxAR = this.quizService.currentQuestionIndex ?? this.currentQuestionIndex();
      const perfectMapAR =
        (this.quizService as any)?._multiAnswerPerfect as Map<number, boolean> | undefined;
      if (perfectMapAR?.get(_qIdxAR) === true) return true;
      if (this.binding()?.cssClasses?.['correct-option'] === true) return true;
    }

    // On refresh (no live click), ONLY trust authoritative saved
    // selection state â€” not binding flags which can be transiently
    // stale from processOptionBindings / hydrateOptions / setOptionBindingsIfChanged.
    if (!this._userHasClicked && !this._wasSelected) {
      // During live interaction, trust the binding's highlight flag
      // when explicitly false â€” prevents service-level false positives.
      if (this.binding()?.option?.highlight === false) return false;

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
      return this.isOptionIndividuallySelected() || !!this.binding().option?.highlight ||
        this._wasSelected;
    }
    return this.binding().isSelected || !!this.binding().option?.highlight || this._wasSelected
      || this.isSelectedForCurrentQuestion();
  }

  private isOptionIndividuallySelected(): boolean {
    return (
      this.binding().isSelected ||
      this.binding().checked ||
      this.binding().option?.selected === true ||
      this.isSelectedForCurrentQuestion()
    );
  }

  private isSelectedForCurrentQuestion(): boolean {
    const selections = this.getSelectionsForCurrentBinding();
    return selections.some((s: any) => this.matchesBindingSelection(s));
  }
}