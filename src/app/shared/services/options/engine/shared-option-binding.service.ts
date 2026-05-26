import { Injectable, inject } from '@angular/core';

import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { SelectedOption } from '../../../models/SelectedOption.model';
import { SharedOptionConfig } from '../../../models/SharedOptionConfig.model';

import { SK_SEL_Q } from '../../../constants/session-keys';

import { ExplanationTextService } from '../../features/explanation/explanation-text.service';
import { FeedbackService } from '../../features/feedback/feedback.service';
import { OptionBindingFactoryService } from './option-binding-factory.service';
import { OptionClickHandlerService } from './option-click-handler.service';
import { OptionService } from '../view/option.service';
import { QuestionResolutionService } from './question-resolution.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';

import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

@Injectable({ providedIn: 'root' })
export class SharedOptionBindingService {
  // ── injects ─────────────────────────────────────────────────────
  private clickHandler = inject(OptionClickHandlerService);
  private explanationTextService = inject(ExplanationTextService);
  private feedbackService = inject(FeedbackService);
  private optionBindingFactory = inject(OptionBindingFactoryService);
  private optionService = inject(OptionService);
  private questionResolution = inject(QuestionResolutionService);
  private quizService = inject(QuizService);
  private selectedOptionService = inject(SelectedOptionService);

  // ── public methods ──────────────────────────────────────────────

  synchronizeOptionBindings(comp: any): void {
    if (!Array.isArray(comp.optionsToDisplay) || comp.optionsToDisplay.length === 0) {
      const hasSelection = comp.optionBindings()?.some((opt: OptionBindings) => opt.isSelected);
      if (!hasSelection && !comp.freezeOptionBindings()) comp.optionBindings.set([]);
      return;
    }

    if (comp.freezeOptionBindings() || comp.hasUserClicked()) return;

    const bindings = comp.optionsToDisplay.map((option: Option, idx: number) => {
      const isCorrect = option.correct ?? false;
      return {
        option: {
          ...option,
          // Force visual flags OFF for the initial pass. The real
          // visual state is applied by rehydrateUiFromState AFTER
          // authoritative selections are resolved. Using stale
          // option.selected here causes a brief flash of incorrect
          // highlights on refresh.
          highlight: false,
          showIcon: false
        },
        index: idx,
        isSelected: false,
        isCorrect,
        showFeedback: false,
        feedback: option.feedback ?? 'No feedback available',
        showFeedbackForOption: { [idx]: false },
        highlightCorrectAfterIncorrect: false,
        highlightIncorrect: false,
        highlightCorrect: false,
        disabled: comp.computeDisabledState(option, idx),
        type: comp.resolveInteractionType(),
        appHighlightOption: false,
        appHighlightInputType: (comp.type === 'multiple' ? 'checkbox' : 'radio') as 'checkbox' | 'radio',
        allOptions: [...comp.optionsToDisplay],
        appHighlightReset: false,
        ariaLabel: `Option ${idx + 1}`,
        appResetBackground: false,
        optionsToDisplay: [...comp.optionsToDisplay],
        checked: false,
        change: () => { },
        active: true
      };
    });

    queueMicrotask(() => {
      // If processOptionBindings already built correct bindings (with
      // rehydrated state), skip this overwrite â€” the microtask would
      // replace them with stale option.selected data, causing a flash
      // of incorrect highlights before the next CD cycle corrects them.
      if (comp.optionBindingsInitialized() && comp.optionBindings()?.length > 0) {
        comp.showOptions.set(true);
        comp.renderReady.set(true);
        comp.cdRef.markForCheck();
        return;
      }
      comp.optionBindings.set(bindings);
      comp.showOptions.set(true);
      comp.renderReady.set(true);
      comp.cdRef.detectChanges();
    });

  }

  setOptionBindingsIfChanged(comp: any, newOptions: Option[]): void {
    if (!newOptions?.length) return;

    const incomingIds = newOptions.map((o: Option) => o.optionId).join(',');
    const existingIds = comp.optionBindings()?.map((b: OptionBindings) => b.option.optionId).join(',');

    if (incomingIds !== existingIds || !comp.optionBindings()?.length) {
      // On refresh (no user click), force isSelected=false so the checkbox
      // [checked] binding doesn't flash. rehydrateUiFromState will set the
      // authoritative selection state from saved data afterward.
      const trustOptionSelected = !!comp.hasUserClicked();
      comp.optionBindings.set(newOptions.map((option: Option, idx: number) => ({
        option: { ...option, highlight: false, showIcon: false },
        index: idx,
        isSelected: trustOptionSelected && !!option.selected,
        isCorrect: option.correct ?? false,
        showFeedback: false,
        feedback: option.feedback ?? 'No feedback available',
        showFeedbackForOption: false,
        highlightCorrectAfterIncorrect: false,
        highlightIncorrect: false,
        highlightCorrect: false,
        disabled: comp.computeDisabledState(option, idx),
        type: comp.resolveInteractionType(),
        appHighlightOption: false,
        appHighlightInputType: '',
        allOptions: comp.optionsToDisplay ?? []
      })) as unknown as OptionBindings[]);
    } else {
      let idx = 0;
      const trustSel = !!comp.hasUserClicked();
      for (const binding of comp.optionBindings() ?? []) {
        const updated = newOptions[idx];
        if (updated) {
          binding.option = { ...updated, highlight: false, showIcon: false };
          binding.isSelected = trustSel && !!updated.selected;
          binding.isCorrect = updated.correct ?? false;
        }
        idx++;
      }
    }

    comp.optionsReady = true;
    comp.showOptions.set(true);

    // Re-apply persisted refresh state. initializeFromConfig calls this
    // method AFTER generateOptionBindings already rehydrated, so the
    // bindings just created above have highlight:false/showIcon:false.
    // Without this re-rehydrate, previously-clicked wrong options lose
    // their red highlight + X icon on refresh.
    comp.rehydrateUiFromState('setOptionBindingsIfChanged');

    if (this.explanationTextService.latestExplanation) {
      const currentIdx = comp.resolveDisplayIndex(comp.currentQuestionIndex);
      if (this.explanationTextService.latestExplanationIndex === currentIdx) {
        // Only re-emit explanation for single-answer questions. For multi-
        // answer, FET must wait until ALL correct answers are selected â€”
        // emitting here on every binding update causes premature FET display
        // after a partial correct click.
        // Use authoritative questions array â€” comp.currentQuestion.options
        // often lack the `correct` flag, making correctCount=0.
        const authQ = this.quizService.questions?.[currentIdx] ?? comp.currentQuestion();
        const correctCount = (authQ?.options ?? []).filter(
          (o: any) => isOptionCorrect(o)
        ).length;
        const isMulti = correctCount > 1 || comp.isMultiMode;
        if (!isMulti) {
          comp.deferHighlightUpdate(() => comp.emitExplanation(currentIdx));
        }
      }
    }
  }

  generateOptionBindings(comp: any): void {
    if (comp.hasUserClicked() && comp.optionBindings()?.length > 0) {
      console.log('[BIND-DIAG] generateOptionBindings SKIPPED (hasUserClicked + bindings exist)');
      return;
    }

    const currentIndex = comp.getActiveQuestionIndex() ?? 0;

    // SHUFFLE GUARD: when shuffle is active, ensure we use options from
    // the authoritative shuffledQuestions array for this display index.
    if (this.quizService.isShuffleEnabled() && this.quizService.shuffledQuestions?.length > 0) {
      const correctQ = this.quizService.shuffledQuestions[currentIndex];
      if (correctQ?.options?.length > 0) {
        const correctTexts = new Set(correctQ.options.map((o: Option) => norm(o?.text)));
        const currentTexts = new Set((comp.optionsToDisplay ?? []).map((o: Option) => norm(o?.text)));
        const match = correctTexts.size === currentTexts.size && [...correctTexts].every((t: string) => currentTexts.has(t));
        if (!match && comp.optionsToDisplay?.length > 0) {
          comp.optionsToDisplay = correctQ.options.map((o: Option) => ({ ...o }));
        }
      }
    }

    const localOpts = Array.isArray(comp.optionsToDisplay)
      ? comp.optionsToDisplay.map((o: Option) => structuredClone(o)) : [];

    const correctTexts = new Set<string>();
    const correctIds = new Set<number>();
    const cqForAnswers = comp.currentQuestion();
    if (cqForAnswers && Array.isArray(cqForAnswers.answer)) {
      for (const a of cqForAnswers.answer) {
        if (!a) continue;
        if (a.text) correctTexts.add(norm(a.text));
        const id = Number(a.optionId);
        if (!isNaN(id)) correctIds.add(id);
      }
    }

    comp.optionsToDisplay = localOpts.map((opt: Option, i: number) => {
      const oIdNum = Number(opt.optionId);
      const oId = !isNaN(oIdNum) ? oIdNum : (currentIndex + 1) * 100 + (i + 1);
      const oText = norm(opt.text);

      const isCorrect = isOptionCorrect(opt) ||
        (!isNaN(oIdNum) && correctIds.has(oIdNum)) ||
        !!(oText && correctTexts.has(oText));

      return {
        ...opt,
        optionId: oId,
        correct: isCorrect,
        highlight: false,
        showIcon: false,
        active: opt.active ?? true,
        disabled: comp.computeDisabledState(opt, i)
      };
    });

    comp.optionBindings.set(this.optionBindingFactory.createBindings({
      optionsToDisplay: comp.optionsToDisplay,
      type: comp.resolveInteractionType(),
      showFeedback: comp.showFeedback(),
      showFeedbackForOption: {},
      highlightCorrectAfterIncorrect: comp.highlightCorrectAfterIncorrect(),
      shouldResetBackground: comp.shouldResetBackground(),
      ariaLabelPrefix: 'Option',
      onChange: (opt: Option, idx: number) => comp.handleOptionClick(opt, idx),
      isSelected: () => false,
      isDisabled: (opt: Option, idx: number) => comp.computeDisabledState(opt, idx)
    }));

    comp.rehydrateUiFromState('generateOptionBindings');

    // Previous-revisit visual override. After all the standard binding paths
    // have run, force the Previous-revisit semantics:
    //   • Question was answered correctly (clickConfirmedDotStatus === 'correct'):
    //       correct options stay highlighted; incorrect options are greyed out.
    //   • Question was answered incorrectly: clear all marks.
    // This runs unconditionally (no hasUserClicked guard) so it survives the
    // standard rehydrate path's early-returns.
    try {
      const qIdx = comp.resolveCurrentQuestionIndex?.()
        ?? comp.questionIndex?.()
        ?? comp.currentQuestionIndex
        ?? 0;
      const isCorrectOpt = (o: any): boolean => isOptionCorrect(o);
      const current = comp.optionBindings?.();

      const _res = this.questionResolution.resolve(qIdx, { includeSelections: false });
      const dotStatus = _res.dot;

      // Decide override mode:
      //   'correct' → paint correct opts green, others grey
      //   'wrong'   → clear all marks
      //   ''        → leave bindings alone (mid-interaction, e.g. partial multi-answer)
      let overrideMode: '' | 'correct' | 'wrong' = '';
      if (_res.fullyResolvedCorrect) overrideMode = 'correct';
      else if (dotStatus === 'wrong') overrideMode = 'wrong';
      console.log('[BIND-DIAG] revisit-override qIdx:', qIdx, 'overrideMode:', overrideMode, 'fullyResolvedCorrect:', _res.fullyResolvedCorrect, 'dot:', dotStatus, 'multiPerfect:', _res.multiPerfect, 'scoredCorrect:', _res.scoredCorrect, 'isCanonMulti:', _res.isCanonMulti);
      // Partial multi-answer (isCanonMulti && dot=correct && !multiPerfect): no override

      if (Array.isArray(current) && current.length > 0 && overrideMode !== '') {
        // Build a NEW array of NEW binding refs with NEW option refs so that
        // OnPush option-items re-render with the corrected visuals. Mutating
        // in place leaves Angular blind to the change.
        const refreshed = current.map((b: OptionBindings) => {
          if (!b) return b;
          const isCorrect = isCorrectOpt(b.option);
          const correctRevisit = overrideMode === 'correct';
          const showHighlight = correctRevisit && isCorrect;
          const greyOut = correctRevisit && !isCorrect;

          const newOption = {
            ...(b.option ?? {}),
            selected: showHighlight,
            highlight: showHighlight,
            showIcon: showHighlight,
            active: !greyOut,
            // Stamp so option-item.shouldHighlightOption picks the green branch
            ...(showHighlight ? { _autoRevealedCorrect: true } : { _autoRevealedCorrect: false })
          };

          // Mirror correct-class into cssClasses so getOptionClasses sees it
          // even if downstream code wipes option.highlight afterwards.
          const newCss = { ...(b.cssClasses ?? {}) };
          newCss['correct-option'] = !!showHighlight;
          newCss['incorrect-option'] = false;

          return {
            ...b,
            option: newOption,
            isSelected: showHighlight,
            disabled: greyOut,
            highlightCorrect: showHighlight,
            highlightIncorrect: false,
            cssClasses: newCss
          };
        });
        comp.optionBindings.set(refreshed);
        try { comp.cdRef?.markForCheck?.(); } catch { /* ignore */ }
      }
    } catch (e) { console.error('generateOptionBindings revisit-override failed:', e); }

    const hasFreshFeedback = Object.keys(comp.feedbackConfigs).length > 0;
    if (!hasFreshFeedback) comp.rebuildShowFeedbackMapFromBindings();

    comp.showOptions.set(true);
    comp.optionsReady = true;
    comp.renderReady.set(true);

    comp.markRenderReady('Bindings refreshed');
    comp.cdRef.markForCheck();
  }

  processOptionBindings(comp: any): void {
    // SHUFFLE GUARD: same as generateOptionBindings
    const pIdx = comp.currentQuestionIndex ?? this.quizService.getCurrentQuestionIndex() ?? 0;
    if (this.quizService.isShuffleEnabled() && this.quizService.shuffledQuestions?.length > 0) {
      const correctQ = this.quizService.shuffledQuestions[pIdx];
      if (correctQ?.options?.length > 0 && comp.optionsToDisplay?.length > 0) {
        const correctTexts = new Set(correctQ.options.map((o: Option) => norm(o?.text)));
        const currentTexts = new Set((comp.optionsToDisplay).map((o: Option) => norm(o?.text)));
        const match = correctTexts.size === currentTexts.size && [...correctTexts].every((t: string) => currentTexts.has(t));
        if (!match) {
          comp.optionsToDisplay = correctQ.options.map((o: Option) => ({ ...o }));
        }
      }
    }

    const options = comp.optionsToDisplay ?? [];

    if (!options.length) {
      comp.optionBindingsInitialized.set(false);
      return;
    }
    if (comp.freezeOptionBindings()) return;
    const cqForFeedback = comp.currentQuestion();
    if (!cqForFeedback) return;

    const currentIdx = comp.currentQuestionIndex ?? this.quizService.getCurrentQuestionIndex();

    const rawSavedSelections = this.selectedOptionService.getSelectedOptionsForQuestion(currentIdx) || [];
    // Strict question-context filter: drop any selection whose stored
    // questionIndex doesn't match currentIdx, so a previous question's
    // selections can never stamp highlights onto a new question's options.
    const savedSelections = rawSavedSelections.filter((s: any) => {
      const sQIdx = s?.questionIndex ?? s?.qIdx ?? s?.questionIdx;
      return sQIdx == null || Number(sQIdx) === Number(currentIdx);
    });
    const savedIds = this.toIdSet(savedSelections);

    const getBindings = comp.getOptionBindings.bind(comp);
    const highlightSet = comp.highlightedOptionIds;

    const feedbackSentence = this.feedbackService.buildFeedbackMessage(
      cqForFeedback,
      savedSelections,
      false,
      false,
      currentIdx,
      comp.optionsToDisplay
    ) || '';

    // Build a position-based set from saved selections so the id-based
    // savedIds fallback (effectiveId = idx) cannot false-positive when a
    // display index collides with another option's optionId.
    const savedByDisplayIdx = new Set<number>();
    for (const s of savedSelections) {
      const sIdx = (s as any).displayIndex ?? (s as any).index ?? (s as any).idx;
      if (sIdx != null && Number.isFinite(Number(sIdx))) {
        savedByDisplayIdx.add(Number(sIdx));
      }
    }

    comp.optionBindings.set(options.map((opt: Option, idx: number) => {
      const oIdNum = Number(opt.optionId);
      const effectiveId = (!isNaN(oIdNum) && oIdNum > -1) ? oIdNum : idx;

      if (opt.optionId == null) opt.optionId = effectiveId;

      opt.feedback = feedbackSentence;

      // Match saved selections: for options with a real optionId, the ID
      // alone is sufficient (real IDs are unique). For options whose
      // effectiveId is a fallback (= their array index), also require a
      // display-index match to prevent false positives when the fallback
      // index collides with another option's real optionId.
      const idMatch = savedIds.has(effectiveId) || savedIds.has(String(effectiveId));
      const hasRealId = !isNaN(oIdNum) && oIdNum > -1;
      const posMatch = savedByDisplayIdx.has(idx);
      const isSelected = hasRealId ? idMatch : (idMatch && posMatch);

      // Only trust highlightSet and savedIds during LIVE interaction
      // (hasUserClicked). On refresh, savedIds may contain stale entries
      // from accumulated selection history, and highlightSet may have
      // IDs from a previous CD cycle â€” both cause ghost highlights for
      // options the user never selected. rehydrateUiFromState (called
      // immediately after this loop) handles refresh highlighting
      // authoritatively with its own clean-slate + match logic.
      const useHighlightSet = comp.hasUserClicked() && highlightSet.has(effectiveId);
      const useSelected = comp.hasUserClicked() ? isSelected : false;
      opt.highlight = useSelected || useHighlightSet;

      // Pass the GUARDED selection state to getBindings so that on refresh
      // (hasUserClicked=false) no binding gets isSelected=true from stale
      // savedIds. This prevents _wasSelected from latching in ngOnChanges
      // before rehydrateUiFromState can run its clean-slate reset.
      // IMPORTANT: only use useSelected, NOT useHighlightSet â€” highlightSet
      // can contain IDs for options never clicked (e.g. both correct answers
      // in multi-answer), causing ghost isSelected=true on bindings.
      return getBindings(opt, idx, useSelected);
    }));

    comp.rebuildShowFeedbackMapFromBindings();
    comp.updateSelections(-1);

    // Re-apply persisted refresh state AFTER the id-based rebuild above.
    // `processOptionBindings` only knows how to light options whose
    // `optionId` appears in `savedIds`. That misses position-encoded
    // matches (displayIndex/text) needed on refresh, AND it does not
    // populate `disabledOptionsPerQuestion` for never-clicked wrongs.
    // Calling rehydrate after the rebuild guarantees the canonical
    // refresh state is the last write before detectChanges.
    comp.rehydrateUiFromState('processOptionBindings');

    comp.optionsReady = true;
    comp.renderReady.set(true);
    comp.viewReady.set(true);
    comp.cdRef.detectChanges();
  }

  hydrateOptionsFromSelectionState(comp: any): void {
    if (!Array.isArray(comp.optionsToDisplay) || comp.optionsToDisplay.length === 0) {
      return;
    }

    const currentIndex =
      comp.getActiveQuestionIndex() ??
      comp.currentQuestionIndex ??
      comp.questionIndex() ??
      0;

    const storedSelections =
      this.selectedOptionService.getSelectedOptionsForQuestion(currentIndex) ?? [];

    comp.optionsToDisplay = comp.optionsToDisplay.map((opt: Option, i: number) => {
      const match = storedSelections.find(
        (s: SelectedOption) =>
          Number(s.optionId) === Number(opt.optionId) &&
          Number(s.questionIndex) === Number(currentIndex)
      );

      return {
        ...opt,
        optionId:
          typeof opt.optionId === 'number' && Number.isFinite(opt.optionId)
            ? opt.optionId
            : (currentIndex + 1) * 100 + (i + 1),
        selected: !!match?.selected,
        highlight: !!match?.highlight,
        showIcon: !!match?.showIcon,
        active: opt.active ?? true,
        disabled: comp.computeDisabledState(opt, i)
      };
    });

    comp.cdRef.markForCheck();
  }

  rehydrateUiFromState(comp: any, _reason: string): void {
    try {
      // Guard: if the user has already clicked or bindings are frozen,
      if (comp.hasUserClicked() || comp.freezeOptionBindings()) return;

      // Universal clean-slate
      if (comp.optionBindings()?.length) {
        for (const b of comp.optionBindings()) {
          b.isSelected = false;
          b.checked = false;
          if (b.option) {
            b.option.selected = false;
            b.option.highlight = false;
            b.option.showIcon = false;
          }
        }
      }
      if (comp.optionsToDisplay?.length) {
        for (const opt of comp.optionsToDisplay) {
          opt.selected = false;
          opt.highlight = false;
          opt.showIcon = false;
        }
      }
      comp.cdRef?.markForCheck?.();

      const qIndex = comp.resolveCurrentQuestionIndex();
      console.log('[REHYDRATE-DIAG] qIndex:', qIndex, 'hasUserClicked:', comp.hasUserClicked(), 'bindingsLen:', comp.optionBindings()?.length);
      // Read from durable sel_Q* sessionStorage FIRST â€” the cleanest source.
      // getSelectedOptionsForQuestion merges from _refreshBackup +
      // selectedOptionsMap + sel_Q*, and the in-memory maps can be
      // contaminated by init paths that add entries the user never clicked.
      // Fall back only if sel_Q* is empty (single-answer wrong-only clicks).
      let saved: any[] = [];
      try {
        const raw = sessionStorage.getItem(SK_SEL_Q + qIndex);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            saved = parsed;
          }
        }
      } catch { /* ignore */ }
      if (saved.length === 0) {
        saved = this.selectedOptionService.getSelectedOptionsForQuestion(qIndex) ?? [];
      }
      if (!saved.length) return;

      const savedByIndex = new Map<number, any>();
      for (const s of saved) {
        const sQIdx = (s as any).questionIndex ?? (s as any).qIdx ?? (s as any).questionIdx;
        if (sQIdx != null && Number(sQIdx) !== qIndex) continue;
        if ((s as any)?.selected === false && !(s as any)?.showIcon && !(s as any)?.highlight) continue;

        const sText = norm((s as any).text);

        let pos = -1;

        // TEXT-ONLY PRIMARY MATCH: immune to synthetic ID mismatches and
        // position shifts from shuffled options. If the saved entry has
        // text, we MUST match by text — ID/index fallbacks can map the
        // saved entry to the wrong binding when options shuffle.
        if (sText && comp.optionBindings()?.length) {
          pos = comp.optionBindings().findIndex((b: OptionBindings) => {
            const bText = norm(b?.option?.text);
            return bText && bText === sText;
          });
        }

        // ID/index fallback ONLY when text is empty (legacy data)
        if (pos === -1 && !sText) {
          const sId = (s as any).optionId;
          const sIdIsReal = sId != null && sId !== -1 && String(sId) !== '-1';
          if (sIdIsReal && comp.optionBindings()?.length) {
            pos = comp.optionBindings().findIndex((b: OptionBindings) => {
              const bId = b?.option?.optionId;
              const bIdIsReal = bId != null && bId !== -1 && String(bId) !== '-1';
              return bIdIsReal && String(sId) === String(bId);
            });
          }
          if (pos === -1) {
            const sIdx = (s as any).displayIndex ?? (s as any).index ?? (s as any).idx;
            if (sIdx != null && Number.isFinite(Number(sIdx))) {
              pos = Number(sIdx);
            }
          }
        }

        if (pos !== -1) {
          // Prefer the sel:true entry when multiple saved records resolve to
          // the same binding position (can happen when prev-click and current-
          // click for the same option were persisted with differing displayIndex
          // values). Without this, a prev-click (sel:false) entry found first
          // wins, and the currently-selected option renders as white/gray.
          const existing = savedByIndex.get(pos);
          if (!existing) {
            savedByIndex.set(pos, s);
          } else if ((s as any)?.selected === true && (existing as any)?.selected !== true) {
            savedByIndex.set(pos, s);
          }
        }
      }
      if (savedByIndex.size === 0) return;

      // Was the question previously answered perfectly? Drives Previous-revisit
      // visuals:
      //   • perfect → correct opts keep highlight, others appear disabled (gray)
      //   • imperfect/none → every option resets clean
      const isCorrectOpt = (o: any): boolean => isOptionCorrect(o);

      const _res = this.questionResolution.resolve(qIndex, { includeSelections: false });
      const wasPerfect = _res.fullyResolvedCorrect;

      // Restored optionsToDisplay loop
      if (comp.optionsToDisplay?.length) {
        for (const [idx, opt] of comp.optionsToDisplay.entries()) {
          const match = savedByIndex.get(idx);
          if (!opt) continue;

          if (!wasPerfect) {
            // Imperfect/none → clear every visible mark on this option
            opt.selected = false;
            opt.highlight = false;
            opt.showIcon = false;
            continue;
          }

          // Perfect: show full highlight on correct picks, leave others blank
          // (they'll be greyed via b.disabled below).
          const isCorrect = isCorrectOpt(opt);
          if (isCorrect) {
            const isSelected = !!match?.selected;
            const isPreviouslyClicked = !isSelected && !!match?.showIcon;
            opt.selected = isSelected || isPreviouslyClicked;
            opt.highlight = isSelected || isPreviouslyClicked;
            opt.showIcon = isSelected || isPreviouslyClicked;
          } else {
            opt.selected = false;
            opt.highlight = false;
            opt.showIcon = false;
          }
        }
      }

      // For partial multi-answer revisit: explicitly unlock all options for
      // this question and clear stale lock state, so user can complete the
      // remaining correct picks. Single-answer or unanswered questions also
      // benefit (no-op when there are no locks).
      if (!wasPerfect) {
        try {
          this.selectedOptionService.unlockAllOptionsForQuestion?.(qIndex);
          this.selectedOptionService.unlockQuestion?.(qIndex);
        } catch { /* ignore */ }
      }

      if (comp.optionBindings()?.length) {
        for (const [idx, b] of comp.optionBindings().entries()) {
          const match = savedByIndex.get(idx);
          if (b.option) {
            if (!wasPerfect) {
              b.isSelected = false;
              b.option.selected = false;
              b.option.highlight = false;
              b.option.showIcon = false;
              // Clear stale cssClasses (e.g. `disabled-option:true` from
              // a prior partial state) so visuals match the cleared state.
              if (b.cssClasses) {
                b.cssClasses['selected'] = false;
                b.cssClasses['selected-option'] = false;
                b.cssClasses['correct-option'] = false;
                b.cssClasses['incorrect-option'] = false;
                b.cssClasses['highlighted'] = false;
                b.cssClasses['disabled-option'] = false;
                b.cssClasses['locked-option'] = false;
              }
              // Restore normal interactivity (not greyed)
              (b.option as any).active = true;
              b.disabled = comp.computeDisabledState(b.option, idx);
            } else {
              const isCorrect = isCorrectOpt(b.option);
              if (isCorrect) {
                const isSelected = !!match?.selected;
                const isPreviouslyClicked = !isSelected && !!match?.showIcon;
                b.isSelected = isSelected || isPreviouslyClicked;
                b.option.selected = isSelected || isPreviouslyClicked;
                b.option.highlight = isSelected || isPreviouslyClicked;
                b.option.showIcon = isSelected || isPreviouslyClicked;
                (b.option as any).active = true;
              } else {
                b.isSelected = false;
                b.option.selected = false;
                b.option.highlight = false;
                b.option.showIcon = false;
                // Mark inactive so the option-row renders as greyed/disabled
                (b.option as any).active = false;
              }
              // Lock the question's options on revisit so the user can't
              // re-answer — also drives the grey appearance via .disabled.
              b.disabled = true;
            }
          }
          b.showFeedback = true;
        }
      }

      if (saved.length > 0) {
        // Use reverse() to find the LAST selected option â€” that's where
        // feedback should appear (the most recently clicked option).
        // saved.find() returns the first match which is typically the
        // option with the lowest index, not the last one the user clicked.
        const activeSelection = [...saved].reverse().find((s: any) => s?.selected === true)
          ?? [...saved].reverse().find((s: any) => s?.showIcon === true)
          ?? saved[saved.length - 1];

        const activeIdxRaw = (activeSelection as any).displayIndex ?? (activeSelection as any).index ?? (activeSelection as any).idx;
        const activeIdx = (activeIdxRaw != null && Number.isFinite(Number(activeIdxRaw))) ? Number(activeIdxRaw) : -1;

        if (activeIdx >= 0) {
          comp.lastFeedbackOptionId = activeIdx;
          comp.showFeedback.set(true);
        }

        if (!comp._feedbackDisplay) {
          let targetIdx = activeIdx;
          if (targetIdx < 0) {
            for (const k of savedByIndex.keys()) {
              if (k > targetIdx) targetIdx = k;
            }
          }
          const targetBinding = targetIdx >= 0 ? comp.optionBindings()?.[targetIdx] : null;
          const cqForTarget = comp.currentQuestion();
          if (targetBinding && cqForTarget) {
            try {
              const lastSelectionOnly = [activeSelection] as any[];
              const feedbackText = this.feedbackService.buildFeedbackMessage(
                cqForTarget, lastSelectionOnly, false, false, qIndex, comp.optionsToDisplay
              ) || '';
              let correctMessage = '';
              try {
                correctMessage = this.feedbackService.setCorrectMessage(
                  (comp.optionsToDisplay ?? []).filter((o: any) => o && typeof o === 'object'),
                  cqForTarget
                );
              } catch (e) {
                console.error('SharedOptionBindingService.rehydrateUiFromState correctMessage resolution failed:', e);
              }
              comp._feedbackDisplay = {
                idx: targetIdx,
                config: {
                  feedback: feedbackText,
                  showFeedback: true,
                  correctMessage,
                  selectedOption: targetBinding.option,
                  options: comp.optionsToDisplay ?? [],
                  question: cqForTarget,
                  idx: targetIdx
                } as FeedbackProps
              };
            } catch (e) { console.error('rehydrateUiFromState feedback-display failed:', e); }
          }
        }
      }

      if (comp.optionBindings()?.length) {
        comp.optionBindings.set(comp.optionBindings().map((b: OptionBindings) => ({ ...b, option: { ...b.option } })));
      }

      if (comp.rebuildShowFeedbackMapFromBindings) comp.rebuildShowFeedbackMapFromBindings();
      comp.cdRef?.markForCheck?.();
    } catch (e) {
      console.error('rehydrateUiFromState failed:', e);
    }
  }

  buildSharedOptionConfig(comp: any, b: OptionBindings, i: number): SharedOptionConfig {
    const qIndex = comp.resolveCurrentQuestionIndex();
    // Determine multi-answer from AUTHORITATIVE question data, not just
    // comp.isMultiMode which can be wrong on refresh if question data
    // hasn't fully loaded into the component yet.
    const authQ = this.quizService.questions?.[qIndex];
    const authCorrectCount = (authQ?.options ?? []).filter(
      (o: any) => isOptionCorrect(o)
    ).length;
    const isMulti = comp.isMultiMode || authCorrectCount > 1 || this.quizService.multipleAnswer;

    const isActuallySelected = b.isSelected;

    const optionKey = this.optionService.keyOf(b.option, i);
    const showCorrectOnTimeout = comp.timerExpiredForQuestion()
      && (comp.timeoutCorrectOptionKeys?.has(optionKey) || isOptionCorrect(b.option));

    let shouldHighlight: boolean;
    if (isMulti && comp.hasUserClicked()) {
      // Hard Guard: For multi-answer live interaction, the durable click set
      // is the only authority for which options should highlight.
      const qIdx = comp.getActiveQuestionIndex?.() ?? qIndex;
      const durableSet: Set<number> | undefined = comp._multiSelectByQuestion?.get(qIdx);
      const isInDurableSet = durableSet ? durableSet.has(i) : false;
      shouldHighlight = isInDurableSet || showCorrectOnTimeout;
    } else if (!comp.hasUserClicked()) {
      // REFRESH PATH (both single & multi): Binding state is unreliable
      // because multiple init paths (generateOptionBindings, initializeFromConfig,
      // setOptionBindingsIfChanged) overwrite each other. Query the persisted
      // sel_Q* data directly from the service as the single source of truth.
      // Read from durable sel_Q* sessionStorage FIRST â€” the cleanest source.
      // Fall back to getSelectedOptionsForQuestion only if sel_Q* is empty
      // (e.g. single-answer wrong-only clicks where sel_Q* isn't written
      // until the correct answer is clicked).
      let saved: any[] = [];
      try {
        const raw = sessionStorage.getItem(SK_SEL_Q + qIndex);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            saved = parsed;
          }
        }
      } catch { /* ignore */ }
      if (saved.length === 0) {
        saved = this.selectedOptionService.getSelectedOptionsForQuestion(qIndex) ?? [];
      }
      const bText = norm(b.option?.text);
      // TEXT-ONLY PRIMARY MATCH: immune to synthetic ID mismatches and
      // position shifts from shuffled options. ID/index fallbacks are only
      // used when the saved entry has no text (legacy data).
      const matchEntry = saved.find((s: any) => {
        const sText = norm((s as any).text);
        // If saved entry has text, ONLY match by text
        if (sText) return bText && sText === bText;
        // Legacy fallback (no text on saved entry): displayIndex then optionId
        const sIdx = (s as any).displayIndex ?? (s as any).index ?? (s as any).idx;
        if (sIdx != null && Number(sIdx) === i) return true;
        const sId = (s as any).optionId;
        const bId = b.option?.optionId;
        const sIdReal = sId != null && sId !== -1 && String(sId) !== '-1';
        const bIdReal = bId != null && bId !== -1 && String(bId) !== '-1';
        return sIdReal && bIdReal && String(sId) === String(bId);
      });
      if (matchEntry) {
        // For multi-answer: only highlight options that were actually selected
        // (selected: true). For single-answer: also highlight previously-clicked
        // wrong options (selected: false but showIcon/highlight set).
        if (isMulti) {
          shouldHighlight = !!(matchEntry as any).selected || showCorrectOnTimeout;
        } else {
          shouldHighlight = !!(matchEntry as any).selected
            || !!(matchEntry as any).showIcon
            || !!(matchEntry as any).highlight
            || showCorrectOnTimeout;
        }
      } else {
        shouldHighlight = showCorrectOnTimeout;
      }
    } else {
      // Single-answer live interaction
      shouldHighlight = !!b.option.highlight || isActuallySelected || showCorrectOnTimeout;
    }

    const isOnCorrectQuestion = comp.lastProcessedQuestionIndex === qIndex;
    const currentSelections = this.selectedOptionService.getSelectedOptionsForQuestion(qIndex) ?? [];

    const verifiedOption = {
      ...b.option,
      selected: isActuallySelected,
      highlight: shouldHighlight,
      showIcon: shouldHighlight
    };

    return {
      option: verifiedOption,
      idx: i,
      type: comp.resolveInteractionType(),
      isOptionSelected: isActuallySelected,
      isAnswerCorrect: b.isCorrect,
      highlightCorrectAfterIncorrect: comp.highlightCorrectAfterIncorrect(),
      shouldResetBackground:
        (comp.shouldResetBackground() || (!isOnCorrectQuestion && currentSelections.length === 0))
        && !shouldHighlight,
      feedback: b.feedback ?? '',
      showFeedbackForOption: comp.showFeedbackForOption,
      optionsToDisplay: comp.optionsToDisplay,
      selectedOption: comp.selectedOption(),
      currentQuestion: comp.currentQuestion(),
      showFeedback: comp.showFeedback(),
      correctMessage: comp.correctMessage(),
      showCorrectMessage: !!comp.correctMessage(),
      explanationText: '',
      showExplanation: false,
      selectedOptionIndex: comp.selectedOptionIndex(),
      highlight: shouldHighlight
    };
  }

  getOptionBindings(comp: any, option: Option, idx: number, isSelected: boolean = false): OptionBindings {
    const correctOptionsCount =
      comp.optionsToDisplay?.filter((opt: any) => isOptionCorrect(opt)).length ?? 0;
    const inferredType = correctOptionsCount > 1 ? 'multiple' : 'single';
    const selected = isSelected;

    return {
      option: {
        ...structuredClone(option),
        feedback: option.feedback ?? 'No feedback available',
      },
      index: idx,
      feedback: option.feedback ?? 'No feedback available',
      isCorrect: option.correct ?? false,
      showFeedback: comp.showFeedback(),
      showFeedbackForOption: comp.showFeedbackForOption,
      highlightCorrectAfterIncorrect: comp.highlightCorrectAfterIncorrect(),
      highlightIncorrect: selected && !option.correct,
      highlightCorrect: selected && !!option.correct,
      allOptions: comp.optionsToDisplay,
      type: comp.resolveInteractionType(),
      appHighlightOption: false,
      appHighlightInputType: inferredType === 'multiple' ? 'checkbox' : 'radio',
      appHighlightReset: comp.shouldResetBackground(),
      appResetBackground: comp.shouldResetBackground(),
      optionsToDisplay: comp.optionsToDisplay,
      isSelected: selected,
      active: option.active ?? true,
      change: () => comp.handleOptionClick(option as SelectedOption, idx),
      disabled: comp.computeDisabledState(option, idx),
      ariaLabel: 'Option ' + (idx + 1),
      checked: selected
    };
  }

  getInlineFeedbackConfig(comp: any, b: OptionBindings, i: number): FeedbackProps | null {
    let config: FeedbackProps | null = null;

    if (comp._feedbackDisplay?.idx === i && comp._feedbackDisplay.config?.showFeedback) {
      config = comp._feedbackDisplay.config;
    } else if (comp.timerExpiredForQuestion()) {
      const key = comp.keyOf(b.option, i);
      const cfg = comp.feedbackConfigs?.[key];
      if (cfg?.showFeedback) config = cfg;
    }

    if (!config) return null;

    const qIdx = comp.getActiveQuestionIndex();

    let correctIndicesArr: number[] = comp._correctIndicesByQuestion?.get(qIdx) ?? [];
    if (correctIndicesArr.length === 0) {
      const feedbackQ = comp.currentQuestion() ?? comp.getQuestionAtDisplayIndex(qIdx);
      const result = this.clickHandler.resolveCorrectIndices(
        feedbackQ, qIdx, comp.isMultiMode, comp.type
      );
      correctIndicesArr = result.correctIndices;
    }

    const effectiveMultiMode = comp.isMultiMode || comp.type === 'multiple' || correctIndicesArr.length > 1;
    const durableSelected = comp._multiSelectByQuestion?.get(qIdx);

    if (effectiveMultiMode && durableSelected && durableSelected.size > 0 && correctIndicesArr.length > 0) {
      const clickState = this.clickHandler.computeMultiAnswerClickState(
        i, durableSelected, correctIndicesArr
      );
      const newFeedback = this.clickHandler.generateMultiAnswerFeedbackText(clickState);

      if (newFeedback !== config.feedback) {
        config = { ...config, feedback: newFeedback };
      }
    }

    return config;
  }

  syncSelectedFlags(comp: any): void {
    // Collision guard: when a binding has no real optionId, the fallback (array
    // index) can collide with another binding's real optionId (e.g. binding[0]
    // has optionId=1, binding[1] has no id so falls back to index 1 â†’ collision).
    const realIdOwner = new Map<number, number>();
    for (let i = 0; i < (comp.optionBindings()?.length ?? 0); i++) {
      const id = comp.optionBindings()[i].option.optionId;
      if (id != null && id !== -1) realIdOwner.set(Number(id), i);
    }

    for (let i = 0; i < (comp.optionBindings()?.length ?? 0); i++) {
      const b = comp.optionBindings()[i];
      const id = b.option.optionId;
      const numericId = (id != null && id !== -1) ? Number(id) : i;
      const hasRealId = id != null && id !== -1;
      const isCollision = !hasRealId && realIdOwner.has(numericId) && realIdOwner.get(numericId) !== i;

      let chosen = false;
      if (!isCollision) {
        chosen = Number.isFinite(numericId) && comp.selectedOptionMap.has(numericId);
        if (!chosen) {
          chosen = comp.selectedOptionHistory.some((h: any) => Number(h) === numericId);
        }
      }

      b.option.selected = chosen;
      b.isSelected = chosen;
    }
  }

  forceDisableAllOptions(comp: any): void {
    comp.forceDisableAll.set(true);
    for (const binding of comp.optionBindings() ?? []) {
      if (binding.option) binding.option.active = false;
    }
    comp.clickService?.updateBindingSnapshots(comp);
    for (const opt of comp.optionsToDisplay ?? []) {
      if (opt) opt.active = false;
    }
    comp.cdRef.markForCheck();
  }

  clearForceDisableAllOptions(comp: any): void {
    comp.forceDisableAll.set(false);
    for (const binding of comp.optionBindings() ?? []) {
      if (binding.option) {
        binding.option.active = true;
      }
    }

    for (const opt of comp.optionsToDisplay ?? []) {
      if (opt) opt.active = true;
    }

    try {
      const qIndex = comp.currentQuestionIndex;
      this.selectedOptionService.unlockQuestion(qIndex);
    } catch (e) {
      console.error('SharedOptionBindingService.clearForceDisableAllOptions unlockQuestion failed:', e);
    }

    comp.clickService?.updateBindingSnapshots(comp);
  }

  markRenderReady(comp: any, _reason: string = ''): void {
    const bindingsReady =
      Array.isArray(comp.optionBindings()) && comp.optionBindings().length > 0;

    const optionsReady =
      Array.isArray(comp.optionsToDisplay) && comp.optionsToDisplay.length > 0;

    if (bindingsReady && optionsReady) {
      comp.renderReady.set(true);
      comp.renderReadyChange.emit(true);
    }
  }

  // â”€â”€ Inlined from OptionHydrationService â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private toIdSet(
    saved: Array<{ optionId?: number | string; selected?: boolean }> | null | undefined
  ): Set<number | string> {
    const set = new Set<number | string>();
    if (!saved?.length) return set;
    for (const s of saved) {
      if ((s as any)?.selected === false) continue;
      const id = s?.optionId;
      if (id !== undefined && id !== null) set.add(id);
    }
    return set;
  }
}