import { inject, Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { CqcFetGuardService } from './cqc-fet-guard.service';

import type { CodelabQuizContentComponent } from '../../../../containers/quiz/quiz-content/codelab-quiz-content.component';

type Host = CodelabQuizContentComponent;

/**
 * Manages the displayText$ subscription for CodelabQuizContentComponent.
 * Extracted from CqcOrchestratorService.
 *
 * Responsible for:
 * - runSubscribeToDisplayText: the central pipeline subscription that decides
 *   what text (question or FET) to write into the qText DOM element
 */
@Injectable({ providedIn: 'root' })
export class CqcDisplayTextService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly fetGuard = inject(CqcFetGuardService);

  runSubscribeToDisplayText(host: Host): void {
    host.combinedText$ = host.displayText$;

    if (host.combinedSub) host.combinedSub.unsubscribe();

    host.combinedSub = host.combinedText$
      .pipe(takeUntilDestroyed(host.destroyRef))
      .subscribe({
        next: (text: string) => {

          let finalText = text;
          const lowerText = (text ?? '').toLowerCase();
          // Read currentIdx from the input signal — host.currentIndex is a
          // plain field updated asynchronously by an effect, so it lags
          // questionIndex() by a microtask. Without this, after timer
          // expiry on Q(N), a Next click to Q(N+1) hits the FAST-PATH
          // branches below with stale currentIdx === N, re-writing Q(N)'s
          // FET into qText. That's the FET->q-txt flash.
          const liveIdx = host.questionIndex?.() ?? host.currentIndex ?? 0;
          const currentQ = host.quizService.getQuestionsInDisplayOrder()?.[liveIdx];
          const qTextRaw = (currentQ?.questionText ?? '').trim();
          const isQuestionText = qTextRaw.length > 0 && (text ?? '').trim().startsWith(qTextRaw);

          const currentIdx = liveIdx;

          // Timer-expiry detection: bypasses all FET guards below
          const isTimedOutForIdx = host.timedOutIdxSubject?.getValue?.() === currentIdx && currentIdx >= 0;

          // FAST-PATH FET BYPASS: if SOC has confirmed this question correct
          // via fetBypassForQuestion AND the incoming text contains FET,
          // write it directly — skip all downstream gates that can block it.
          if (!isQuestionText && lowerText.includes('correct because')
              && host.explanationTextService?.fetBypassForQuestion?.get(currentIdx) === true) {
            const el = host.qText?.()?.nativeElement;
            if (el) {
              host.qTextHtmlSig?.set(text);
              host._lastDisplayedText = text;
              host.renderer.setProperty(el, 'innerHTML', text);
              (host as any)._fetLockedForIndex = currentIdx;
              return;
            }
          }

          // TIMER-EXPIRY FET FAST PATH: when timed out and incoming text
          // contains actual FET content, write it directly.
          if (isTimedOutForIdx && !isQuestionText && (text ?? '').trim().length > 0) {
            const el = host.qText?.()?.nativeElement;
            if (el) {
              host.qTextHtmlSig?.set(text);
              host._lastDisplayedText = text;
              host.renderer.setProperty(el, 'innerHTML', text);
              (host as any)._fetLockedForIndex = currentIdx;
              return;
            }
          }

          const hasRealInteraction = this.fetGuard.hasInteractionEvidence(host, currentIdx);
          const isResolvedForGuard = hasRealInteraction
            ? this.fetGuard.isQuestionResolvedFromStorage(host, currentIdx)
            : false;

          // CENTRAL MULTI-ANSWER FET GUARD
          const qForMultiCheck = host.quizService.getQuestionsInDisplayOrder()?.[currentIdx]
            ?? host.quizService.questions?.[currentIdx];
          let multiCorrectCount = (qForMultiCheck?.options ?? []).filter(
            (o: any) => o?.correct === true || o?.correct === 1 || String(o?.correct) === 'true'
          ).length;
          try {
            const _n = (t: any) => String(t ?? '').trim().toLowerCase();
            const _qText = _n(qForMultiCheck?.questionText);
            const _bundle: any[] = (host.quizService as any)?.quizInitialState ?? [];
            for (const _quiz of _bundle) {
              for (const _pq of (_quiz?.questions ?? [])) {
                if (_n(_pq?.questionText) !== _qText) continue;
                const pristineCount = (_pq?.options ?? []).filter(
                  (o: any) => o?.correct === true || String(o?.correct) === 'true'
                ).length;
                if (pristineCount > multiCorrectCount) {
                  multiCorrectCount = pristineCount;
                }
                break;
              }
            }
          } catch { /* ignore */ }
          const isMultiAnswer = multiCorrectCount > 1;
          // AUTO-REVEAL BYPASS: when soc-answer-processing's auto-reveal sets
          // fetBypassForQuestion, treat multi-answer FET writes as allowed —
          // otherwise the FET LOCK below skips, and subsequent question-text
          // emissions overwrite the auto-revealed FET back to the question.
          const fetBypassActive =
            host.explanationTextService?.fetBypassForQuestion?.get(currentIdx) === true;
          const multiAnswerBlocked = isMultiAnswer && hasRealInteraction && !isResolvedForGuard && !isTimedOutForIdx && !fetBypassActive;

          const isExplanation = lowerText.length > 0
            && !isQuestionText
            && !lowerText.includes('correct because')
            && host.explanationTextService.latestExplanationIndex === currentIdx
            && host.explanationTextService.latestExplanationIndex >= 0
            && (hasRealInteraction || isTimedOutForIdx)
            && !multiAnswerBlocked;
          if (isExplanation) {
            const idx = currentIdx;
            const cached = (host.explanationTextService.formattedExplanations[idx]?.explanation ?? '').trim()
              || ((host.explanationTextService as any).fetByIndex?.get(idx) ?? '').trim();
            if (cached && cached.toLowerCase().includes('correct because')) {
              finalText = cached;
            } else {
              try {
                const questions = host.quizService.getQuestionsInDisplayOrder();
                const q = questions?.[idx];
                if (q?.options?.length > 0 && q.explanation) {
                  const correctIndices = host.explanationTextService.getCorrectOptionIndices(q, q.options, idx);
                  if (correctIndices.length > 0) {
                    finalText = host.explanationTextService.formatExplanation(q, correctIndices, q.explanation);
                  }
                }
              } catch { /* ignore */ }
            }
          } else if (!isQuestionText && !lowerText.includes('correct because')
                     && host.explanationTextService.latestExplanationIndex === currentIdx
                     && !hasRealInteraction && !isTimedOutForIdx) {
            // Substitution suppressed — no interaction evidence
          }

          const el = host.qText?.()?.nativeElement;
          if (el) {
            const incoming = (finalText ?? '').trim();
            const cached = (host._lastDisplayedText ?? '').trim();
            if (!incoming) {
              if ((host as any)._fetLockedForIndex === currentIdx && !multiAnswerBlocked) {
                return;
              }
              if (cached) {
                this.fetGuard.writeQText(host, cached);
                return;
              }
              try {
                const rebuilt = this.fetGuard.buildQuestionDisplayHTML(host, currentIdx);
                if (rebuilt) {
                  this.fetGuard.writeQText(host, rebuilt);
                  return;
                }
              } catch { /* ignore */ }
              return;
            }

            // UNIVERSAL QUESTION-FIRST GUARD (skip when timed out)
            if (!hasRealInteraction && !isTimedOutForIdx) {
              try {
                const forcedQText = this.fetGuard.buildQuestionDisplayHTML(host, currentIdx);
                if (forcedQText) {
                  const isShuffled = host.quizService.isShuffleEnabled?.()
                    && Array.isArray(host.quizService.shuffledQuestions)
                    && host.quizService.shuffledQuestions.length > 0;
                  const qForCurrent = isShuffled
                    ? host.quizService.shuffledQuestions[currentIdx]
                    : host.quizService.questions?.[currentIdx];
                  const rawQ = (qForCurrent?.questionText ?? '').trim();
                  const incomingStartsWithQ = incoming.length > 0 && incoming.startsWith(rawQ);
                  if (!incomingStartsWithQ) {
                    this.fetGuard.writeQText(host, forcedQText);
                    return;
                  }
                }
              } catch { /* ignore */ }
            }

            // FET-OVER-QUESTION-TEXT GUARD
            if (hasRealInteraction && isQuestionText && isResolvedForGuard) {
              const fetCached =
                (host.explanationTextService.formattedExplanations[currentIdx]?.explanation ?? '').trim()
                || ((host.explanationTextService as any).fetByIndex?.get(currentIdx) ?? '').trim();
              if (fetCached && fetCached.toLowerCase().includes('correct because')) {
                this.fetGuard.writeQText(host, fetCached);
                return;
              }
              const lastText = (host._lastDisplayedText ?? '').trim();
              if (lastText && lastText.toLowerCase().includes('correct because')) {
                return;
              }
              const domNow = (el.innerHTML ?? '').trim();
              if (domNow && domNow.toLowerCase().includes('correct because')) {
                return;
              }
            }

            // FET LOCK
            if ((host as any)._fetLockedForIndex === currentIdx && 
              isQuestionText && 
              !multiAnswerBlocked
            ) return;

            // MULTI-ANSWER / SINGLE-ANSWER FET BLOCK (skip when timed out)
            if (!isTimedOutForIdx) {
              const normForFet = (t: any) => String(t ?? '').trim().toLowerCase();
              const finalNorm = normForFet(finalText);
              const qTextNormForFet = normForFet(qForMultiCheck?.questionText);
              const rawExplanation = normForFet(
                (host.quizService as any)?.questions?.[currentIdx]?.explanation
                  ?? qForMultiCheck?.explanation
              );
              const isFetText = !!finalNorm && (
                finalNorm.includes('correct because')
                || (!!rawExplanation && finalNorm.includes(rawExplanation))
                || (!!qTextNormForFet && !finalNorm.includes(qTextNormForFet))
              );
              const rawQForBlock: any = 
                (host.quizService as any)?.questions?.[currentIdx] ?? qForMultiCheck;
              const rawOptsForBlock: any[] = rawQForBlock?.options ?? [];
              let rawCorrectCountBlock = rawOptsForBlock.filter(
                (o: any) => o?.correct === true || o?.correct === 1 || String(o?.correct) === 'true'
              ).length;
              try {
                const _n2 = (t: any) => String(t ?? '').trim().toLowerCase();
                const _qText2 = _n2(rawQForBlock?.questionText ?? qForMultiCheck?.questionText);
                const _bundle2: any[] = (host.quizService as any)?.quizInitialState ?? [];
                for (const _quiz2 of _bundle2) {
                  for (const _pq2 of (_quiz2?.questions ?? [])) {
                    if (_n2(_pq2?.questionText) !== _qText2) continue;
                    const pc2 = (_pq2?.options ?? []).filter(
                      (o: any) => o?.correct === true || String(o?.correct) === 'true'
                    ).length;
                    if (pc2 > rawCorrectCountBlock) rawCorrectCountBlock = pc2;
                    break;
                  }
                }
              } catch { /* ignore */ }
              const isMultiQ = host.quizService.multipleAnswer || rawCorrectCountBlock > 1;

              if (isFetText && isMultiQ) {
                if (!this.fetGuard.isScoredCorrectAtDisplay(host, currentIdx) && !fetBypassActive) {
                  const qText = this.fetGuard.buildQuestionDisplayHTML(host, currentIdx);
                  if (qText) {
                    this.fetGuard.writeQText(host, qText);
                    return;
                  }
                }
              }

              if (isFetText && !isMultiQ) {
                if (!this.fetGuard.isScoredCorrectAtDisplay(host, currentIdx) && !fetBypassActive) {
                  const qText = this.fetGuard.buildQuestionDisplayHTML(host, currentIdx);
                  if (qText) {
                    this.fetGuard.writeQText(host, qText);
                    return;
                  }
                }
              }
            }

            // BANNER PRESERVATION
            if (isQuestionText) {
              const enriched = this.fetGuard.buildQuestionDisplayHTML(host, currentIdx);
              if (enriched) finalText = enriched;
            }

            this.fetGuard.writeQText(host, finalText);
          }
        },
        error: () => { }
      });
  }
}
