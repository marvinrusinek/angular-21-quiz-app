import { Service, Injector, inject } from '@angular/core';

import { QuestionType } from '../../../models/question-type.enum';

import { OptionBindings } from '../../../models/OptionBindings.model';

import { QuizService } from '../../data/quiz.service';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

export interface LockIncorrectResult {
  shouldLockIncorrectOptions: boolean;
  lockedIncorrectOptionIds: Set<number>;
  resolvedTypeForLock: QuestionType;
  hasCorrectSelectionForLock: boolean;
  allCorrectSelectedForLock: boolean;
}

@Service()
export class OptionLockPolicyService {
  // ── injects ─────────────────────────────────────────────────────
  private injector = inject(Injector);

  // ── public methods ──────────────────────────────────────────────
  updateLockedIncorrectOptions(params: {
    bindings: OptionBindings[];
    forceDisableAll: boolean;
    resolvedType: QuestionType;
    computeShouldLockIncorrectOptions: (
      resolvedType: QuestionType,
      hasCorrectSelection: boolean,
      allCorrectSelected: boolean
    ) => boolean;
  }): LockIncorrectResult {
    const bindings = params.bindings ?? [];

    if (!bindings.length) {
      return this.buildLockResult(false, new Set<number>(), params.resolvedType, false, false);
    }

    if (params.forceDisableAll) {
      const locked = this.applyForceDisableAll(bindings);
      return this.buildLockResult(true, locked, params.resolvedType, false, false);
    }

    const { hasCorrectSelection, allCorrectSelected, isPerfect } =
      this.computeSelectionState(bindings);

    const shouldLockIncorrect = params.computeShouldLockIncorrectOptions(
      params.resolvedType,
      hasCorrectSelection,
      allCorrectSelected
    );

    if (!shouldLockIncorrect && !isPerfect) {
      this.unlockAllBindings(bindings);
      return this.buildLockResult(
        false, new Set<number>(), params.resolvedType, hasCorrectSelection, allCorrectSelected
      );
    }

    const locked = this.applyGranularLocking(
      bindings, isPerfect, allCorrectSelected, hasCorrectSelection, params.resolvedType
    );
    return this.buildLockResult(
      true, locked, params.resolvedType, hasCorrectSelection, allCorrectSelected
    );
  }

  private buildLockResult(
    shouldLock: boolean,
    locked: Set<number>,
    resolvedType: QuestionType,
    hasCorrectSelection: boolean,
    allCorrectSelected: boolean
  ): LockIncorrectResult {
    return {
      shouldLockIncorrectOptions: shouldLock,
      lockedIncorrectOptionIds: locked,
      resolvedTypeForLock: resolvedType,
      hasCorrectSelectionForLock: hasCorrectSelection,
      allCorrectSelectedForLock: allCorrectSelected
    };
  }

  // Disable every binding and return the set of their optionIds.
  private applyForceDisableAll(bindings: OptionBindings[]): Set<number> {
    for (const b of bindings) {
      b.disabled = true;
      if (b.option) b.option.active = false;
    }
    return new Set(
      bindings
        .map(b => b.option?.optionId)
        .filter((id): id is number => typeof id === 'number')
    );
  }

  // Resolve canonical correctness, backfill binding flags, and derive selection state.
  private computeSelectionState(bindings: OptionBindings[]): {
    hasCorrectSelection: boolean;
    allCorrectSelected: boolean;
    isPerfect: boolean;
  } {
    // Canonical correct indices from quizService (overrides stale binding flags)
    const canonicalCorrectIdxs = this.resolveCanonicalCorrectIdxs(bindings);

    const isCorrectBinding = (b: OptionBindings, i: number) => {
      if (canonicalCorrectIdxs.size > 0) return canonicalCorrectIdxs.has(i);
      if (b.isCorrect === true) return true;
      return isOptionCorrect(b.option);
    };

    // Backfill correct flags onto bindings so downstream code sees them.
    // IMPORTANT: Only set isCorrect on the BINDING — do NOT mutate
    // b.option.correct, because b.option is a shared reference to
    // quizService.questions[].options[]. Mutating it corrupts the live
    // data and makes multi-answer guards think the question is single-answer.
    if (canonicalCorrectIdxs.size > 0) {
      for (const [i, b] of bindings.entries()) {
        const isC = canonicalCorrectIdxs.has(i);
        b.isCorrect = isC;
      }
    }

    const hasCorrectSelection = bindings.some(
      (b, i) => b.isSelected && isCorrectBinding(b, i)
    );
    const correctBindings = bindings.filter((b, i) => isCorrectBinding(b, i));
    const allCorrectSelected =
      correctBindings.length > 0 && correctBindings.every(b => b.isSelected);

    const hasIncorrectSelection = bindings.some(
      (b, i) => b.isSelected && !isCorrectBinding(b, i)
    );
    const isPerfect = allCorrectSelected && !hasIncorrectSelection;

    return { hasCorrectSelection, allCorrectSelected, isPerfect };
  }

  // Re-enable every binding (no locking applies).
  private unlockAllBindings(bindings: OptionBindings[]): void {
    for (const b of bindings) {
      b.disabled = false;
      if (b.option) b.option.active = true;
    }
  }

  // Apply granular per-binding locking and return the set of locked indices.
  private applyGranularLocking(
    bindings: OptionBindings[],
    isPerfect: boolean,
    allCorrectSelected: boolean,
    hasCorrectSelection: boolean,
    resolvedType: QuestionType
  ): Set<number> {
    const locked = new Set<number>();
    for (const b of bindings) {
      // GRANULAR LOCKING:
      // 1. If perfectly resolved, disable everything.
      // 2. If all correct found but not perfect, disable UNSELECTED options ONLY.
      //    (This allows the user to unselect the incorrect ones).
      // 3. If single answer and correct selection found, disable everything.
      let shouldDisable = false;
      if (isPerfect) {
        shouldDisable = true;
      } else if (allCorrectSelected) {
        // Multi-answer: Got all corrects, but maybe some incorrects too.
        // Disable everything EXCEPT the currently selected ones (to allow unselecting).
        shouldDisable = !b.isSelected;
      } else if (resolvedType === QuestionType.SingleAnswer && hasCorrectSelection) {
        // Single-answer: unlock the selected one so it stays 'alive', lock others
        shouldDisable = !b.isSelected;
      }

      b.disabled = shouldDisable;
      if (b.option) b.option.active = !shouldDisable;

      const bIdx = b.index;
      if (shouldDisable && bIdx != null) locked.add(bIdx);
    }
    return locked;
  }

  // ── private methods ─────────────────────────────────────────────

  // Resolve canonical correct indices for a binding set by text-matching
  // against quizInitialState (the immutable structuredClone of QUIZ_DATA).
  // Pristine is the source of truth — quizService.questions[] can have
  // mutated/missing correct flags after gameplay, which makes multi-answer
  // questions appear single-answer here.
  private resolveCanonicalCorrectIdxs(bindings: OptionBindings[]): Set<number> {
    try {
      const quizSvc: any = this.injector.get(QuizService, null);
      if (!bindings.length) return new Set<number>();
      const bindingTexts = bindings.map(b => norm(b?.option?.text)).filter(Boolean);
      if (!bindingTexts.length) return new Set<number>();
      // Build set of pristine correct option texts by matching the bindings'
      // option-text fingerprint against the immutable quizInitialState bundle.
      const bundle: any[] = quizSvc?.quizInitialState ?? [];
      let pristineCorrectTexts: Set<string> | null = null;
      outer: for (const quiz of bundle) {
        for (const pq of (quiz?.questions ?? [])) {
          const pqOpts = pq?.options ?? [];
          if (pqOpts.length !== bindings.length) continue;
          // Match if every binding text appears among pristine option texts.
          const pqTexts = pqOpts.map((o: any) => norm(o?.text));
          const allMatch = bindingTexts.every(bt => pqTexts.includes(bt));
          if (!allMatch) continue;
          pristineCorrectTexts = new Set(
            pqOpts
              .filter((o: any) => isOptionCorrect(o))
              .map((o: any) => norm(o?.text))
          );
          break outer;
        }
      }
      // Fallback to live questions[] if pristine match failed.
      if (!pristineCorrectTexts) {
        const allQs: any[] = quizSvc?.questions ?? [];
        const matchedQ = allQs.find((q: any) => {
          const opts = q?.options ?? [];
          if (opts.length !== bindings.length) return false;
          return opts.every(
            (o: any, i: number) => norm(o?.text) === bindingTexts[i]
          );
        });
        if (!matchedQ) return new Set<number>();
        const set = new Set<number>();
        for (const [i, o] of (matchedQ.options ?? []).entries()) {
          if (isOptionCorrect(o)) set.add(i);
        }
        return set;
      }
      // Map pristine correct texts to binding indices in display order.
      const set = new Set<number>();
      for (let i = 0; i < bindings.length; i++) {
        if (pristineCorrectTexts.has(bindingTexts[i])) set.add(i);
      }
      return set;
    } catch {
      return new Set<number>();
    }
  }
}