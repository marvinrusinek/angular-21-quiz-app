import { inject, Service } from '@angular/core';

import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { Option } from '../../../models/Option.model';
import { ScoreAnalysisItem } from '../../../models/Final-Result.model';
import { norm } from '../../../utils/text-norm';
import { SelectedOptionService } from '../../state/selectedoption.service';

/**
 * Builds the per-question review analysis from the CURRENT (fresh) selection
 * state, at completion. It intentionally mirrors AccordionComponent's
 * correctness logic (option matching + normalized text comparison) so the
 * captured counts are identical to what the review shows on a fresh completion.
 *
 * Why this exists: the accordion re-derives correctness from live selection maps
 * (SelectedOptionService), which get wiped when the user leaves Results. By
 * capturing this analysis into the persisted FinalResult snapshot at completion,
 * the review stays correct on REVISIT (matched by question text, so it's immune
 * to the wipe AND to any shuffle/order change). Pure over its inputs.
 */
@Service()
export class ScoreAnalysisService {
  private readonly selectedOptionService = inject(SelectedOptionService);

  buildAnalysis(questions: readonly QuizQuestion[]): ScoreAnalysisItem[] {
    return (questions ?? []).map((q, i) => {
      const options = q.options ?? [];
      const selected = this.getSelectedOptions(options, i);
      const selectedTexts = selected.map((s) => norm(s.text));

      const correctOptions = options.filter((o) => o.correct === true);
      const correctTexts = correctOptions.map((o) => norm(o.text ?? ''));
      // Mirror the accordion exactly: ALL correct answers must be selected.
      const wasCorrect = correctTexts.every((ct) => selectedTexts.includes(ct));

      return {
        questionIndex: i,
        questionText: q.questionText ?? '',
        wasCorrect,
        selectedOptionIds: selected.map((s) => s.optionId).filter((id) => id.length > 0),
        correctOptionIds: correctOptions
          .map((o) => (o.optionId != null ? String(o.optionId) : ''))
          .filter((id) => id.length > 0)
      };
    });
  }

  // ── selection reading (mirrors AccordionComponent.getSelectedOptionsForQuestion) ──
  private getSelectedOptions(options: Option[], index: number): { text: string; optionId: string }[] {
    const raw = this.selectedOptionService.rawSelectionsMap.get(index);
    const source: { optionId?: number; text?: string }[] =
      raw && raw.length > 0 ? raw : (this.selectedOptionService.selectedOptionsMap.get(index) ?? []);

    return source
      .map((sel) => {
        const idx = this.matchOption(options, sel);
        const text = sel.text || (idx >= 0 ? options[idx]?.text : '') || '';
        const optionId =
          idx >= 0 && options[idx]?.optionId != null
            ? String(options[idx].optionId)
            : sel.optionId != null
              ? String(sel.optionId)
              : '';
        return { text, optionId };
      })
      .filter((o) => o.text.length > 0);
  }

  private matchOption(options: Option[], sel: { optionId?: number; text?: string }): number {
    let idx = options.findIndex(
      (o) =>
        o.optionId != null && sel.optionId != null && sel.optionId !== -1 &&
        String(o.optionId) === String(sel.optionId)
    );
    if (idx === -1 && sel.text) {
      idx = options.findIndex((o) => o.text === sel.text);
    }
    if (idx === -1 && typeof sel.optionId === 'number' && sel.optionId >= 0 && sel.optionId < options.length) {
      idx = sel.optionId;
    }
    return idx;
  }
}
