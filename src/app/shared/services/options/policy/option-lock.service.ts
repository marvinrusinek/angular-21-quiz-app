import { Injectable, inject } from '@angular/core';

import { OptionBindings } from '../../../models/OptionBindings.model';

import { SelectedOptionService } from '../../state/selectedoption.service';

@Injectable({ providedIn: 'root' })
export class OptionLockService {
  // ── injects ─────────────────────────────────────────────────────
  private selectedOptionService = inject(SelectedOptionService);

  // ── public methods ──────────────────────────────────────────────
  isLocked(
    binding: OptionBindings,
    displayIndex: number,
    questionIndex: number
  ): boolean {
    try {
      // Prefer stable optionId; fallback to display index
      const id = binding.option.optionId ?? displayIndex;
      return this.selectedOptionService.isOptionLocked(questionIndex, id);
    } catch {
      return false;
    }
  }
}