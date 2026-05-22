import { inject, Injectable } from '@angular/core';

import { Option } from '../../../../shared/models/Option.model';
import { OptionBindings } from '../../../../shared/models/OptionBindings.model';
import { SelectedOption } from '../../../../shared/models/SelectedOption.model';

import { AnswerOptionsService } from './answer-options.service';

@Injectable({ providedIn: 'root' })
export class AnswerBindingsService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly answerOptionsService = inject(AnswerOptionsService);

  rebuildOptionBindings(options: Option[]): OptionBindings[] {
    if (!options?.length) return [];

    const cloned: Option[] =
      typeof structuredClone === 'function'
        ? structuredClone(options) : JSON.parse(JSON.stringify(options));

    const rebuilt = cloned.map((option, index) =>
      this.buildFallbackBinding(option, index)
    );

    for (const binding of rebuilt) {
      binding.allOptions = cloned;
      binding.optionsToDisplay = cloned;
    }

    return rebuilt;
  }

  buildFallbackBinding(option: Option, index: number): OptionBindings {
    return {
      option,
      index,
      isSelected: !!option.selected,
      isCorrect: option.correct ?? false,

      showFeedback: true,
      feedback:
        option.feedback?.trim() ||
        (option.correct
          ? 'Great job — that answer is correct.'
          : 'Not quite — see the explanation above.'),

      highlight: !!option.highlight,

      showFeedbackForOption: {},
      appHighlightOption: false,
      highlightCorrectAfterIncorrect: false,
      highlightIncorrect: false,
      highlightCorrect: false,
      styleClass: '',
      disabled: false,
      type: 'single',
      appHighlightInputType: 'radio',
      allOptions: [],
      appHighlightReset: false,
      ariaLabel: `Option ${index + 1}`,
      appResetBackground: false,
      optionsToDisplay: [],
      checked: !!option.selected,
      change: () => {},
      active: true
    } as OptionBindings;
  }

  updateVisualBindings(
    currentBindings: OptionBindings[],
    enrichedOption: SelectedOption,
    type: 'single' | 'multiple',
  ): OptionBindings[] {
    if (!currentBindings?.length) return [];

    const isSingle = type === 'single';
    const disableOthers = isSingle && enrichedOption.selected === true;

    return currentBindings.map((binding, index) => {
      const bindingId = this.answerOptionsService.getEffectiveOptionId(
        binding.option,
        index
      );

      const matchesClickedOption = bindingId === enrichedOption.optionId;

      if (matchesClickedOption) {
        return this.buildClickedOptionBinding(binding, enrichedOption);
      }

      if (isSingle) {
        return this.buildUnselectedSingleAnswerBinding(binding, disableOthers);
      }

      return binding;
    });
  }

  private buildClickedOptionBinding(
    binding: OptionBindings,
    enrichedOption: SelectedOption
  ): OptionBindings {
    const selected = enrichedOption.selected === true;

    const newOption = {
      ...binding.option,
      selected,
      highlight: selected,
      showIcon: selected
    };

    return {
      ...binding,
      option: newOption,
      isSelected: selected,
      highlight: selected,
      checked: selected,
      showFeedback: true,
      disabled: false
    } as OptionBindings;
  }

  private buildUnselectedSingleAnswerBinding(
    binding: OptionBindings,
    disableOthers: boolean,
  ): OptionBindings {
    const isThisOptionCorrect =
      binding.option?.correct === true ||
      String(binding.option?.correct) === 'true';

    const newOption = {
      ...binding.option,
      selected: false,
      highlight: false,
      showIcon: false
    };

    return {
      ...binding,
      option: newOption,
      isSelected: false,
      highlight: false,
      checked: false,
      disabled:
        disableOthers && !isThisOptionCorrect
          ? true
          : binding.disabled
    } as OptionBindings;
  }

  hydrateBindingsFromSavedSelections(
    currentBindings: OptionBindings[],
    savedSelections: SelectedOption[],
    isMulti: boolean
  ): OptionBindings[] {
    if (!currentBindings?.length || !savedSelections?.length) {
      return currentBindings ?? [];
    }

    const savedIds = new Set(savedSelections.map(selection => String(selection.optionId)));

    const savedTexts = new Set(
      savedSelections.map(selection =>
        (selection.text || '').trim().toLowerCase(),
      )
    );

    return currentBindings.map(binding => {
      const id = binding.option?.optionId;
      const text = binding.option?.text;

      const idMatch = id != null && savedIds.has(String(id));
      const textMatch =
        !!(text && savedTexts.has(text.trim().toLowerCase()));

      const isSelected = isMulti ? false : idMatch || textMatch;

      const newOption = {
        ...binding.option,
        selected: isSelected,
        highlight: isSelected,
        showIcon: isSelected
      };

      return {
        ...binding,
        option: newOption,
        isSelected,
        highlight: isSelected,
        checked: isSelected,
        showFeedback: true
      } as OptionBindings;
    });
  }
}