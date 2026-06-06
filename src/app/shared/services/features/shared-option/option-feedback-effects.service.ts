import { Injectable, effect } from '@angular/core';

import { OptionBindings } from '../../../models/OptionBindings.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

import type { SharedOptionComponent } from '../../../../components/question/answer/shared-option-component/shared-option.component';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

type Host = SharedOptionComponent;

/**
 * Owns the SharedOptionComponent's two feedback/highlight constructor effects:
 * the multi-answer auto-disable (rebuilds bindings the moment every pristine-
 * correct option is selected) and the timer-expiry watcher (stamps
 * correct/incorrect cssClasses when the timer reports THIS question expired).
 *
 * These are the click-feedback-pipeline-adjacent effects, so the bodies are
 * moved verbatim (`this.` → host-as-any). Both are created here in one method,
 * in their original order, called LAST in the component constructor so overall
 * effect-creation order is preserved. Must run in the host's injection context.
 */
@Injectable({ providedIn: 'root' })
export class OptionFeedbackEffectsService {
  registerFeedbackEffects(host: Host): void {
    const h = host as any;

    // Multi-answer auto-disable. Reactively watches the selections signal
    // and rebuilds optionBindings with fresh refs the moment every pristine-
    // correct option for THIS rendered question is selected. Pure Angular
    // reactivity — OnPush option-item children pick up new `b` refs via
    // ngOnChanges, no DOM, no detectChanges hacks.
    //
    // Identifies the rendered question by option-text fingerprint
    // (matching the bindings against pristine quizInitialState) instead
    // of trusting currentQuestionIndex, which can lag during click flow.
    effect(() => {
      const selectionsMap = h.selectedOptionService.selectedOptionsMapSig();
      if (!h.optionBindings() || h.optionBindings().length === 0) return;

      // Resolve pristine correct texts for the current question.
      const qIdx = h.currentQuestionIndex ?? h.quizService.currentQuestionIndex ?? 0;
      const qText = (h.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText
        ?? (h.quizService as any)?.questions?.[qIdx]?.questionText;
      const pristineCorrectTexts = h.quizService.getPristineCorrectTextsForQuestion(qText);
      if (pristineCorrectTexts.size < 2) return;

      // Find selections (across any question slot) whose texts cover every
      // pristine correct text. Avoids dependence on currentQuestionIndex.
      let allCorrectSelected = false;
      for (const sels of selectionsMap.values()) {
        const selectedTexts = new Set(
          (sels ?? []).map((s: SelectedOption) => norm(s?.text)).filter((t: string) => !!t)
        );
        if ([...pristineCorrectTexts].every((t: string) => selectedTexts.has(t))) {
          allCorrectSelected = true;
          break;
        }
      }
      if (!allCorrectSelected) return;

      // If auto-reveal already stamped _autoRevealedCorrect on the
      // bindings, do not overwrite — auto-reveal's highlight + disable
      // state is authoritative for exhausted-incorrect scenarios.
      if (h.optionBindings().some((b: OptionBindings) => b?._autoRevealedCorrect)) return;

      // Rebuild every binding with fresh refs so OnPush option-items pick
      // up the new disabled state via ngOnChanges.
      const correctTexts = pristineCorrectTexts;
      let mutated = false;
      const next = h.optionBindings().map((b: OptionBindings) => {
        const myText = norm(b?.option?.text);
        const isCorrect = correctTexts.has(myText);
        const targetDisabled = !isCorrect;
        if (b.disabled !== targetDisabled) mutated = true;
        return {
          ...b,
          disabled: targetDisabled,
          isCorrect,
          option: b.option ? {
            ...b.option,
            active: isCorrect
          } : b.option
        };
      });
      if (mutated) {
        h.optionBindings.set(next);
        h.cdRef.markForCheck();
      }
    });

    // Independent timer-expiry watcher: triggers when the timer service
    // authoritatively reports the CURRENT question as expired. Updates
    // bindings via cssClasses so Angular's ngClass paints correctly —
    // no direct DOM manipulation (which bypassed reactive cleanup and
    // left .correct-option leaked on revisited questions).
    effect(() => {
      // Track BOTH signals so the effect re-fires when either changes —
      // but gate on the authoritative expired-index check below.
      const elapsed = h.timerService.elapsedTimeSig();
      const expiredForIdx = h.timerService.expiredForQuestionIndexSig();
      const duration = h.timerService.timePerQuestion;
      const qIdx = h.currentQuestionIndex ?? h.quizService.currentQuestionIndex ?? 0;
      // Authoritative gate: only fire when the timer service explicitly
      // marks THIS question as expired. The old `elapsed >= duration`
      // check could fire on stale elapsed reads during Q→Q transitions,
      // stamping the next question's bindings as expired.
      if (expiredForIdx !== qIdx) return;
      if (!(elapsed > 0 && elapsed >= duration)) return;
      if (h._timerExpiryHandled) return;

      h._timerExpiryHandled = true;
      h.timerExpiredForQuestion.set(true);

      // Get correct answer texts from canonical question data
      const question = h.quizService.questions?.[qIdx] ?? h.currentQuestion();
      const displayOpts = h.optionsToDisplay?.length
        ? h.optionsToDisplay
        : question?.options ?? [];
      const correctTexts = new Set<string>();
      for (const opt of displayOpts) {
        if (isOptionCorrect(opt)) {
          correctTexts.add(norm(opt.text));
        }
      }

      // Stamp bindings via cssClasses + new ref so OnPush option-items
      // re-render. ngClass will apply correct-option/incorrect-option
      // classes through the normal Angular pipeline.
      const updated = (h.optionBindings() ?? []).map((b: OptionBindings) => {
        if (!b) return b;
        const optText = norm(b.option?.text);
        const isCorrect = correctTexts.has(optText);
        return {
          ...b,
          cssClasses: {
            ...(b.cssClasses || {}),
            'correct-option': isCorrect,
            'incorrect-option': !isCorrect && !!b.isSelected
          },
          _timerExpiredStamped: true,
          _timerExpiredStampedForIndex: qIdx,
          disabled: true
        };
      });
      h.optionBindings.set(updated);
      h.cdRef.markForCheck();
    });
  }
}
