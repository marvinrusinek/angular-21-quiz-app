import { forwardRef, inject, Injectable, Injector } from '@angular/core';

import { QuestionType } from '../../../models/question-type.enum';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

import { QUESTION_ROUTE_REGEX } from '../../../constants/route-patterns';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

import { ExplanationTextService } from '../explanation/explanation-text.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';

@Injectable({ providedIn: 'root' })
export class FeedbackService {
  // ── injects ─────────────────────────────────────────────────────
  // ExplanationTextService is forwardRef'd to preserve the circular-DI
  // workaround the original constructor used (FeedbackService is consumed
  // by Quiz/FET/explanation pipelines that can resolve in either order).
  private readonly explanationTextService = inject<ExplanationTextService>(
    forwardRef(() => ExplanationTextService) as any
  );
  private readonly injector = inject(Injector);
  private readonly selectedOptionService = inject(SelectedOptionService);

  public generateFeedbackForOptions(
    _correctOptions: Option[],
    optionsToDisplay: Option[]
  ): string {
    const validOptionsToDisplay = (optionsToDisplay || []).filter(opt => opt && typeof opt === 'object');

    if (validOptionsToDisplay.length === 0) return 'Feedback unavailable.';

    const correctFeedback = this.setCorrectMessage(validOptionsToDisplay);
    if (!correctFeedback?.trim()) return 'Feedback unavailable.';

    return correctFeedback;
  }

  public buildFeedbackMessage(
    question: QuizQuestion,
    selected: Array<SelectedOption | Option> | null,
    _strict: boolean = false,
    timedOut: boolean = false,
    displayIndex?: number,
    optionsToDisplay?: Option[],
    targetOption?: Option
  ): string {
    if (timedOut) return 'Time\'s up. Review the explanation above.';

    // URL-AUTHORITATIVE EARLY-EXIT: when on /question/{quizId}/{N},
    // collect every recorded click (targetOption, the `selected` array,
    // and the selectedOptionService) and reconcile it against the URL
    // question's correct options.
    //
    // Single-answer: any one correct match â†’ "You're right!".
    // Multi-answer: ALL correct options selected AND zero incorrect
    //   selections â†’ "You're right!"; otherwise fall through to the
    //   count logic below which produces "Select N more correct
    //   answer(s)" or "Not this one" as appropriate.
    try {
      const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
      if (m) {
        const urlIdx = Number(m[1]) - 1;
        const quizSvcEarly: any = this.injector.get(QuizService, null);
        const urlQ: any = (quizSvcEarly?.questions ?? [])[urlIdx];
        const urlOpts: any[] = urlQ?.options ?? [];
        if (urlOpts.length > 0) {
          const correctIdxsURL: number[] = [];
          const correctTextsURL = new Set<string>();
          const allTextsURL = new Set<string>();
          for (const [i, o] of urlOpts.entries()) {
            const c = (o as any)?.correct;
            const text = norm(o?.text);
            if (text) allTextsURL.add(text);
            if (c === true || c === 1 || String(c) === 'true') {
              correctIdxsURL.push(i + 1);
              if (text) correctTextsURL.add(text);
            }
          }

          if (correctTextsURL.size > 0) {
            const candidateTexts = new Set<string>();
            if (targetOption?.text) {
              candidateTexts.add(norm(targetOption.text));
            }
            for (const s of (selected ?? []) as any[]) {
              if (s?.text) candidateTexts.add(norm(s.text));
            }
            try {
              const liveSelections =
                quizSvcEarly?.selectedOptionService?.getSelectedOptionsForQuestion?.(urlIdx) ??
                this.selectedOptionService?.getSelectedOptionsForQuestion?.(urlIdx) ?? [];
              for (const s of liveSelections) {
                if (s?.text) candidateTexts.add(norm(s.text));
              }
            } catch { /* ignore */ }

            const isMultiURL = correctTextsURL.size > 1;
            let candidateCorrect = 0;
            let candidateIncorrect = 0;
            for (const t of candidateTexts) {
              if (correctTextsURL.has(t)) candidateCorrect++;
              else if (allTextsURL.has(t)) candidateIncorrect++;
            }

            const allCorrectChosen = candidateCorrect >= correctTextsURL.size;
            const noIncorrectChosen = candidateIncorrect === 0;

            // Single-answer: one correct match is sufficient.
            // Multi-answer: require all correct selected with no incorrect.
            const shouldShortCircuit = isMultiURL
              ? (allCorrectChosen && noIncorrectChosen)
              : (candidateCorrect >= 1);

            if (shouldShortCircuit) {
              const dedupedC = Array.from(new Set(correctIdxsURL)).sort((a, b) => a - b);
              if (dedupedC.length === 1) {
                return `You're right! The correct answer is Option ${dedupedC[0]}.`;
              }
              if (dedupedC.length > 1) {
                const listC = `${dedupedC.slice(0, -1).join(', ')} and ${dedupedC[dedupedC.length - 1]}`;
                return `You're right! The correct answers are Options ${listC}.`;
              }
              return `You're right!`;
            }
          }
        }
      }
    } catch { /* non-browser env */ }

    /* const quizSvc = this.injector.get(QuizService, null);
    const qIdx = displayIndex ?? (question as any).questionIndex ?? quizSvc?.currentQuestionIndex ?? 0;
    let correctIndices = this.explanationTextService.getCorrectOptionIndices(question, optionsToDisplay ?? question.options ?? [], qIdx); */
    const quizSvc = this.injector.get(QuizService, null);
    const currentIndex = quizSvc?.currentQuestionIndex;

    // CRITICAL: when the caller passes a stale `question` object (e.g. Q1
    // while the user is on Q3), resolve to the canonical question at the
    // current index from quizService so feedback option numbers reflect
    // the question the user is actually looking at.
    // SIMPLIFIED: Resolve canonical question by matching passed question's
    // TEXT against quizService.questions[]. The passed `question` object is
    // the source of truth for "which question the user is looking at".
    // We then read the canonical options (with correct flags) from
    // quizService.questions[] for that same text.
    let resolvedQuestion: QuizQuestion = question ?? {
      questionText: '', options: optionsToDisplay ?? [], explanation: '',
      type: QuestionType.SingleAnswer
    };
    let resolvedIdx = -1;
    try {
      const allQs: QuizQuestion[] = quizSvc?.questions ?? [];

      // FIRST: parse the URL directly. The URL is the only truly reliable
      // source â€” signals/services can lag during rapid navigation, and
      // upstream callers can pass stale `question` references (e.g. Q1's
      // object while the user is actually on Q3). The route is structured
      // /question/{quizId}/{1-based-index}.
      try {
        const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
        if (m) {
          const urlIdx = Number(m[1]) - 1;
          if (urlIdx >= 0 && allQs[urlIdx]?.options?.length) {
            resolvedIdx = urlIdx;
            resolvedQuestion = allQs[urlIdx];
          }
        }
      } catch { /* non-browser env */ }

      // FALLBACK: text-match the passed question (legacy behaviour). Used
      // when the URL parse fails (e.g., during early bootstrap or in a
      // non-browser environment).
      if (resolvedIdx < 0) {
        const passedText = norm(question?.questionText);
        if (passedText && allQs.length) {
          resolvedIdx = allQs.findIndex(
            (q) => norm(q?.questionText) === passedText
          );
          if (resolvedIdx >= 0 && allQs[resolvedIdx]?.options?.length) {
            resolvedQuestion = allQs[resolvedIdx];
          }
        }
      }
    } catch {}

    const idxForLookup = resolvedIdx >= 0
      ? resolvedIdx
      : (typeof displayIndex === 'number' && displayIndex >= 0
        ? displayIndex
        : (typeof currentIndex === 'number' ? currentIndex : undefined));

    // Compute correctIndices DIRECTLY from canonical question's correct flags.
    let correctIndices: number[] = [];
    const canonicalOpts: Option[] = (resolvedQuestion?.options ?? []) as Option[];
    for (const [i, o] of canonicalOpts.entries()) {
      if (isOptionCorrect(o)) correctIndices.push(i + 1);
    }
    if (correctIndices.length === 0) {
      correctIndices = this.explanationTextService.getCorrectOptionIndices(
        resolvedQuestion,
        canonicalOpts,
        idxForLookup
      );
    }

    if ((!correctIndices || correctIndices.length === 0) && quizSvc) {
      const qText = norm(question.questionText);
      if (qText) {
        const allQuestions = (quizSvc as any)._questions || quizSvc.questions || [];
        const sourceQ = allQuestions.find(
          (q: QuizQuestion) => norm(q.questionText) === qText
        );
        if (sourceQ?.options) {
          const foundIndices = sourceQ.options
            .map((o: Option, i: number) =>
              isOptionCorrect(o) ? i + 1 : null
            )
            .filter((n: number | null): n is number => n !== null);
          if (foundIndices.length > 0) correctIndices = foundIndices;
        }
      }
    }

    const optionsRaw = optionsToDisplay || (question.options || []);

    // Prefer the RAW source-of-truth options from quizService for correctness
    // checks â€” optionsToDisplay can carry stale/polluted `correct` flags from
    // prior question rendering, which yields wrong feedback option numbers.
    // Use the resolvedQuestion's options as the truth source â€” these come
    // from quizService.questions[resolvedIdx] (located above by text match).
    let truthOptions: Option[] = (resolvedQuestion?.options?.length
      ? resolvedQuestion.options
      : optionsRaw) as Option[];

    // â”€â”€ GUARDRAIL: Cross-validate correctIndices against visual correct flags â”€â”€
    if (truthOptions.length > 0) {
      const visualCorrect = truthOptions
        .map((o: Option, i: number) => isOptionCorrect(o) ? i + 1 : null)
        .filter((n: number | null): n is number => n !== null);

      if (visualCorrect.length > 0) {
        const sortedCalc = [...correctIndices].sort((a, b) => a - b);
        const sortedVisual = [...visualCorrect].sort((a, b) => a - b);
        const match = sortedCalc.length === sortedVisual.length &&
          sortedCalc.every((n, i) => n === sortedVisual[i]);

        if (!match) correctIndices = visualCorrect;
      }
    }

    // Multi-Answer detection: trust multiple indices OR multiple database flags
    const isMultiMode =
      correctIndices.length > 1 ||
      question.type === QuestionType.MultipleAnswer ||
      (question as any).multipleAnswer === true;

    const selectedArr = (selected ?? []) as any[];
    let numCorrectSelected = 0;
    let numIncorrectSelected = 0;

    const normalizedSelected = new Map<string, any>();
    for (const sel of selectedArr) {
      const id = sel.optionId != null ? String(sel.optionId) : sel.text;
      if (id) normalizedSelected.set(id, sel);
    }
    const dedupedSelected = Array.from(normalizedSelected.values());

    // Canonical options for text-match. Build from the URL question
    // directly (most authoritative; never mutated by gameplay) and fall
    // back to resolvedQuestion only when the URL parse is unavailable.
    // This catches the intermittent "Not this one" on Q3 Option 4
    // where the click handler hands us a `sel` with `correct: false`
    // and optionsRaw / resolvedQuestion are also stale.
    let canonicalOptionsForMatch: Option[] = [];
    try {
      const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
      if (m) {
        const urlIdx = Number(m[1]) - 1;
        const allQs: any[] = quizSvc?.questions ?? [];
        if (urlIdx >= 0 && allQs[urlIdx]?.options?.length) {
          canonicalOptionsForMatch = allQs[urlIdx].options as Option[];
        }
      }
    } catch { /* non-browser env */ }
    if (canonicalOptionsForMatch.length === 0) {
      canonicalOptionsForMatch = (resolvedQuestion?.options ?? []) as Option[];
    }

    for (const sel of dedupedSelected) {
      let visualIdx = sel.displayIndex;
      if (visualIdx === undefined || visualIdx < 0) {
        visualIdx = optionsRaw.findIndex((o: Option) =>
          o === sel ||
          (o.optionId != null && sel.optionId != null && String(o.optionId) === String(sel.optionId)) ||
          (o.text && sel.text && String(o.text).trim() === String(sel.text).trim())
        );
      }

      // CANONICAL TEXT MATCH: lookup the selected option in the URL-resolved
      // question's options by text and read THAT correct flag. Survives
      // bindings whose `correct: true` was wiped after Qâ†’Qâ†’Q navigation.
      let canonicalCorrect = false;
      if (sel?.text && canonicalOptionsForMatch.length) {
        const selText = String(sel.text).trim();
        const match = canonicalOptionsForMatch.find(
          (o: Option) => o?.text && String(o.text).trim() === selText
        );
        if (match) canonicalCorrect = isOptionCorrect(match);
      }

      // ROBUST EVALUATION:
      // An option is correct if its `correct` flag is true OR its visual
      // position matches a correct index OR the canonical-by-text lookup
      // says it's correct.
      const isCorrect = isOptionCorrect(sel) ||
        (visualIdx >= 0 && correctIndices.includes(visualIdx + 1)) ||
        canonicalCorrect;

      if (isCorrect) {
        numCorrectSelected++;
      } else {
        numIncorrectSelected++;
      }
    }

    // CROSS-CHECK: Count correct/incorrect selections directly from optionsRaw (optionsToDisplay).
    // This handles cases where the `selected` parameter is incomplete due to timing/ID issues.
    if (isMultiMode && optionsRaw.length > 0) {
      let rawCorrectSelected = 0;
      let rawIncorrectSelected = 0;
      for (const o of optionsRaw) {
        if (o.selected) {
          if (isOptionCorrect(o)) {
            rawCorrectSelected++;
          } else {
            rawIncorrectSelected++;
          }
        }
      }
      // Also count targetOption if it's correct and selected (just clicked)
      if (targetOption && targetOption.selected && isOptionCorrect(targetOption)) {
        // Check if targetOption is already counted in rawCorrectSelected
        const alreadyCounted = optionsRaw.some(o =>
          o.selected && isOptionCorrect(o) &&
          ((o.text && targetOption.text && String(o.text).trim() === String(targetOption.text).trim()) ||
            (o.optionId != null && targetOption.optionId != null && String(o.optionId) === String(targetOption.optionId)))
        );
        if (!alreadyCounted) rawCorrectSelected++;
      }
      // Use whichever source found MORE correct selections (more complete picture)
      if (rawCorrectSelected > numCorrectSelected) {
        numCorrectSelected = rawCorrectSelected;
        numIncorrectSelected = rawIncorrectSelected;
      }
    }

    const totalCorrectRequired = correctIndices.length > 0 ? correctIndices.length : 1;

    // Multi-Answer detection consistency: Resolved if counts match (even if incorrects are present)
    const isMultiResolved = isMultiMode && numCorrectSelected >= totalCorrectRequired;

    // Special safeguard: if it was truly perfectly resolved by our counts, override text right here.
    if (isMultiResolved) {
      const formatReveal = (indices: number[]) => {
        const deduped = Array.from(new Set(indices)).sort((a, b) => a - b);
        if (deduped.length === 0) return '';
        if (deduped.length === 1) return `The correct answer is Option ${deduped[0]}.`;
        const list = deduped.length > 1
          ? `${deduped.slice(0, -1).join(', ')} and ${deduped[deduped.length - 1]}`
          : `${deduped[0]}`;
        return `The correct answers are Options ${list}.`;
      };
      return `You're right! ${formatReveal(correctIndices)}`;
    }

    const formatReveal = (indices: number[]) => {
      const deduped = Array.from(new Set(indices)).sort((a, b) => a - b);
      if (deduped.length === 0) return '';
      if (deduped.length === 1) return `The correct answer is Option ${deduped[0]}.`;
      const list = `${deduped.slice(0, -1).join(', ')} and ${deduped[deduped.length - 1]}`;
      return `The correct answers are Options ${list}.`;
    };

    const finalRevealMessage = formatReveal(correctIndices);

    if (!selected || dedupedSelected.length === 0) return '';

    if (isMultiMode) {
      // If a specific option was clicked, prioritize its individual feedback
      if (targetOption) {
        // Robustly determine if the target option is correct
        const isTargetCorrect = isOptionCorrect(targetOption) ||
          (optionsRaw.findIndex(o =>
            o === targetOption ||
            (o.optionId != null && targetOption.optionId != null && String(o.optionId) === String(targetOption.optionId)) ||
            (o.text && targetOption.text && String(o.text).trim() === String(targetOption.text).trim())
          ) >= 0 &&
            correctIndices.includes(optionsRaw.findIndex(o =>
              o === targetOption ||
              (o.optionId != null && targetOption.optionId != null && String(o.optionId) === String(targetOption.optionId)) ||
              (o.text && targetOption.text && String(o.text).trim() === String(targetOption.text).trim())
            ) + 1));

        if (isTargetCorrect) {
          if (numCorrectSelected >= totalCorrectRequired && numIncorrectSelected === 0) {
            return `You're right! ${finalRevealMessage}`;
          }
          const remainingTotal = Math.max(totalCorrectRequired - numCorrectSelected, 0);
          const remainingText = remainingTotal === 1
            ? '1 more correct answer'
            : `${remainingTotal} more correct answers`;
          return `That's correct! Please select ${remainingText}.`;
        } else {
          return 'Not this one, try again!';
        }
      }

      // Fallback/Legacy logic for when targetOption isn't provided
      if (numIncorrectSelected > 0) return 'Not this one, try again!';

      if (numCorrectSelected >= totalCorrectRequired) {
        return `You're right! ${finalRevealMessage}`;
      }

      if (numCorrectSelected > 0) {
        const remainingTotal = Math.max(totalCorrectRequired - numCorrectSelected, 0);
        const remainingText = remainingTotal === 1
          ? '1 more correct answer'
          : `${remainingTotal} more correct answers`;
        return `That's correct! Please select ${remainingText}.`;
      }
      return 'Please select the correct answers to continue.';
    } else {
      // SINGLE-ANSWER LOGIC
      if (numCorrectSelected >= 1 && numIncorrectSelected === 0) {
        return `You're right! ${finalRevealMessage}`;
      }
      return 'Not this one, try again!';
    }
  }

  public setCorrectMessage(
    optionsToDisplay?: Option[],
    question?: QuizQuestion
  ): string {
    if (!optionsToDisplay || optionsToDisplay.length === 0) {
      return 'Feedback unavailable.';
    }

    const quizSvc = this.injector.get(QuizService, null);
    const currentIndex = quizSvc?.currentQuestionIndex;
    // Resolve canonical question by text-match against quizService.questions[]
    let canonicalQ: QuizQuestion | undefined = question;
    try {
      const allQs: QuizQuestion[] = quizSvc?.questions ?? [];
      const passedText = norm(question?.questionText);
      if (passedText && allQs.length) {
        const idx = allQs.findIndex(q => norm(q?.questionText) === passedText);
        if (idx >= 0 && allQs[idx]?.options?.length) canonicalQ = allQs[idx];
      }
    } catch {}
    const directFromCanonical: number[] = [];
    for (const [i, o] of (canonicalQ?.options ?? []).entries()) {
      if (isOptionCorrect(o)) directFromCanonical.push(i + 1);
    }
    const indices = directFromCanonical.length > 0
      ? directFromCanonical
      : this.explanationTextService.getCorrectOptionIndices(question!, optionsToDisplay, typeof currentIndex === 'number' ? currentIndex : undefined);
    const deduped = Array.from(new Set(indices)).sort((a, b) => a - b);
    if (deduped.length === 0) return 'No correct options found.';

    const optionsText = deduped.length === 1 ? 'answer is Option' : 'answers are Options';
    const optionStrings = deduped.length > 1
      ? `${deduped.slice(0, -1).join(', ')} and ${deduped.slice(-1)}`
      : `${deduped[0]}`;

    return `The correct ${optionsText} ${optionStrings}.`;
  }
}