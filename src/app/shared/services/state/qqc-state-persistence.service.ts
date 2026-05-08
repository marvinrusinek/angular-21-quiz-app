import { Injectable } from '@angular/core';

import { Option } from '../../models/Option.model';

/**
 * Parameters for saving QQC state to sessionStorage.
 */
export interface QqcSaveStateParams {
  questionIndex: number;
  explanationText: string;
  displayMode: string;
  optionsToDisplay: Option[];
  selectedOptions: any[];
  feedbackText: string;
}

/**
 * Raw data restored from sessionStorage.
 * The component is responsible for applying this to its own state.
 */
export interface QqcRestoredState {
  explanationText: string;
  displayMode: 'question' | 'explanation';
  parsedOptions: any[] | null;
  selectedOptions: any[];
  feedbackText: string;
}

@Injectable({ providedIn: 'root' })
export class QqcStatePersistenceService {

  /**
   * Saves quiz question state to sessionStorage.
   * Preserves explanation text, display mode, options, selected options,
   * and feedback text keyed by question index.
   */
  saveState(params: QqcSaveStateParams): void {
    try {
      const { questionIndex } = params;

      if (params.explanationText) {
        sessionStorage.setItem(
          `explanationText_${questionIndex}`,
          params.explanationText
        );
      }

      if (params.displayMode) {
        sessionStorage.setItem(
          `displayMode_${questionIndex}`,
          params.displayMode
        );      }

      if (params.optionsToDisplay?.length > 0) {
        sessionStorage.setItem(
          `options_${questionIndex}`,
          JSON.stringify(params.optionsToDisplay)
        );
      }

      if (params.selectedOptions?.length > 0) {
        sessionStorage.setItem(
          `selectedOptions_${questionIndex}`,
          JSON.stringify(params.selectedOptions)
        );
      }

      if (params.feedbackText) {
        sessionStorage.setItem(`feedbackText_${questionIndex}`, params.feedbackText);
      }
    } catch (error: any) {
      // Error saving quiz state
    }
  }

  /**
   * Reads quiz question state from sessionStorage.
   * Returns raw parsed data; the component applies it to its own state.
   */
  restoreState(questionIndex: number): QqcRestoredState {
    const storageIndex = !Number.isNaN(questionIndex) ? questionIndex : 0;

    const explanationKey = `explanationText_${storageIndex}`;
    const displayModeKey = `displayMode_${storageIndex}`;
    const optionsKey = `options_${storageIndex}`;
    const selectedOptionsKey = `selectedOptions_${storageIndex}`;
    const feedbackKey = `feedbackText_${storageIndex}`;

    // Restore explanation text
    const explanationText =
      sessionStorage.getItem(explanationKey) ||
      sessionStorage.getItem('explanationText') ||
      '';

    // Restore display mode
    const rawDisplayMode =
      sessionStorage.getItem(displayModeKey) ||
      sessionStorage.getItem('displayMode');
    const displayMode: 'question' | 'explanation' =
      rawDisplayMode === 'explanation' ? 'explanation' : 'question';

    // Restore options
    let parsedOptions: any[] | null = null;
    const optionsData =
      sessionStorage.getItem(optionsKey) ||
      sessionStorage.getItem('options');
    if (optionsData) {
      try {
        const parsed = JSON.parse(optionsData);
        if (Array.isArray(parsed) && parsed.length > 0) parsedOptions = parsed;
      } catch (error: any) {
        // Error parsing options data
      }
    }

    // Restore selected options (full objects, not just IDs)
    let selectedOptions: any[] = [];
    const selectedOptionsData =
      sessionStorage.getItem(selectedOptionsKey) ||
      sessionStorage.getItem('selectedOptions');
    if (selectedOptionsData) {
      try {
        const parsed = JSON.parse(selectedOptionsData);
        if (Array.isArray(parsed) && parsed.length > 0) {
          selectedOptions = parsed.filter((o: any) => o.optionId !== undefined);
        }
      } catch (error: any) {
        // Error parsing selected options data
      }
    }

    // Restore feedback text
    const feedbackText =
      sessionStorage.getItem(feedbackKey) ||
      sessionStorage.getItem('feedbackText') ||
      '';

    return {
      explanationText,
      displayMode,
      parsedOptions,
      selectedOptions,
      feedbackText
    };
  }
}