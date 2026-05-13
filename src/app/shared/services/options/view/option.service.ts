import { Injectable } from '@angular/core';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';

@Injectable({ providedIn: 'root' })
export class OptionService {
  /**
   * Use the same key shape everywhere (STRING so we don't lose non-numeric ids)
   * Stable per-row key: prefer numeric optionId; fallback to stableKey + index
   */
  keyOf(o: Option, i: number): string {
    const idPart = 
      (o && o.optionId != null && o.optionId !== -1) ? String(o.optionId) : 'opt';
    return `${idPart}-${i}`;
  }

  /**
   * Returns display text for an option, allowing for custom formatting if needed
   */
  getOptionDisplayText(option: Option, idx: number): string {
    return `${idx + 1}. ${option.text || ''}`;
  }

  /**
   * Returns the icon to display for an option based on its state
   */
  getOptionIcon(binding: OptionBindings, _i: number): string {
    const option = binding.option;
    if (option.showIcon === false) { return ''; }

    if (option.correct) return 'check';
    if (binding.isSelected && !option.correct) return 'close';

    return '';
  }

  /**
   * Returns CSS classes for an option based on its bindings and state
   */
  getOptionClasses(
    binding: OptionBindings,
    idx: number,
    highlightedOptionIds: Set<number | string>,
    flashDisabledSet: Set<number | string>,
    isLocked: boolean = false,
    timerExpiredForQuestion: boolean = false
  ): { [key: string]: boolean } {
    const option = binding.option;
    const optId = option.optionId ?? -1;
    const isSelected = binding.isSelected === true;
    const isHighlighted = !!option.highlight;
    const showCorrectOnTimeout = timerExpiredForQuestion && !!option.correct;

    return {
      'selected': isSelected,
      'selected-option': isSelected,
      'correct-option': (isHighlighted && !!option.correct) || showCorrectOnTimeout,
      'incorrect-option': !!(isHighlighted && !option.correct),
      'highlighted': isHighlighted || highlightedOptionIds.has(idx),
      'flash-red': flashDisabledSet.has(optId),  // match original 'flash-red'
      'disabled-option': !!binding.disabled,     // match original 'disabled-option'
      'locked-option': isLocked && !binding.disabled  // match original 'locked-option'
    };
  }

  /**
   * Returns cursor style for option - 'not-allowed' for disabled/incorrect
   * options or when timer expired
   */
  getOptionCursor(
    _binding: OptionBindings,
    _index: number,
    isDisabled: boolean,
    timerExpiredForQuestion: boolean
  ): string {
    if (isDisabled || timerExpiredForQuestion) return 'default';

    return 'pointer';
  }
}