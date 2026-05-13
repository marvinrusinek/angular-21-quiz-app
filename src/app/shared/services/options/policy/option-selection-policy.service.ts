import { Injectable } from '@angular/core';

import { OptionBindings } from '../../../models/OptionBindings.model';

@Injectable({ providedIn: 'root' })
export class OptionSelectionPolicyService {
  enforceSingleSelection(params: {
    optionBindings: OptionBindings[];
    selectedBinding: OptionBindings;
    showFeedbackForOption: Record<number, boolean>;
    updateFeedbackState: (id: number) => void;
  }): void {
    const { optionBindings, selectedBinding } = params;

    for (const binding of optionBindings ?? []) {
      const isTarget = binding === selectedBinding;

      if (!isTarget && binding.isSelected) {
        if (binding.option) binding.option.selected = false;
        binding.isSelected = false;  // sync both flags
      }
    }
  }
}