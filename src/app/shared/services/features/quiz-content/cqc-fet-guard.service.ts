import { Injectable, inject } from '@angular/core';

import { QUESTION_ROUTE_REGEX } from '../../../constants/route-patterns';
import { SK_SEL_Q } from '../../../constants/session-keys';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { QuizDotStatusService } from '../../flow/quiz-dot-status.service';

import type { CodelabQuizContentComponent } from '../../../../containers/quiz/quiz-content/codelab-quiz-content.component';
import { withCorrectCountBanner } from '../../../utils/correct-count-banner';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

type Host = CodelabQuizContentComponent;

/**
 * FET (Formatted Explanation Text) gating logic extracted from CqcOrchestratorService.
 *
 * Responsible for:
 * - writeQText: the central DOM-write method with layered FET gates
 * - buildQuestionDisplayHTML: builds question text with multi-answer banner
 * - isScoredCorrectAtDisplay: checks scoring correctness for a display index
 * - hasInteractionEvidence: checks if user has clicked on a question
 * - isQuestionResolvedFromStorage: checks if all correct answers are selected
 */
@Injectable({ providedIn: 'root' })
export class CqcFetGuardService {
  // ── injects ─────────────────────────────────────────────────────
  private dotStatusService = inject(QuizDotStatusService);


  /**
   * Write HTML to qText. Updates the host signal (which the template is
   * bound to via [innerHTML]) AND the imperative Renderer2 mirror AND the
   * _lastDisplayedText cache. The signal is the durable source of truth
   * for Angular's change detection — writing it means visibility flips
   * and async restores can't leave the heading blank, because CD will
   * keep re-stamping from the signal on every pass. The Renderer2 write
   * remains for immediate synchronous DOM visibility inside the same
   * microtask (before CD has had a chance to run).
   */
  writeQText(host: Host, html: string): void {
    try {
      let safe = html ?? '';

      // URL-AUTHORITATIVE GUARD — URL question is the source of truth (null = drop stale write).
      const _urlGuarded = this.applyUrlAuthoritativeGuard(host, safe);
      if (_urlGuarded === null) return;
      safe = _urlGuarded;

      // Live index — URL pathname first (only sync-correct source on multi-step URL nav).
      const _liveIdx = this.resolveLiveIdx(host);

      // TIMER-EXPIRY BYPASS — expired timer must show the explanation regardless of scoring.
      if (this.applyTimerExpiryBypass(host, safe, _liveIdx)) return;

      // SOC-CONFIRMED — preserve cached FET, or bypass all gates when SOC confirmed correct.
      const _safeIsFetEarly = (safe ?? '').toLowerCase().includes('correct because');
      if (this.applySocConfirmedFetPreservation(host, safe, _liveIdx, _safeIsFetEarly)) return;
      if (this.applySocConfirmedFetBypass(host, safe, _liveIdx, _safeIsFetEarly)) return;

      const rawQs: any[] = host.quizService?.questions ?? [];
      const safeNorm = norm(safe);

      // NUCLEAR GATE — FET-looking text refused unless the live UI shows all correct selected.
      const _nuclear = this.applyNuclearGate(host, safe, _liveIdx, safeNorm);
      if (_nuclear === null) return;
      safe = _nuclear;

      // HARD FINAL GATE — unresolved multi-answer FET across pristine sources → question text.
      safe = this.applyHardFinalGate(host, safe, safeNorm, rawQs);

      // ABSOLUTE LAST-LINE GUARD — unresolved multi-answer, non-question text → rebuild.
      safe = this.applyAbsoluteLastLineGuard(host, safe);

      // FINAL PRISTINE GATE — same resolved-check vs quizInitialState, no outer try/catch.
      safe = this.applyFinalPristineGate(host, safe);

      // UNIVERSAL BACKSTOP — pristine-explanation / expected-text mismatch (with evidence) → restore.
      safe = this.applyUniversalBackstop(host, safe);

      // BANNER PRESERVATION — re-attach "N answers are correct" banner to plain question text.
      safe = this.applyBannerPreservation(host, safe, _liveIdx);

      host.qTextHtmlSig?.set(safe);
      host._lastDisplayedText = safe;
    } catch { /* ignore */ }
  }

  /**
   * URL-AUTHORITATIVE GUARD: when on a /question/{quizId}/{N} URL,
   * ALWAYS overwrite non-FET writes with the URL question's text.
   * Many call sites still pass stale Q1 text through writeQText on
   * direct/multi-step URL nav; rather than chase each, the central
   * DOM writer now imposes the URL as the source of truth for any
   * non-FET content. Returns null to drop a stale write. Extracted verbatim.
   */
  private applyUrlAuthoritativeGuard(host: Host, safe: string): string | null {
    try {
      const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
      if (m) {
        const urlIdx = Number(m[1]) - 1;
        const allQs: any[] = host.quizService?.questions ?? [];
        const urlQ = allQs[urlIdx];
        const safeText = norm(safe);
        const safeIsFet = safeText.includes('correct because') ||
                          safeText.includes('correct answer is option') ||
                          safeText.includes('correct answers are options');
        if (!safeIsFet) {
          if (urlQ?.questionText) {
            safe = this.buildUrlQuestionHtml(host, urlQ);
          } else if (urlIdx >= 0 && safeText) {
            // URL question hasn't loaded yet — drop the stale write so
            // the heading doesn't show whatever Q1-ish text was passed.
            return null;
          }
        }
      }
    } catch { /* non-browser env */ }
    return safe;
  }

  /**
   * Live index — prefer the URL pathname, then the input signal, then
   * host.currentIndex. The URL is the ONLY source that's sync-correct on
   * multi-step URL navigation (Q4 -> URL-bar Q6); host.questionIndex() is a
   * signal input that lags one microtask behind the route change. Extracted
   * verbatim.
   */
  private resolveLiveIdx(host: Host): number {
    let _liveIdx = -1;
    try {
      const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
      if (m) {
        const urlIdx = Number(m[1]) - 1;
        if (urlIdx >= 0) _liveIdx = urlIdx;
      }
    } catch { /* non-browser env */ }
    if (_liveIdx < 0) {
      const _liveIdxRaw = host.questionIndex?.();
      _liveIdx = (typeof _liveIdxRaw === 'number' && _liveIdxRaw >= 0)
        ? _liveIdxRaw
        : (host.currentIndex ?? -1);
    }
    return _liveIdx;
  }

  /**
   * TIMER-EXPIRY BYPASS: when the timer has expired for this question, skip
   * ALL FET gates — the explanation must display regardless of whether the
   * question is "scored correct" or "resolved". Returns true when handled
   * (already wrote the signal). Extracted verbatim.
   */
  private applyTimerExpiryBypass(host: Host, safe: string, _liveIdx: number): boolean {
    const _timedOutIdx = host.timedOutIdxSubject?.getValue?.() ?? -1;
    const _curIdx = _liveIdx;
    if (_timedOutIdx >= 0 && _timedOutIdx === _curIdx && safe.trim().length > 0) {
      const _qNorm = String(
        (host.quizService?.getQuestionsInDisplayOrder?.()?.[ _curIdx]?.questionText ?? '').trim()
      );
      const _safeNorm = safe.trim();
      const _isJustQuestionText = _qNorm.length > 0 && _safeNorm.startsWith(_qNorm) && !_safeNorm.toLowerCase().includes('correct because');
      if (!_isJustQuestionText) {
        host.qTextHtmlSig?.set(safe);
        host._lastDisplayedText = safe;
        return true;
      }
    }
    return false;
  }

  /**
   * SOC-CONFIRMED FET PRESERVATION: when incoming is QUESTION TEXT but SOC has
   * confirmed the question correct AND a cached FET exists, write the cached
   * FET instead. Prevents question-text writes (from stale pipeline emissions,
   * stampQuestionTextNow retries, etc.) from overwriting a legitimate FET after
   * the user has answered correctly. Returns true when handled. Extracted verbatim.
   */
  private applySocConfirmedFetPreservation(host: Host, safe: string, _liveIdx: number, _safeIsFetEarly: boolean): boolean {
    if (!_safeIsFetEarly && _liveIdx >= 0) {
      const _socConfirmedNow =
        host.explanationTextService?.fetBypassForQuestion?.get(_liveIdx) === true
        || host.quizService?._multiAnswerPerfect?.get(_liveIdx) === true;
      if (_socConfirmedNow) {
        const _cachedFet = (
          host.explanationTextService?.formattedExplanations?.[_liveIdx]?.explanation ?? ''
        ).toString().trim() || (
          host.explanationTextService?.fetByIndex?.get?.(_liveIdx) ?? ''
        ).toString().trim();
        if (_cachedFet && _cachedFet.toLowerCase().includes('correct because')) {
          host.qTextHtmlSig?.set(_cachedFet);
          host._lastDisplayedText = _cachedFet;
          host._fetLockedForIndex = _liveIdx;
          return true;
        }
      }
    }
    return false;
  }

  /**
   * SOC-CONFIRMED FET BYPASS: when SOC has explicitly confirmed this question
   * correct (fetBypassForQuestion or _multiAnswerPerfect), skip ALL downstream
   * gates and write FET directly. Prevents the many selection-checking gates
   * from blocking legitimate FET due to timing/index issues in shuffled mode.
   * Returns true when handled. Extracted verbatim.
   */
  private applySocConfirmedFetBypass(host: Host, safe: string, _liveIdx: number, _safeIsFetEarly: boolean): boolean {
    if (_safeIsFetEarly) {
      const _expIdx = host.explanationTextService?.latestExplanationIndex ?? -1;
      const _checkIdx = _liveIdx >= 0 ? _liveIdx : (_expIdx >= 0 ? _expIdx : -1);
      const _fetBypassEarly = _checkIdx >= 0 && (
        host.explanationTextService?.fetBypassForQuestion?.get(_checkIdx) === true
        || host.quizService?._multiAnswerPerfect?.get(_checkIdx) === true
        || (_expIdx >= 0 && _expIdx !== _checkIdx && (
          host.explanationTextService?.fetBypassForQuestion?.get(_expIdx) === true
          || host.quizService?._multiAnswerPerfect?.get(_expIdx) === true
        ))
      );
      if (_fetBypassEarly) {
        host.qTextHtmlSig?.set(safe);
        host._lastDisplayedText = safe;
        return true;
      }
    }
    return false;
  }

  /**
   * NUCLEAR GATE — runs before anything else. If the outgoing HTML looks like
   * ANY Formatted Explanation Text (FET), consult the live optionBindings for
   * the currently displayed question and refuse to write unless every correct
   * option there is selected. Trusts only what the UI itself shows the user
   * right now. Returns null when handled (already wrote the rebuilt text),
   * otherwise the (unchanged) safe. Extracted verbatim.
   */
  private applyNuclearGate(host: Host, safe: string, _liveIdx: number, safeNorm: string): string | null {
    try {
      const { activeIdx, liveQ } = this.resolveActiveLiveQuestion(host, _liveIdx);
      const looksLikeFet = this.nuclearLooksLikeFet(host, liveQ, safeNorm);

      if (!looksLikeFet) {
        const displayedQText = norm(liveQ?.questionText ?? '');
        if (displayedQText && safeNorm !== displayedQText && !safeNorm.startsWith(displayedQText)) {
          if (!this.isScoredCorrectAtDisplay(host, activeIdx)) {
            return this.rebuildAndStampQuestionText(host, activeIdx, liveQ);
          }
        }
      }

      if (looksLikeFet) {
        return this.applyNuclearFetResolution(host, safe, _liveIdx);
      }
    } catch (e) {
      console.error('CqcFetGuardService.writeQText NUCLEAR GATE failed:', e);
    }
    return safe;
  }

  /**
   * NUCLEAR GATE — FET branch. Resolve the live question's correct texts and
   * the user's selected texts (live options, selection map, sessionStorage,
   * DOM); when not all correct options are selected and there's no scoring or
   * auto-reveal override, rebuild the heading back to question text (returns
   * null after stamping). Extracted verbatim.
   */
  private applyNuclearFetResolution(host: Host, safe: string, _liveIdx: number): string | null {
    const { activeIdx, liveQ } = this.resolveActiveLiveQuestion(host, _liveIdx);
    let pristineCorrectTexts = new Set<string>();
    try {
      pristineCorrectTexts = new Set(
        host.quizService?.getPristineCorrectTextsForQuestion(liveQ?.questionText) ?? []
      );
    } catch { /* ignore */ }

    const correctTotal = pristineCorrectTexts.size;
    const selectedTexts = this.collectNuclearSelectedTexts(host, liveQ, activeIdx, pristineCorrectTexts);

    let correctSelected = 0;
    for (const t of pristineCorrectTexts) {
      if (selectedTexts.has(t)) correctSelected++;
    }
    const isMulti = correctTotal >= 2;

    // AUTO-REVEAL BYPASS: when fetBypassForQuestion is set for this idx,
    // the all-incorrects-exhausted auto-reveal explicitly wants the FET
    // to display even though scoring marks the question as not correct.
    // Without this carve-out, the NUCLEAR GATE below rewrites the FET
    // back to question text and the auto-revealed FET never appears.
    const fetBypassActive =
      host.explanationTextService?.fetBypassForQuestion?.get(activeIdx) === true
      || host.quizService?._multiAnswerPerfect?.get(activeIdx) === true;

    if (!isMulti) {
      if (!this.isScoredCorrectAtDisplay(host, activeIdx) && !fetBypassActive) {
        return this.rebuildAndStampQuestionText(host, activeIdx, liveQ);
      }
    }
    if (isMulti) {
      if (!this.isScoredCorrectAtDisplay(host, activeIdx) && !fetBypassActive) {
        return this.rebuildAndStampQuestionText(host, activeIdx, liveQ);
      }
    }
    return safe;
  }

  /**
   * Gather every "selected" option text for the question from all evidence
   * sources the UI trusts: live option flags, the selection map, sessionStorage
   * sel_Q*, and highlighted DOM rows. Extracted verbatim from the NUCLEAR GATE.
   */
  private collectNuclearSelectedTexts(host: Host, liveQ: any, activeIdx: number, pristineCorrectTexts: Set<string>): Set<string> {
    const selectedTexts = new Set<string>();
    this.gatherLiveOptionSelections(liveQ, selectedTexts);
    this.gatherSelectionMapSelections(host, activeIdx, selectedTexts);
    this.gatherSessionStorageSelections(activeIdx, selectedTexts);
    this.gatherDomHighlightedSelections(pristineCorrectTexts, selectedTexts);
    return selectedTexts;
  }

  /** Add selected option texts read from the live question's option flags. */
  private gatherLiveOptionSelections(liveQ: any, selectedTexts: Set<string>): void {
    const liveOpts: any[] = Array.isArray(liveQ?.options) ? liveQ.options : [];
    for (const o of liveOpts) {
      const isSel = o?.selected === true
        || o?.highlight === true
        || o?.showIcon === true;
      if (!isSel) continue;
      const t = norm(o?.text);
      if (t) selectedTexts.add(t);
    }
  }

  /** Add selected option texts from SelectedOptionService.selectedOptionsMap. */
  private gatherSelectionMapSelections(host: Host, idx: number, selectedTexts: Set<string>): void {
    try {
      const rawMap = host.selectedOptionService?.selectedOptionsMap;
      if (rawMap && typeof rawMap.get === 'function') {
        const mapSel: any[] = rawMap.get(idx) ?? [];
        for (const o of mapSel) {
          if (o?.selected === false) continue;
          const t = norm(o?.text);
          if (t) selectedTexts.add(t);
        }
      }
    } catch { /* ignore */ }
  }

  /** Add selected option texts from the durable sel_Q* sessionStorage entry. */
  private gatherSessionStorageSelections(idx: number, selectedTexts: Set<string>): void {
    try {
      const raw = sessionStorage.getItem(SK_SEL_Q + idx);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const o of parsed) {
            if (o?.selected !== true) continue;
            const t = norm(o?.text);
            if (t) selectedTexts.add(t);
          }
        }
      }
    } catch { /* ignore */ }
  }

  /** Add pristine correct texts whose option row is highlighted in the live DOM. */
  private gatherDomHighlightedSelections(pristineCorrectTexts: Set<string>, selectedTexts: Set<string>): void {
    try {
      const rows: NodeListOf<Element> | Element[] = typeof document !== 'undefined'
        ? document.querySelectorAll(
          'codelab-option-item, .option-row, [data-option-text], .option-item'
        )
        : [];
      for (const row of Array.from(rows)) {
        const cls = String(row?.className ?? '');
        const isHighlighted = cls.includes('selected')
          || cls.includes('highlight')
          || row?.querySelector?.('.selected, .highlight, mat-icon') != null;
        if (!isHighlighted) continue;
        const txt = norm(
          row?.getAttribute?.('data-option-text')
          ?? row?.textContent
          ?? ''
        );
        for (const pt of pristineCorrectTexts) {
          if (txt.includes(pt)) selectedTexts.add(pt);
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * Rebuild the question display HTML for an index and stamp it into the heading
   * signal (+ _lastDisplayedText). Returns null so gate callers can short-circuit
   * writeQText. Extracted verbatim.
   */
  private rebuildAndStampQuestionText(host: Host, idx: number, liveQ: any): null {
    const rebuilt = this.buildQuestionDisplayHTML(host, idx);
    const safe = rebuilt || (liveQ?.questionText ?? '').trim() || '';
    host.qTextHtmlSig?.set(safe);
    host._lastDisplayedText = safe;
    return null;
  }

  /**
   * HARD FINAL GATE — across every pristine source, if the outgoing text
   * signals a multi-answer FET that isn't fully resolved (and isn't scored
   * correct), rebuild it back to the question display text. Extracted verbatim.
   */
  private applyHardFinalGate(host: Host, safe: string, safeNorm: string, rawQs: any[]): string {
    try {
      const pristineByText = this.buildPristineByText(host);
      const hasBanner = !!safe && safe.includes('correct-count');
      if (!hasBanner && !!safeNorm) {
        for (const [, pristineQ] of pristineByText) {
          const result = this.resolveHardGateEntry(host, safe, safeNorm, rawQs, pristineQ);
          if (result === null) continue;
          safe = result;
          break;
        }
      }
    } catch { /* ignore */ }
    return safe;
  }

  /**
   * Build a de-duplicated map of pristine questions (those with at least one
   * correct-flagged option) keyed by normalized question text, drawn from every
   * available source. Extracted verbatim from the HARD FINAL GATE.
   */
  private buildPristineByText(host: Host): Map<string, any> {
    const qs = host.quizService;
    const hasCorrectFlag = (opts: any[] = []) =>
      opts.some((o: any) => isOptionCorrect(o));
    const pristineByText = new Map<string, any>();
    const addSource = (arr: any[] | undefined) => {
      if (!Array.isArray(arr)) return;
      for (const q of arr) {
        if (!q?.questionText) continue;
        if (!hasCorrectFlag(q.options ?? [])) continue;
        const k = norm(q.questionText);
        if (k && !pristineByText.has(k)) pristineByText.set(k, q);
      }
    };
    addSource(qs?.questions);
    addSource(qs?.dataLoader?.currentQuizSig?.()?.questions);
    const quizData = qs?.quizData;
    if (Array.isArray(quizData)) {
      for (const quiz of quizData) addSource(quiz?.questions);
    }
    try {
      for (const quiz of host.quizService?.quizInitialState ?? []) {
        addSource(quiz?.questions);
      }
    } catch { /* ignore */ }
    return pristineByText;
  }

  /**
   * Resolve one pristine multi-answer entry against the outgoing FET text:
   * returns null to skip (single-answer or not a FET signal), otherwise the
   * resolved `safe` (rebuilt to question text when the answer isn't fully
   * selected and isn't scored correct). Extracted verbatim from the HARD FINAL GATE.
   */
  private resolveHardGateEntry(host: Host, safe: string, safeNorm: string, rawQs: any[], pristineQ: any): string | null {
    const rawOpts: any[] = pristineQ?.options ?? [];
    const correctOpts = rawOpts.filter(
      (o: any) => isOptionCorrect(o)
    );
    if (correctOpts.length < 2) return null;
    if (!this.isHardGateFetSignal(safeNorm, correctOpts, pristineQ)) return null;
    const rawCorrectTexts = correctOpts
      .map((o: any) => norm(o?.text))
      .filter((t: string) => !!t);
    const rawCorrectSet = new Set(rawCorrectTexts);
    let qIdx = -1;
    if (Array.isArray(rawQs)) {
      qIdx = rawQs.findIndex(
        (q: any) => norm(q?.questionText) === norm(pristineQ.questionText)
      );
    }
    const selectedCorrectTexts = this.collectHardGateSelectedCorrect(host, rawCorrectSet, qIdx);
    const resolved =
      rawCorrectTexts.length > 0
      && selectedCorrectTexts.size === rawCorrectTexts.length;
    if (!resolved) {
      safe = this.rebuildIfHardGateUnresolved(host, safe, qIdx, pristineQ);
    }
    return safe;
  }

  /**
   * Collect the correct-option texts the user has actually selected for a hard-
   * gate entry, drawn from sessionStorage sel_Q*, the selection map, and the
   * live component bindings. Extracted verbatim from the HARD FINAL GATE.
   */
  private collectHardGateSelectedCorrect(host: Host, rawCorrectSet: Set<string>, qIdx: number): Set<string> {
    let storedSelections: any[] = [];
    try {
      if (qIdx >= 0) {
        const raw = sessionStorage.getItem(SK_SEL_Q + qIdx);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) storedSelections = parsed;
        }
      }
    } catch { /* ignore */ }
    const rawMap = host.selectedOptionService?.selectedOptionsMap;
    const mapSel: any[] = (rawMap && typeof rawMap.get === 'function' && qIdx >= 0)
      ? (rawMap.get(qIdx) ?? [])
      : [];
    const selectedCorrectTexts = new Set<string>();
    const collect = (arr: any[]) => {
      for (const o of arr) {
        if (o?.selected !== true) continue;
        const t = norm(o?.text);
        if (!t) continue;
        if (rawCorrectSet.has(t)) selectedCorrectTexts.add(t);
      }
    };
    collect(storedSelections);
    collect(mapSel);
    const liveQQC: any = host.quizQuestionComponent?.();
    const liveBindings: any[] = Array.isArray(liveQQC?.optionBindings)
      ? liveQQC.optionBindings
      : [];
    for (const b of liveBindings) {
      const opt = b?.option;
      const isSel = b?.isSelected === true || opt?.selected === true;
      if (!isSel) continue;
      const t = norm(opt?.text);
      if (!t) continue;
      if (rawCorrectSet.has(t)) selectedCorrectTexts.add(t);
    }
    return selectedCorrectTexts;
  }

  /**
   * ABSOLUTE LAST-LINE GUARD — for a multi-answer question whose outgoing text
   * isn't the question text and isn't fully resolved (and isn't scored
   * correct), rebuild it to the question display text. Extracted verbatim.
   */
  private applyAbsoluteLastLineGuard(host: Host, safe: string): string {
    try {
      const qs_ll: any = host.quizService;
      const idx_ll: number = host.currentIndex ?? (
        Number.isFinite(qs_ll?.currentQuestionIndex)
          ? qs_ll.currentQuestionIndex
          : (qs_ll?.getCurrentQuestionIndex?.() ?? 0)
      );
      const isShuf_ll = qs_ll?.isShuffleEnabled?.()
        && Array.isArray(qs_ll?.shuffledQuestions)
        && qs_ll.shuffledQuestions.length > 0;
      const liveQ_ll: any = isShuf_ll
        ? qs_ll?.shuffledQuestions?.[idx_ll]
        : qs_ll?.questions?.[idx_ll];
      const qTextNorm_ll = norm(liveQ_ll?.questionText);
      const safeTextOnly_ll = norm(safe.replace(/<[^>]*>/g, ''));
      const isNotQuestionText = !!qTextNorm_ll
        && !safeTextOnly_ll.startsWith(qTextNorm_ll)
        && safeTextOnly_ll !== qTextNorm_ll;
      if (isNotQuestionText) {
        const pristineCorrect_ll = Array.from(
          host.quizService?.getPristineCorrectTextsForQuestion(liveQ_ll?.questionText) ?? []
        );
        if (pristineCorrect_ll.length >= 2) {
          const selNow_ll = this.collectSelectedTextsForIndex(host, idx_ll);
          const allResolved_ll = pristineCorrect_ll.every(t => selNow_ll.has(t));
          if (!allResolved_ll) {
            const llOverride = this.isScoredCorrectAtDisplay(host, idx_ll);
            if (llOverride) {
              // overridden by questionCorrectness
            } else {
              safe = this.buildQuestionDisplayHTML(host, idx_ll) || (liveQ_ll?.questionText ?? '').trim() || '';
            }
          }
        }
      }
    } catch { /* ignore */ }
    return safe;
  }

  /**
   * FINAL PRISTINE GATE (cannot fail silently) — same resolved-check against
   * quizInitialState as the last-line guard, without an outer try/catch so a
   * thrown error surfaces. Extracted verbatim.
   */
  private applyFinalPristineGate(host: Host, safe: string): string {
    const _safeStripped = norm(safe.replace(/<[^>]*>/g, ''));
    const _qs: any = host.quizService;
    const _idx: number = host.currentIndex ?? (_qs?.currentQuestionIndex ?? 0);
    const _isShuf = _qs?.isShuffleEnabled?.() && Array.isArray(_qs?.shuffledQuestions) && _qs.shuffledQuestions.length > 0;
    const _liveQ: any = _isShuf ? _qs?.shuffledQuestions?.[_idx] : _qs?.questions?.[_idx];
    const _qTextNorm = norm(_liveQ?.questionText);
    if (_qTextNorm && _safeStripped !== _qTextNorm && !_safeStripped.startsWith(_qTextNorm)) {
      const _pCorrect = this.findPristineCorrectTexts(host, _qTextNorm);
      if (_pCorrect.length >= 2) {
        const _selNow = this.collectSelectedTextsForIndex(host, _idx);
        const _allOk = _pCorrect.every(t => _selNow.has(t));
        if (!_allOk) {
          const _fgOverride = this.isScoredCorrectAtDisplay(host, _idx);
          if (_fgOverride) {
            // overridden by questionCorrectness
          } else {
            safe = this.buildQuestionDisplayHTML(host, _idx) || (_liveQ?.questionText ?? '').trim() || '';
          }
        }
      }
    }
    return safe;
  }

  /**
   * UNIVERSAL BACKSTOP — if the outgoing text matches the pristine explanation,
   * or otherwise mismatches the expected question display while there's
   * interaction evidence, and the question isn't scored correct, restore the
   * expected question display HTML. Extracted verbatim.
   */
  private applyUniversalBackstop(host: Host, safe: string): string {
    try {
      const qsBs: any = host.quizService;
      const bsIdx: number = host.currentIndex ?? (
        Number.isFinite(qsBs?.currentQuestionIndex)
          ? qsBs.currentQuestionIndex
          : (qsBs?.getCurrentQuestionIndex?.() ?? 0)
      );
      const normBs = (t: any) => String(t ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      const safeNormBs = normBs(safe);
      const pristineExplBs = this.findPristineExplanation(host, bsIdx, normBs);
      const explMatch = pristineExplBs && pristineExplBs.length > 5 && safeNormBs.includes(pristineExplBs);
      const expectedQBs = this.buildQuestionDisplayHTML(host, bsIdx);
      const expectedNormBs = expectedQBs ? normBs(expectedQBs) : '';
      const textMismatch = expectedNormBs && safeNormBs.length > 0
        && safeNormBs !== expectedNormBs
        && this.hasInteractionEvidence(host, bsIdx);
      if (explMatch || textMismatch) {
        if (!this.isScoredCorrectAtDisplay(host, bsIdx)) {
          if (expectedQBs) safe = expectedQBs;
        }
      }
    } catch { /* ignore */ }
    return safe;
  }

  /**
   * BANNER PRESERVATION — re-attach the "N answers are correct" banner when the
   * outgoing text is plain question text (uses the URL-first index, same as the
   * URL-AUTHORITATIVE GUARD). Extracted verbatim.
   */
  private applyBannerPreservation(host: Host, safe: string, _liveIdx: number): string {
    try {
      const qsBnr: any = host.quizService;
      let bnrIdx: number = _liveIdx >= 0 ? _liveIdx : (host.currentIndex ?? (
        Number.isFinite(qsBnr?.currentQuestionIndex)
          ? qsBnr.currentQuestionIndex : (qsBnr?.getCurrentQuestionIndex?.() ?? 0)
      ));
      const expectedWithBanner = this.buildQuestionDisplayHTML(host, bnrIdx);
      if (expectedWithBanner && expectedWithBanner.includes('correct-count')) {
        const normBnr = (t: any) => String(t ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        const safeNormBnr = normBnr(safe);
        const isShufBnr = qsBnr?.isShuffleEnabled?.() && qsBnr?.shuffledQuestions?.length > 0;
        const qObjBnr = isShufBnr
          ? qsBnr?.shuffledQuestions?.[bnrIdx]
          : qsBnr?.questions?.[bnrIdx];
        const rawQTextBnr = normBnr(qObjBnr?.questionText ?? '');
        // Add banner if safe is plain question text (exact match or starts with it without existing banner)
        const safeHasBanner = safe.includes('correct-count');
        if (rawQTextBnr && !safeHasBanner && safeNormBnr.startsWith(rawQTextBnr)) {
          safe = expectedWithBanner;
        }
      }
    } catch { /* ignore */ }
    return safe;
  }

  /**
   * Resolve the active question index (URL-first, then quizService) and the
   * live question object (shuffle-aware). Shared by the NUCLEAR GATE phases.
   * Extracted verbatim.
   */
  private resolveActiveLiveQuestion(host: Host, _liveIdx: number): { activeIdx: number; liveQ: any } {
    const qs: any = host.quizService;
    const activeIdx: number = (_liveIdx >= 0)
      ? _liveIdx
      : (Number.isFinite(qs?.currentQuestionIndex)
        ? qs.currentQuestionIndex
        : (qs?.getCurrentQuestionIndex?.() ?? 0));
    const isShuffled = qs?.isShuffleEnabled?.()
      && Array.isArray(qs?.shuffledQuestions)
      && qs.shuffledQuestions.length > 0;
    const liveQ: any = isShuffled
      ? qs?.shuffledQuestions?.[activeIdx]
      : qs?.questions?.[activeIdx];
    return { activeIdx, liveQ };
  }

  /**
   * NUCLEAR-GATE FET detection: does the outgoing text contain the live or
   * pristine explanation, or the "is/are correct because" markers? Extracted
   * verbatim.
   */
  private nuclearLooksLikeFet(host: Host, liveQ: any, safeNorm: string): boolean {
    let pristineExplanation = '';
    try {
      const pq = host.quizService?.getPristineQuestionByText(liveQ?.questionText);
      if (pq) pristineExplanation = norm(pq.explanation ?? '');
    } catch { /* ignore */ }

    const rawExplNorm = norm(liveQ?.explanation ?? '');
    const containsRawExpl =
      (!!rawExplNorm && safeNorm.includes(rawExplNorm))
      || (!!pristineExplanation && safeNorm.includes(pristineExplanation));
    return safeNorm.includes('are correct because')
      || safeNorm.includes('is correct because')
      || containsRawExpl;
  }

  /**
   * Build the URL question's heading HTML, appending the "N answers are correct"
   * banner for multi-answer questions (pristine correct-count, with a fallback
   * banner string). Extracted verbatim from the URL-AUTHORITATIVE GUARD.
   */
  private buildUrlQuestionHtml(host: Host, urlQ: any): string {
    // Use pristine quizInitialState for correct count — live
    // options can be mutated by option-lock-policy.
    let correctCount = 0;
    let totalOpts = (urlQ?.options ?? []).length;
    try {
      const _pq = host.quizService?.getPristineQuestionByText(urlQ.questionText);
      if (_pq) {
        correctCount = (_pq.options ?? []).filter((o: any) => isOptionCorrect(o)).length;
        totalOpts = (_pq.options ?? []).length;
      }
    } catch { /* ignore */ }
    if (correctCount === 0) {
      correctCount = (urlQ?.options ?? []).filter((o: any) => isOptionCorrect(o)).length;
    }
    if (correctCount > 1 && totalOpts > 0) {
      try {
        const banner = host.quizQuestionManagerService.getNumberOfCorrectAnswersText(
          correctCount, totalOpts
        );
        return withCorrectCountBanner(urlQ.questionText, banner);
      } catch {
        return withCorrectCountBanner(urlQ.questionText, `(${correctCount} answers are correct)`);
      }
    }
    return urlQ.questionText;
  }

  /**
   * Gather selected option texts for an index from the selection map and the
   * durable sel_Q* sessionStorage entry. Shared by the LAST-LINE and FINAL
   * PRISTINE gates. Extracted verbatim.
   */
  private collectSelectedTextsForIndex(host: Host, idx: number): Set<string> {
    const out = new Set<string>();
    this.gatherSelectionMapSelections(host, idx, out);
    this.gatherSessionStorageSelections(idx, out);
    return out;
  }

  /**
   * Look up the pristine correct-option texts for a question (by normalized
   * text) in quizInitialState. Extracted verbatim from the FINAL PRISTINE GATE.
   */
  private findPristineCorrectTexts(host: Host, qTextNorm: string): string[] {
    let _pCorrect: string[] = [];
    const _bundle: any[] = (host.quizService as any)?.quizInitialState ?? [];
    for (let qi = 0; qi < _bundle.length; qi++) {
      const _questions = _bundle[qi]?.questions ?? [];
      for (let pi = 0; pi < _questions.length; pi++) {
        if (norm(_questions[pi]?.questionText) === qTextNorm) {
          _pCorrect = (_questions[pi]?.options ?? [])
            .filter((o: any) => isOptionCorrect(o))
            .map((o: any) => norm(o?.text))
            .filter((t: string) => !!t);
          break;
        }
      }
      if (_pCorrect.length > 0) break;
    }
    return _pCorrect;
  }

  /**
   * HARD-GATE FET detection for one pristine entry: explanation match, or the
   * "is/are correct because" markers combined with any correct-text match.
   * Extracted verbatim.
   */
  private isHardGateFetSignal(safeNorm: string, correctOpts: any[], pristineQ: any): boolean {
    const explNorm = norm(pristineQ?.explanation);
    const correctTextsForSignal = correctOpts
      .map((o: any) => norm(o?.text))
      .filter((t: string) => !!t);
    const containsAnyCorrectText = correctTextsForSignal.some(
      (t: string) => !!t && safeNorm.includes(t)
    );
    const containsExpl = !!explNorm && safeNorm.includes(explNorm);
    const looksLikeFetLocal = safeNorm.includes('are correct because')
      || safeNorm.includes('is correct because');
    return containsExpl
      || (looksLikeFetLocal && containsAnyCorrectText);
  }

  /**
   * HARD-GATE unresolved replacement: unless the question is scored correct,
   * rebuild the heading back to the question display text (or pristine
   * fallback). Extracted verbatim.
   */
  private rebuildIfHardGateUnresolved(host: Host, safe: string, qIdx: number, pristineQ: any): string {
    let hardGateOverride = false;
    try {
      const qs2 = host.quizService;
      const displayIdx = host.currentIndex ?? (
        Number.isFinite(qs2?.currentQuestionIndex)
          ? qs2.currentQuestionIndex
          : (qs2?.getCurrentQuestionIndex?.() ?? -1)
      );
      hardGateOverride = this.isScoredCorrectAtDisplay(host, displayIdx);
    } catch { /* ignore */ }
    if (hardGateOverride) {
      // overridden by questionCorrectness
    } else {
      const replacement = qIdx >= 0
        ? this.buildQuestionDisplayHTML(host, qIdx)
        : '';
      const fallback = pristineQ?.questionText ?? '';
      safe = replacement || fallback || '';
    }
    return safe;
  }

  /**
   * Look up the pristine explanation text for the question at an index, checked
   * against quizInitialState then the live question. Extracted verbatim from the
   * UNIVERSAL BACKSTOP.
   */
  private findPristineExplanation(host: Host, bsIdx: number, normBs: (t: any) => string): string {
    let pristineExplBs = '';
    try {
      const qsBs: any = host.quizService;
      const isShufBs = qsBs?.isShuffleEnabled?.() && qsBs?.shuffledQuestions?.length > 0;
      const qObjBs = isShufBs
        ? qsBs?.shuffledQuestions?.[bsIdx]
        : qsBs?.questions?.[bsIdx];
      const qTextBs = normBs(qObjBs?.questionText ?? '');
      if (qTextBs) {
        for (const quiz of qsBs?.quizInitialState ?? []) {
          for (const pq of quiz?.questions ?? []) {
            if (normBs(pq?.questionText) !== qTextBs) continue;
            pristineExplBs = normBs(pq?.explanation ?? '');
            break;
          }
          if (pristineExplBs) break;
        }
      }
      if (!pristineExplBs) {
        pristineExplBs = normBs(qObjBs?.explanation ?? '');
      }
    } catch { /* ignore */ }
    return pristineExplBs;
  }

  /**
   * Build the question display HTML for a given index. Shuffled-aware —
   * reads from host.quizService.shuffledQuestions when shuffle is on,
   * otherwise host.quizService.questions. Adds the "select N" banner
   * for multi-answer questions.
   */
  buildQuestionDisplayHTML(host: Host, idx: number): string {
    try {
      const isShuffled = host.quizService.isShuffleEnabled?.()
        && Array.isArray(host.quizService.shuffledQuestions)
        && host.quizService.shuffledQuestions.length > 0;
      const q = isShuffled
        ? host.quizService.shuffledQuestions[idx]
        : host.quizService.questions?.[idx];
      const rawQ = (q?.questionText ?? '').trim();
      if (!rawQ) return '';
      let numCorrect = 0;
      let totalOpts = (q?.options ?? []).length;
      try {
        const pq = host.quizService?.getPristineQuestionByText(rawQ);
        if (pq) {
          const pOpts = pq.options ?? [];
          numCorrect = pOpts.filter((o: any) => isOptionCorrect(o)).length;
          totalOpts = pOpts.length;
        }
      } catch { /* ignore */ }
      if (numCorrect === 0) {
        const sourceOpts = q?.options ?? [];
        numCorrect = sourceOpts.filter((o: Option) => isOptionCorrect(o)).length;
        totalOpts = sourceOpts.length;
      }
      let display = rawQ;
      if (numCorrect > 1 && totalOpts > 0) {
        try {
          const banner = host.quizQuestionManagerService.getNumberOfCorrectAnswersText(
            numCorrect, totalOpts
          );
          display = withCorrectCountBanner(rawQ, banner);
        } catch { /* ignore */ }
      }
      return display;
    } catch {
      return '';
    }
  }

  /**
   * Check if the question at the given DISPLAY index is scored correct.
   */
  isScoredCorrectAtDisplay(host: Host, displayIdx: number): boolean {
    try {
      const qs: any = host.quizService;
      const scoringSvc = qs?.scoringService;
      if (!scoringSvc?.questionCorrectness) return false;
      const isShuf = qs?.isShuffleEnabled?.() && qs?.shuffledQuestions?.length > 0;
      if (isShuf) {
        let effectiveQuizId = qs?.quizId || '';
        if (!effectiveQuizId) {
          try { effectiveQuizId = localStorage.getItem('lastQuizId') || ''; } catch { /* ignore */ }
        }
        if (!effectiveQuizId) {
          try {
            const shuffleKeys = Object.keys(localStorage).filter((k: string) => k.startsWith('shuffleState:'));
            if (shuffleKeys.length > 0) {
              effectiveQuizId = shuffleKeys[0].replace('shuffleState:', '');
            }
          } catch { /* ignore */ }
        }
        if (effectiveQuizId) {
          const origIdx = scoringSvc.quizShuffleService?.toOriginalIndex?.(effectiveQuizId, displayIdx);
          if (typeof origIdx === 'number' && origIdx >= 0) {
            if (scoringSvc.questionCorrectness.get(origIdx) === true) return true;
          }
        }
      } else {
        if (scoringSvc.questionCorrectness.get(displayIdx) === true) return true;
      }
      return host.explanationTextService?.fetBypassForQuestion?.get(displayIdx) === true;
    } catch {
      return false;
    }
  }

  /**
   * Does this index have concrete evidence that FET should be showing?
   */
  hasInteractionEvidence(host: Host, idx: number): boolean {
    try {
      // Treat a timer-expired-without-answer question as interaction evidence —
      // when the timer auto-resolves a question the FET must show, and must
      // persist across tab visibility cycles. Without this, the visibility
      // restamp computes the question text instead of the FET and overwrites
      // the heading on tab return.
      if (this.dotStatusService.timerExpiredUnanswered?.has(idx)) return true;
      // SOC-set bypass flags are definitive interaction evidence — SOC only
      // sets them after verifying user-clicked selections satisfy the
      // question. Without this, a click→FET race in shuffled mode can leave
      // hasClickedInSession unset at the moment displayText$ emits the FET,
      // causing gates here to block the FET write.
      if (host.explanationTextService?.fetBypassForQuestion?.get(idx) === true) return true;
      if (host.quizService?._multiAnswerPerfect?.get(idx) === true) return true;
      return !!host.quizStateService.hasClickedInSession?.(idx);
    } catch {
      return false;
    }
  }

  /**
   * Check if the question at idx is fully resolved (all correct answers
   * selected) based on persisted sessionStorage / in-memory state.
   */
  isQuestionResolvedFromStorage(host: Host, idx: number): boolean {
    try {
      // Timer-expired-without-answer questions auto-resolve to FET — treat them
      // as resolved so the FET branch of computeIntendedQText fires on visibility
      // restamps. Otherwise tabbing away/back overwrites FET with question text.
      if (this.dotStatusService.timerExpiredUnanswered?.has(idx)) return true;
      if (this.isScoredCorrectAtDisplay(host, idx)) return true;

      let storedSelections: any[] = [];
      try {
        const raw = sessionStorage.getItem(SK_SEL_Q + idx);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) storedSelections = parsed;
        }
      } catch { /* ignore */ }
      if (storedSelections.length === 0) {
        storedSelections =
          host.selectedOptionService.getSelectedOptionsForQuestion?.(idx) ?? [];
      }
      storedSelections = storedSelections.filter((s: any) => s?.selected !== false);
      if (storedSelections.length > 0) {
        const questions = host.quizService.getQuestionsInDisplayOrder?.()
          ?? host.quizService.questions;
        const q = questions?.[idx];
        if (q) {
          const pristineCorrectTexts = Array.from(
            host.quizService?.getPristineCorrectTextsForQuestion(q?.questionText) ?? []
          );
          if (pristineCorrectTexts.length >= 2) {
            const selTexts = new Set(
              storedSelections
                .filter((s: any) => s?.selected !== false)
                .map((s: any) => norm(s?.text))
                .filter((t: string) => !!t)
            );
            return pristineCorrectTexts.every(t => selTexts.has(t));
          }
          return host.selectedOptionService.isQuestionResolvedLeniently?.(q, storedSelections)
            ?? false;
        }
      }
    } catch { /* ignore */ }
    return false;
  }

  // ══════════════════════════════════════════════════════════════════
  // DOM-LEVEL FET WATCHDOG. Installed by CodelabQuizContentComponent
  // on init. A MutationObserver on the <h3 #qText> element watches
  // every content change; if the new text looks like FET for a
  // multi-answer question that isn't yet fully resolved, the DOM is
  // reverted to plain question text. The ultimate safety net that
  // bypasses every RxJS/Angular state path because it runs after the
  // DOM has already been written.
  // ══════════════════════════════════════════════════════════════════

  installFetWatchdog(host: Host): void {
    try {
      const el: HTMLElement | undefined = host.qText?.()?.nativeElement;
      if (!el || typeof MutationObserver === 'undefined') return;

      const enforce = () => this.enforceFetGuard(host, el);
      const mo = new MutationObserver(enforce);
      mo.observe(el, { childList: true, characterData: true, subtree: true });
      host._fetWatchdog = mo;

      // Also enforce on every click (covers cases where the DOM
      // hasn't mutated recently but the selection changed).
      const clickHandler = () => setTimeout(enforce, 0);
      document.addEventListener('click', clickHandler, true);
      host._fetWatchdogClick = clickHandler;
    } catch (e) {
      console.error('CqcFetGuardService.installFetWatchdog install failed:', e);
    }
  }

  uninstallFetWatchdog(host: Host): void {
    try {
      host._fetWatchdog?.disconnect?.();
      if (host._fetWatchdogClick) {
        document.removeEventListener('click', host._fetWatchdogClick, true);
        host._fetWatchdogClick = null;
      }
      host._fetWatchdog = null;
    } catch { /* ignore */ }
  }

  private enforceFetGuard(host: Host, el: HTMLElement): void {
    try {
      const html = el.innerHTML ?? '';
      if (!this.looksLikeFet(host, html)) return;
      if (this.isMultiAnswerResolvedNow(host) === false) {
        this.revertQTextToQuestion(host, el);
      }
    } catch { /* ignore */ }
  }

  private revertQTextToQuestion(host: Host, el: HTMLElement): void {
    try {
      const liveQ = this.getLiveQuestion(host);
      const rawQ = (liveQ?.questionText ?? '').trim();
      if (rawQ) el.innerHTML = rawQ;
    } catch { /* ignore */ }
  }

  // Returns: true=resolved, false=not resolved, null=not multi-answer
  // (or lookup failed). Timer expiry on the current question always
  // counts as resolved so the FET stays visible.
  private isMultiAnswerResolvedNow(host: Host): boolean | null {
    try {
      const idx = this.getActiveIdx(host);
      const timedOutVal = host.timedOutIdxSubject?.getValue?.() ?? -1;
      if (timedOutVal >= 0 && timedOutVal === idx) return true;

      // AUTO-REVEAL BYPASS: when soc-answer-processing's auto-reveal sets
      // fetBypassForQuestion for this idx, treat the question as "resolved"
      // so the watchdog stops reverting the FET back to question text.
      if (host.explanationTextService?.fetBypassForQuestion?.get(idx) === true) {
        return true;
      }

      const liveQ = this.getLiveQuestion(host, idx);
      const pristineCorrectTexts = this.getPristineCorrectTexts(host, liveQ);
      if (pristineCorrectTexts.length < 2) return null;

      const selectedNow = this.collectSelectedTexts(host, liveQ, idx);
      return pristineCorrectTexts.every(t => selectedNow.has(t));
    } catch {
      return null;
    }
  }

  private looksLikeFet(host: Host, html: string): boolean {
    const n = norm(html);
    if (!n) return false;
    if (n.includes('are correct because') || n.includes('is correct because')) return true;
    try {
      const liveQ = this.getLiveQuestion(host);
      const qExp = norm(liveQ?.explanation ?? '');
      if (qExp && n.includes(qExp)) return true;

      const pq = host.quizService?.getPristineQuestionByText(liveQ?.questionText);
      if (pq) {
        const pExp = norm(pq.explanation ?? '');
        if (pExp && n.includes(pExp)) return true;
      }
    } catch { /* ignore */ }
    return false;
  }



  private getActiveIdx(host: Host): number {
    // PREFER the URL — currentQuestionIndex lags during multi-step nav
    // (Q4 -> URL-bar Q6) and would have getLiveQuestion return the prior
    // question, which is what revertQTextToQuestion was writing into the
    // heading.
    try {
      const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
      if (m) {
        const urlIdx = Number(m[1]) - 1;
        if (urlIdx >= 0) return urlIdx;
      }
    } catch { /* non-browser env */ }

    const qs: any = host.quizService;
    return Number.isFinite(qs?.currentQuestionIndex)
      ? qs.currentQuestionIndex
      : (qs?.getCurrentQuestionIndex?.() ?? 0);
  }

  private getLiveQuestion(host: Host, idx: number = this.getActiveIdx(host)): QuizQuestion | undefined {
    const qs: any = host.quizService;
    const isShuffled = qs?.isShuffleEnabled?.()
      && Array.isArray(qs?.shuffledQuestions)
      && qs.shuffledQuestions.length > 0;
    return isShuffled ? qs?.shuffledQuestions?.[idx] : qs?.questions?.[idx];
  }

  private getPristineCorrectTexts(host: Host, liveQ: any): string[] {
    return Array.from(
      host.quizService?.getPristineCorrectTextsForQuestion(liveQ?.questionText) ?? []
    );
  }

  private collectSelectedTexts(host: Host, liveQ: any, idx: number): Set<string> {
    const selectedNow = new Set<string>();

    const liveOpts: any[] = Array.isArray(liveQ?.options) ? liveQ.options : [];
    for (const o of liveOpts) {
      const isSel = o?.selected === true || o?.highlight === true || o?.showIcon === true;
      if (!isSel) continue;
      const t = norm(o?.text);
      if (t) selectedNow.add(t);
    }

    const rawMap: any = host.selectedOptionService?.selectedOptionsMap;
    if (rawMap && typeof rawMap.get === 'function') {
      const mapSel: any[] = rawMap.get(idx) ?? [];
      for (const o of mapSel) {
        if (o?.selected === false) continue;
        const t = norm(o?.text);
        if (t) selectedNow.add(t);
      }
    }

    return selectedNow;
  }
}
