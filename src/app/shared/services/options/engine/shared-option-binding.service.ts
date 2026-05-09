import { Injectable } from '@angular/core';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { SharedOptionConfig } from '../../../models/SharedOptionConfig.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SelectedOption } from '../../../models/SelectedOption.model';
import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { OptionClickHandlerService } from './option-click-handler.service';
import { OptionService } from '../view/option.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { FeedbackService } from '../../features/feedback/feedback.service';
import { OptionBindingFactoryService } from './option-binding-factory.service';
import { ExplanationTextService } from '../../features/explanation/explanation-text.service';

@Injectable({ providedIn: 'root' })
export class SharedOptionBindingService {
  constructor(
    private quizService: QuizService,
    private selectedOptionService: SelectedOptionService,
    private feedbackService: FeedbackService,
    private optionBindingFactory: OptionBindingFactoryService,
    private explanationTextService: ExplanationTextService,
    private clickHandler: OptionClickHandlerService,
    private optionService: OptionService
  ) {}

  synchronizeOptionBindings(comp: any): void {
    if (!Array.isArray(comp.optionsToDisplay) || comp.optionsToDisplay.length === 0) {
      const hasSelection = comp.optionBindings?.some((opt: any) => opt.isSelected);
      if (!hasSelection && !comp.freezeOptionBindings) comp.optionBindings = [];
      return;
    }

    if (comp.freezeOptionBindings || comp.hasUserClicked) return;

    const bindings = comp.optionsToDisplay.map((option: any, idx: number) => {
      const isSelected = option.selected ?? false;
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
      // rehydrated state), skip this overwrite — the microtask would
      // replace them with stale option.selected data, causing a flash
      // of incorrect highlights before the next CD cycle corrects them.
      if (comp.optionBindingsInitialized && comp.optionBindings?.length > 0) {
        comp.showOptions = true;
        comp.renderReady.set(true);
        comp.cdRef.markForCheck();
        return;
      }
      comp.optionBindings = bindings;
      comp.showOptions = true;
      comp.renderReady.set(true);
      comp.cdRef.detectChanges();
    });

    comp.updateHighlighting();
  }

  setOptionBindingsIfChanged(comp: any, newOptions: Option[]): void {
    if (!newOptions?.length) return;

    const incomingIds = newOptions.map((o: any) => o.optionId).join(',');
    const existingIds = comp.optionBindings?.map((b: any) => b.option.optionId).join(',');

    if (incomingIds !== existingIds || !comp.optionBindings?.length) {
      // On refresh (no user click), force isSelected=false so the checkbox
      // [checked] binding doesn't flash. rehydrateUiFromState will set the
      // authoritative selection state from saved data afterward.
      const trustOptionSelected = !!comp.hasUserClicked;
      comp.optionBindings = newOptions.map((option: any, idx: number) => ({
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
      })) as unknown as OptionBindings[];
    } else {
      let idx = 0;
      const trustSel = !!comp.hasUserClicked;
      for (const binding of comp.optionBindings ?? []) {
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
    comp.showOptions = true;

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
        // answer, FET must wait until ALL correct answers are selected —
        // emitting here on every binding update causes premature FET display
        // after a partial correct click.
        // Use authoritative questions array — comp.currentQuestion.options
        // often lack the `correct` flag, making correctCount=0.
        const authQ = this.quizService.questions?.[currentIdx] ?? comp.currentQuestion;
        const correctCount = (authQ?.options ?? []).filter(
          (o: any) => o?.correct === true || o?.correct === 1 || String(o?.correct) === 'true'
        ).length;
        const isMulti = correctCount > 1 || comp.isMultiMode;
        if (!isMulti) {
          comp.deferHighlightUpdate(() => comp.emitExplanation(currentIdx));
        }
      }
    }
  }

  generateOptionBindings(comp: any): void {
    if (comp.hasUserClicked && comp.optionBindings?.length > 0) return;

    const currentIndex = comp.getActiveQuestionIndex() ?? 0;

    // SHUFFLE GUARD: when shuffle is active, ensure we use options from
    // the authoritative shuffledQuestions array for this display index.
    if (this.quizService.isShuffleEnabled() && this.quizService.shuffledQuestions?.length > 0) {
      const correctQ = this.quizService.shuffledQuestions[currentIndex];
      if (correctQ?.options?.length > 0) {
        const correctTexts = new Set(correctQ.options.map((o: any) => (o?.text ?? '').trim().toLowerCase()));
        const currentTexts = new Set((comp.optionsToDisplay ?? []).map((o: any) => (o?.text ?? '').trim().toLowerCase()));
        const match = correctTexts.size === currentTexts.size && [...correctTexts].every((t: string) => currentTexts.has(t));
        if (!match && comp.optionsToDisplay?.length > 0) {
          comp.optionsToDisplay = correctQ.options.map((o: any) => ({ ...o }));
        }
      }
    }

    const localOpts = Array.isArray(comp.optionsToDisplay)
      ? comp.optionsToDisplay.map((o: any) => structuredClone(o)) : [];

    const correctTexts = new Set<string>();
    const correctIds = new Set<number>();
    if (comp.currentQuestion && Array.isArray(comp.currentQuestion.answer)) {
      for (const a of comp.currentQuestion.answer) {
        if (!a) continue;
        if (a.text) correctTexts.add(a.text.trim().toLowerCase());
        const id = Number(a.optionId);
        if (!isNaN(id)) correctIds.add(id);
      }
    }

    comp.optionsToDisplay = localOpts.map((opt: any, i: number) => {
      const oIdNum = Number(opt.optionId);
      const oId = !isNaN(oIdNum) ? oIdNum : (currentIndex + 1) * 100 + (i + 1);
      const oText = (opt.text ?? '').trim().toLowerCase();

      const isCorrect = opt.correct === true ||
        (opt as any).correct === "true" ||
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

    comp.optionBindings = this.optionBindingFactory.createBindings({
      optionsToDisplay: comp.optionsToDisplay,
      type: comp.resolveInteractionType(),
      showFeedback: comp.showFeedback,
      showFeedbackForOption: {},
      highlightCorrectAfterIncorrect: comp.highlightCorrectAfterIncorrect(),
      shouldResetBackground: comp.shouldResetBackground,
      ariaLabelPrefix: 'Option',
      onChange: (opt: any, idx: number) => comp.handleOptionClick(opt, idx),
      isSelected: () => false,
      isDisabled: (opt: any, idx: number) => comp.computeDisabledState(opt, idx)
    });

    comp.rehydrateUiFromState('generateOptionBindings');

    const hasFreshFeedback = Object.keys(comp.feedbackConfigs).length > 0;
    if (!hasFreshFeedback) comp.rebuildShowFeedbackMapFromBindings();

    comp.showOptions = true;
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
        const correctTexts = new Set(correctQ.options.map((o: any) => (o?.text ?? '').trim().toLowerCase()));
        const currentTexts = new Set((comp.optionsToDisplay).map((o: any) => (o?.text ?? '').trim().toLowerCase()));
        const match = correctTexts.size === currentTexts.size && [...correctTexts].every((t: string) => currentTexts.has(t));
        if (!match) {
          comp.optionsToDisplay = correctQ.options.map((o: any) => ({ ...o }));
        }
      }
    }

    const options = comp.optionsToDisplay ?? [];

    if (!options.length) {
      comp.optionBindingsInitialized = false;
      return;
    }
    if (comp.freezeOptionBindings) return;
    if (!comp.currentQuestion) return;

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
      comp.currentQuestion,
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

    comp.optionBindings = options.map((opt: any, idx: number) => {
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
      // IDs from a previous CD cycle — both cause ghost highlights for
      // options the user never selected. rehydrateUiFromState (called
      // immediately after this loop) handles refresh highlighting
      // authoritatively with its own clean-slate + match logic.
      const useHighlightSet = comp.hasUserClicked && highlightSet.has(effectiveId);
      const useSelected = comp.hasUserClicked ? isSelected : false;
      opt.highlight = useSelected || useHighlightSet;

      // Pass the GUARDED selection state to getBindings so that on refresh
      // (hasUserClicked=false) no binding gets isSelected=true from stale
      // savedIds. This prevents _wasSelected from latching in ngOnChanges
      // before rehydrateUiFromState can run its clean-slate reset.
      // IMPORTANT: only use useSelected, NOT useHighlightSet — highlightSet
      // can contain IDs for options never clicked (e.g. both correct answers
      // in multi-answer), causing ghost isSelected=true on bindings.
      return getBindings(opt, idx, useSelected);
    });

    comp.rebuildShowFeedbackMapFromBindings();
    comp.updateSelections(-1);
    comp.updateHighlighting();

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
    comp.viewReady = true;
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

    comp.optionsToDisplay = comp.optionsToDisplay.map((opt: any, i: number) => {
      const match = storedSelections.find(
        (s: any) =>
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

  rehydrateUiFromState(comp: any, reason: string): void {
    try {
      // Guard: if the user has already clicked or bindings are frozen,
      if (comp.hasUserClicked || comp.freezeOptionBindings) return;

      // Universal clean-slate
      if (comp.optionBindings?.length) {
        for (const b of comp.optionBindings) {
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
      // Read from durable sel_Q* sessionStorage FIRST — the cleanest source.
      // getSelectedOptionsForQuestion merges from _refreshBackup +
      // selectedOptionsMap + sel_Q*, and the in-memory maps can be
      // contaminated by init paths that add entries the user never clicked.
      // Fall back only if sel_Q* is empty (single-answer wrong-only clicks).
      let saved: any[] = [];
      try {
        const raw = sessionStorage.getItem('sel_Q' + qIndex);
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

        const sText = ((s as any).text ?? '').trim().toLowerCase();

        let pos = -1;

        // TEXT-ONLY PRIMARY MATCH: immune to synthetic ID mismatches and
        // position shifts from shuffled options. If the saved entry has
        // text, we MUST match by text — ID/index fallbacks can map the
        // saved entry to the wrong binding when options shuffle.
        if (sText && comp.optionBindings?.length) {
          pos = comp.optionBindings.findIndex((b: any) => {
            const bText = (b?.option?.text ?? '').trim().toLowerCase();
            return bText && bText === sText;
          });
        }

        // ID/index fallback ONLY when text is empty (legacy data)
        if (pos === -1 && !sText) {
          const sId = (s as any).optionId;
          const sIdIsReal = sId != null && sId !== -1 && String(sId) !== '-1';
          if (sIdIsReal && comp.optionBindings?.length) {
            pos = comp.optionBindings.findIndex((b: any) => {
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

      // Restored optionsToDisplay loop
      if (comp.optionsToDisplay?.length) {
        for (const [idx, opt] of comp.optionsToDisplay.entries()) {
          let match = savedByIndex.get(idx);
          if (match && opt) {
            const isSelected = !!match.selected;
            const isPreviouslyClicked = !isSelected && !!match.showIcon;
          
            opt.selected = isSelected;
            opt.highlight = isPreviouslyClicked || isSelected;
          
            // Restore icon for selected entries or previously clicked entries.
            opt.showIcon = isPreviouslyClicked ? !!match.showIcon : isSelected;
          }
        }
      }

      if (comp.optionBindings?.length) {
        for (const [idx, b] of comp.optionBindings.entries()) {
          let match = savedByIndex.get(idx);
          if (match) {
            const isSelected = !!match.selected;
            const isPreviouslyClicked = !isSelected && !!match.showIcon;
          
            b.isSelected = isSelected;
            b.option.selected = isSelected;
            b.option.highlight = isPreviouslyClicked || isSelected;
            b.option.showIcon = isPreviouslyClicked ? !!match.showIcon : isSelected;
          }
          b.disabled = comp.computeDisabledState(b.option, idx);
          b.showFeedback = true;
        }
      }

      if (saved.length > 0) {
        // Use reverse() to find the LAST selected option — that's where
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
          comp.showFeedback = true;
        }

        if (!comp._feedbackDisplay) {
          let targetIdx = activeIdx;
          if (targetIdx < 0) {
            for (const k of savedByIndex.keys()) {
              if (k > targetIdx) targetIdx = k;
            }
          }
          const targetBinding = targetIdx >= 0 ? comp.optionBindings?.[targetIdx] : null;
          if (targetBinding && comp.currentQuestion) {
            try {
              const lastSelectionOnly = [activeSelection] as any[];
              const feedbackText = this.feedbackService.buildFeedbackMessage(
                comp.currentQuestion, lastSelectionOnly, false, false, qIndex, comp.optionsToDisplay
              ) || '';
              let correctMessage = '';
              try {
                correctMessage = this.feedbackService.setCorrectMessage(
                  (comp.optionsToDisplay ?? []).filter((o: any) => o && typeof o === 'object'),
                  comp.currentQuestion
                );
              } catch { }
              comp._feedbackDisplay = {
                idx: targetIdx,
                config: {
                  feedback: feedbackText,
                  showFeedback: true,
                  correctMessage,
                  selectedOption: targetBinding.option,
                  options: comp.optionsToDisplay ?? [],
                  question: comp.currentQuestion ?? null,
                  idx: targetIdx
                } as FeedbackProps
              };
            } catch { }
          }
        }
      }

      if (comp.optionBindings?.length) {
        comp.optionBindings = comp.optionBindings.map((b: any) => ({ ...b, option: { ...b.option } }));
      }

      if (comp.rebuildShowFeedbackMapFromBindings) comp.rebuildShowFeedbackMapFromBindings();
      if (comp.updateHighlighting) comp.updateHighlighting();
      comp.cdRef?.markForCheck?.();
    } catch (err: any) {
    }
  }

  buildSharedOptionConfig(comp: any, b: OptionBindings, i: number): SharedOptionConfig {
    const qIndex = comp.resolveCurrentQuestionIndex();
    // Determine multi-answer from AUTHORITATIVE question data, not just
    // comp.isMultiMode which can be wrong on refresh if question data
    // hasn't fully loaded into the component yet.
    const authQ = this.quizService.questions?.[qIndex];
    const authCorrectCount = (authQ?.options ?? []).filter(
      (o: any) => o?.correct === true || o?.correct === 1 || String(o?.correct) === 'true'
    ).length;
    const isMulti = comp.isMultiMode || authCorrectCount > 1 || this.quizService.multipleAnswer;

    const isActuallySelected = b.isSelected;

    const optionKey = this.optionService.keyOf(b.option, i);
    const showCorrectOnTimeout = comp.timerExpiredForQuestion
      && (comp.timeoutCorrectOptionKeys?.has(optionKey) || !!b.option.correct);

    let shouldHighlight: boolean;
    if (isMulti && comp.hasUserClicked) {
      // Hard Guard: For multi-answer live interaction, the durable click set
      // is the only authority for which options should highlight.
      const qIdx = comp.getActiveQuestionIndex?.() ?? qIndex;
      const durableSet: Set<number> | undefined = comp._multiSelectByQuestion?.get(qIdx);
      const isInDurableSet = durableSet ? durableSet.has(i) : false;
      shouldHighlight = isInDurableSet || showCorrectOnTimeout;
    } else if (!comp.hasUserClicked) {
      // REFRESH PATH (both single & multi): Binding state is unreliable
      // because multiple init paths (generateOptionBindings, initializeFromConfig,
      // setOptionBindingsIfChanged) overwrite each other. Query the persisted
      // sel_Q* data directly from the service as the single source of truth.
      // Read from durable sel_Q* sessionStorage FIRST — the cleanest source.
      // Fall back to getSelectedOptionsForQuestion only if sel_Q* is empty
      // (e.g. single-answer wrong-only clicks where sel_Q* isn't written
      // until the correct answer is clicked).
      let saved: any[] = [];
      try {
        const raw = sessionStorage.getItem('sel_Q' + qIndex);
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
      const bText = (b.option?.text ?? '').trim().toLowerCase();
      // TEXT-ONLY PRIMARY MATCH: immune to synthetic ID mismatches and
      // position shifts from shuffled options. ID/index fallbacks are only
      // used when the saved entry has no text (legacy data).
      const matchEntry = saved.find((s: any) => {
        const sText = ((s as any).text ?? '').trim().toLowerCase();
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
        (comp.shouldResetBackground || (!isOnCorrectQuestion && currentSelections.length === 0))
        && !shouldHighlight,
      feedback: b.feedback ?? '',
      showFeedbackForOption: comp.showFeedbackForOption,
      optionsToDisplay: comp.optionsToDisplay,
      selectedOption: comp.selectedOption,
      currentQuestion: comp.currentQuestion,
      showFeedback: comp.showFeedback,
      correctMessage: comp.correctMessage,
      showCorrectMessage: !!comp.correctMessage,
      explanationText: '',
      showExplanation: false,
      selectedOptionIndex: comp.selectedOptionIndex,
      highlight: shouldHighlight
    };
  }

  getOptionBindings(comp: any, option: Option, idx: number, isSelected: boolean = false): OptionBindings {
    const correctOptionsCount =
      comp.optionsToDisplay?.filter((opt: any) => opt.correct).length ?? 0;
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
      showFeedback: comp.showFeedback,
      showFeedbackForOption: comp.showFeedbackForOption,
      highlightCorrectAfterIncorrect: comp.highlightCorrectAfterIncorrect(),
      highlightIncorrect: selected && !option.correct,
      highlightCorrect: selected && !!option.correct,
      allOptions: comp.optionsToDisplay,
      type: comp.resolveInteractionType(),
      appHighlightOption: false,
      appHighlightInputType: inferredType === 'multiple' ? 'checkbox' : 'radio',
      appHighlightReset: comp.shouldResetBackground,
      appResetBackground: comp.shouldResetBackground,
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
    } else if (comp.timerExpiredForQuestion) {
      const key = comp.keyOf(b.option, i);
      const cfg = comp.feedbackConfigs?.[key];
      if (cfg?.showFeedback) config = cfg;
    }

    if (!config) return null;

    const qIdx = comp.getActiveQuestionIndex();

    let correctIndicesArr: number[] = comp._correctIndicesByQuestion?.get(qIdx) ?? [];
    if (correctIndicesArr.length === 0) {
      const feedbackQ = comp.currentQuestion ?? comp.getQuestionAtDisplayIndex(qIdx);
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

  fullyResetRows(comp: any): void {
    for (let i = 0; i < (comp.optionBindings?.length ?? 0); i++) {
      const b = comp.optionBindings[i];
      b.isSelected = false;
      b.option.selected = false;
      b.option.highlight = false;
      b.option.showIcon = false;
      b.disabled = false;

      const id = b.option.optionId;
      const effectiveId = (id != null && id !== -1) ? id : i;
      b.showFeedbackForOption[effectiveId as any] = false;
    }

    comp.lockedIncorrectOptionIds?.clear();
  }

  syncSelectedFlags(comp: any): void {
    // Collision guard: when a binding has no real optionId, the fallback (array
    // index) can collide with another binding's real optionId (e.g. binding[0]
    // has optionId=1, binding[1] has no id so falls back to index 1 → collision).
    const realIdOwner = new Map<number, number>();
    for (let i = 0; i < (comp.optionBindings?.length ?? 0); i++) {
      const id = comp.optionBindings[i].option.optionId;
      if (id != null && id !== -1) realIdOwner.set(Number(id), i);
    }

    for (let i = 0; i < (comp.optionBindings?.length ?? 0); i++) {
      const b = comp.optionBindings[i];
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
    comp.forceDisableAll = true;
    for (const binding of comp.optionBindings ?? []) {
      if (binding.option) binding.option.active = false;
    }
    comp.clickService?.updateBindingSnapshots(comp);
    for (const opt of comp.optionsToDisplay ?? []) {
      if (opt) opt.active = false;
    }
    comp.cdRef.markForCheck();
  }

  clearForceDisableAllOptions(comp: any): void {
    comp.forceDisableAll = false;
    for (const binding of comp.optionBindings ?? []) {
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
    } catch { }

    comp.clickService?.updateBindingSnapshots(comp);
  }

  markRenderReady(comp: any, reason: string = ''): void {
    const bindingsReady =
      Array.isArray(comp.optionBindings) && comp.optionBindings.length > 0;

    const optionsReady =
      Array.isArray(comp.optionsToDisplay) && comp.optionsToDisplay.length > 0;

    if (bindingsReady && optionsReady) {
      comp.renderReady.set(true);
      comp.renderReadyChange.emit(true);
    }
  }

  // ── Inlined from OptionHydrationService ──────────────────────────

  private applySavedSelections(
    bindings: OptionBindings[] | null | undefined,
    savedIds: Set<number | string>
  ): void {
    if (!bindings?.length) return;
    for (const b of bindings) {
      const id = b?.option?.optionId;
      b.isSelected = id !== undefined && id !== null && savedIds.has(id);
    }
  }

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