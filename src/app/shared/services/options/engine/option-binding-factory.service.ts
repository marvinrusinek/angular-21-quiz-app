import { Service } from '@angular/core';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

export interface OptionBindingFactoryConfig {
  optionsToDisplay: Option[];
  type: 'single' | 'multiple';

  // UI/config flags from SOC
  showFeedback: boolean;
  showFeedbackForOption: Record<number, boolean> | null | undefined;

  highlightCorrectAfterIncorrect: boolean;
  shouldResetBackground: boolean;

  // Used by template/aria
  ariaLabelPrefix?: string;

  // Called when a binding is “changed” (click/change event)
  onChange: (opt: SelectedOption, idx: number) => void;

  /**
   * Provide selection truth. Prefer passing a function that reads your
   * SelectedOptionService / bindings selection state.
   */
  isSelected: (opt: Option) => boolean;

  /**
   * Provide disabled truth. Default is false; you can later wire
   * lock/disable policies here instead of using option.selected.
   */
  isDisabled?: (opt: Option, idx: number) => boolean;
}

@Service()
export class OptionBindingFactoryService {
  // ── public methods ──────────────────────────────────────────────
  createBindings(cfg: OptionBindingFactoryConfig): OptionBindings[] {
    const opts = Array.isArray(cfg.optionsToDisplay) ? cfg.optionsToDisplay : [];

    // Infer input type from correctness count (your prior behavior)
    const correctOptionsCount = opts.reduce(
      (count, o) => (o?.correct ? count + 1 : count), 0
    );
    const inferredType: 'single' | 'multiple' =
      correctOptionsCount > 1 ? 'multiple' : 'single';

    const inputType = inferredType === 'multiple' ? 'checkbox' : 'radio';
    const ariaPrefix = (cfg.ariaLabelPrefix ?? 'Option').trim() || 'Option';

    const bindings: OptionBindings[] = [];

    for (let idx = 0; idx < opts.length; idx++) {
      const option = opts[idx];
      const selected = cfg.isSelected(option);
      const disabled = cfg.isDisabled ? cfg.isDisabled(option, idx) : false;

      const cloned = {
        ...structuredClone(option),
        feedback: option?.feedback ?? 'No feedback available',
        // Clear stale visual flags carried over from prior question state
        highlight: false,
        selected: false
      };

      bindings.push({
        option: cloned,
        index: idx,

        feedback: option?.feedback ?? 'No feedback available',
        isCorrect: option?.correct ?? false,

        showFeedback: cfg.showFeedback,
        showFeedbackForOption: cfg.showFeedbackForOption,

        highlightCorrectAfterIncorrect: cfg.highlightCorrectAfterIncorrect,
        highlightIncorrect: selected && !option?.correct,
        highlightCorrect: selected && !!option?.correct,

        allOptions: opts,

        // Prefer the canonical type passed by SOC; keep inferred for input type only
        type: cfg.type,

        appHighlightOption: false,
        appHighlightInputType: inputType,
        appHighlightReset: cfg.shouldResetBackground,
        appResetBackground: cfg.shouldResetBackground,

        optionsToDisplay: opts,

        isSelected: selected,
        active: option?.active ?? true,

        // Event handler
        change: () => cfg.onChange(option as unknown as SelectedOption, idx),

        // Never derive disabled from option.selected
        disabled: !!disabled,

        ariaLabel: `${ariaPrefix} ${idx + 1}`,
        checked: selected,
        cssClasses: {},
        optionIcon: '',
        optionCursor: 'default'
      } as OptionBindings);
    }

    return bindings;
  }
}