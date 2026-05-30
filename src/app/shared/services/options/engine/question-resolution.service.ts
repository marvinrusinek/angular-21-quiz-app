import { inject, Injectable } from '@angular/core';

import { SK_DOT_CONFIRMED, SK_MULTI_PERFECT, SK_SEL_Q } from '../../../constants/session-keys';

import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';

import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

export interface QuestionResolutionResult {
  fullyResolvedCorrect: boolean;
  fullyResolvedWrong: boolean;
  dot: 'correct' | 'wrong' | undefined;
  multiPerfect: boolean;
  scoredCorrect: boolean;
  computedPerfect: boolean;
  computedImperfect: boolean;
  correctOpts: any[];
  isCanonMulti: boolean;
  liveSel: any[];
}

@Injectable({ providedIn: 'root' })
export class QuestionResolutionService {
  private readonly quizService = inject(QuizService);
  private readonly selectedOptionService = inject(SelectedOptionService);

  resolve(
    qIdx: number,
    opts?: {
      includeDot?: boolean;
      includeSelections?: boolean;
      includeWrongDetection?: boolean;
    }
  ): QuestionResolutionResult {
    const includeDot = opts?.includeDot !== false;
    const includeSelections = opts?.includeSelections !== false;
    const includeWrongDetection = opts?.includeWrongDetection === true;

    // Signal 1: dot status
    let dot: 'correct' | 'wrong' | undefined;
    if (includeDot) {
      dot = this.selectedOptionService.clickConfirmedDotStatus?.get?.(qIdx) as 'correct' | 'wrong' | undefined;
      if (!dot) {
        try {
          const stored = sessionStorage.getItem(SK_DOT_CONFIRMED + qIdx);
          if (stored === 'correct' || stored === 'wrong') dot = stored;
        } catch { /* ignore */ }
      }
    }

    // Signal 2: multi-answer perfect flag
    let multiPerfect = this.quizService._multiAnswerPerfect.get(qIdx) === true;
    if (!multiPerfect) {
      try { multiPerfect = sessionStorage.getItem(SK_MULTI_PERFECT + qIdx) === 'true'; } catch { /* ignore */ }
    }

    // Signal 3: scoring map (must use original index in shuffled mode)
    const scoreMap = this.quizService?.questionCorrectness as Map<number, boolean> | undefined;
    let scoredCorrect = false;
    if (scoreMap) {
      const qs: any = this.quizService;
      const isShuf = qs?.isShuffleEnabled?.() && qs?.shuffledQuestions?.length > 0;
      if (isShuf) {
        let effectiveQuizId = qs?.quizId || '';
        if (!effectiveQuizId) {
          try { effectiveQuizId = localStorage.getItem('lastQuizId') || ''; } catch { /* ignore */ }
        }
        if (effectiveQuizId) {
          const origIdx = qs?.scoringService?.quizShuffleService?.toOriginalIndex?.(effectiveQuizId, qIdx);
          if (typeof origIdx === 'number' && origIdx >= 0) {
            scoredCorrect = scoreMap.get(origIdx) === true;
          }
        }
      } else {
        scoredCorrect = scoreMap.get(qIdx) === true;
      }
    }

    // Signal 4: pristine correct options from quizInitialState
    const optsForQ: any[] =
      this.quizService?.questions?.[qIdx]?.options
      ?? this.quizService?.shuffledQuestions?.[qIdx]?.options
      ?? [];

    let correctOpts: any[] = [];
    try {
      const pq = this.quizService?.getPristineQuestionByText(
        this.quizService?.questions?.[qIdx]?.questionText
        ?? optsForQ?.[0]?.questionText
      );
      if (pq) {
        correctOpts = (pq.options ?? []).filter(
          (o: any) => isOptionCorrect(o)
        );
      }
    } catch { /* ignore */ }
    if (correctOpts.length === 0) {
      correctOpts = optsForQ.filter(
        (o: any) => isOptionCorrect(o)
      );
    }

    const isCanonMulti = correctOpts.length > 1;

    // Signal 5: selection comparison (only when requested)
    let liveSel: any[] = [];
    let computedPerfect = false;
    let computedImperfect = false;

    if (includeSelections) {
      let sel: any[] = [];
      try {
        const raw = sessionStorage.getItem(SK_SEL_Q + qIdx);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) sel = parsed;
        }
      } catch { /* ignore */ }
      if (sel.length === 0) {
        sel = this.selectedOptionService.getSelectedOptionsForQuestion?.(qIdx) ?? [];
      }

      liveSel = sel.filter((s: any) =>
        s?.selected === true || s?.showIcon === true || s?.highlight === true
      );

      if (correctOpts.length > 0 && liveSel.length > 0) {
        const wasPicked = (canon: any): boolean => {
          const cid = canon?.optionId;
          const ctxt = norm(canon?.text);
          return liveSel.some((s: any) =>
            (cid != null && s?.optionId === cid) ||
            (!!ctxt && norm(s?.text) === ctxt)
          );
        };
        const isCanonCorrectSel = (sItem: any): boolean => {
          const sid = sItem?.optionId;
          const stxt = norm(sItem?.text);
          return correctOpts.some((c: any) =>
            (sid != null && c?.optionId === sid) ||
            (!!stxt && norm(c?.text) === stxt)
          );
        };

        const allCovered = correctOpts.every(wasPicked);
        const noExtras = liveSel.every(isCanonCorrectSel);
        if (allCovered && noExtras) {
          computedPerfect = true;
        } else {
          computedImperfect = true;
        }
      }
    }

    // Combine: fullyResolvedCorrect
    const fullyResolvedCorrect =
      (scoredCorrect && (!isCanonMulti || multiPerfect || computedPerfect)) ||
      computedPerfect ||
      (!isCanonMulti && dot === 'correct') ||
      (isCanonMulti && multiPerfect);

    // Combine: fullyResolvedWrong (only when requested)
    let fullyResolvedWrong = false;
    if (includeWrongDetection) {
      fullyResolvedWrong =
        (!scoredCorrect || isCanonMulti) &&
        (computedImperfect ||
          dot === 'wrong' ||
          (isCanonMulti && dot === 'correct' && !multiPerfect));
    }

    return {
      fullyResolvedCorrect,
      fullyResolvedWrong,
      dot,
      multiPerfect,
      scoredCorrect,
      computedPerfect,
      computedImperfect,
      correctOpts,
      isCanonMulti,
      liveSel,
    };
  }

  /** Check whether a single option is among the canonical correct set. */
  isOptionCanonCorrect(
    option: { optionId?: number; text?: string } | null | undefined,
    correctOpts: any[]
  ): boolean {
    if (!option || !correctOpts.length) return false;
    const optId = option.optionId;
    const optText = norm(option.text);
    return correctOpts.some((c: any) =>
      (optId != null && c?.optionId === optId) ||
      (!!optText && norm(c?.text) === optText)
    );
  }
}
