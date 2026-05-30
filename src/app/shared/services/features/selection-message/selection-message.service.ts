import { Injectable, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Observable } from 'rxjs';
import { distinctUntilChanged } from 'rxjs/operators';

import { QuestionType } from '../../../models/question-type.enum';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';

const START_MSG = 'Please start the quiz by selecting an option.';
const CONTINUE_MSG = 'Please select an option to continue...';
const NEXT_BTN_MSG = 'Answered ✓ Click Next to continue...';
const SHOW_RESULTS_MSG = 'Answered ✓ Click Show Results...';

interface OptionSnapshot {
  id: number | string,
  selected: boolean,
  correct?: boolean
}

@Injectable({ providedIn: 'root' })
export class SelectionMessageService {
  // Signal-first source of truth
  readonly selectionMessageSig = signal<string>(START_MSG);
  public readonly selectionMessage$: Observable<string> =
    toObservable(this.selectionMessageSig).pipe(distinctUntilChanged());

  // Signal-first options snapshot
  readonly optionsSnapshotSig = signal<Option[]>([]);
  public get optionsSnapshot(): Option[] { return this.optionsSnapshotSig(); }
  public set optionsSnapshot(v: Option[]) { this.optionsSnapshotSig.set(v); }

  private _idMapByIndex = new Map<number, Map<string, string | number>>();

  // Progression Locks
  public _singleAnswerIncorrectLock = new Set<number>();
  public _singleAnswerCorrectLock = new Set<number>();
  private _multiAnswerInProgressLock = new Set<number>();
  private _multiAnswerCompletionLock = new Set<number>();
  private _multiAnswerPreLock = new Set<number>();

  public _lastMessageByIndex = new Map<number, string>();
  public _baselineReleased = new Set<number>();
  public _wrongClickCounts = new Map<number, number>();

  private _pendingMsgTokens = new Map<number, number>();

  private quizService = inject(QuizService);
  private selectedOptionService = inject(SelectedOptionService);

  public getCurrentMessage(): string {
    return this.selectionMessageSig();
  }

  public resetAll(): void {
    this._singleAnswerCorrectLock.clear();
    this._singleAnswerIncorrectLock.clear();
    this._multiAnswerInProgressLock.clear();
    this._multiAnswerCompletionLock.clear();
    this._multiAnswerPreLock.clear();
    this._lastMessageByIndex.clear();
    this._baselineReleased.clear();
    this._pendingMsgTokens.clear();
    this._idMapByIndex.clear();
    this._wrongClickCounts?.clear();
    this.optionsSnapshotSig.set([]);
    this.selectionMessageSig.set(START_MSG);
  }

  private getQuestion(index: number): QuizQuestion | null {
    const svc = this.quizService as any;
    const questions = (svc.isShuffleEnabled() && svc.shuffledQuestions?.length > 0)
      ? svc.shuffledQuestions : svc.questions;

    return (Array.isArray(questions) && index >= 0 && index < questions.length)
      ? questions[index] : (svc.currentQuestion?.value ?? null);
  }

  public determineSelectionMessage(
    questionIndex: number,
    totalQuestions: number,
    _isAnswered: boolean
  ): string {
    const uiSnapshot = this.getLatestOptionsSnapshot();
    if (!uiSnapshot || uiSnapshot.length === 0) {
      return questionIndex === 0 ? START_MSG : CONTINUE_MSG;
    }

    const q = this.getQuestion(questionIndex);
    const declaredType: QuestionType | undefined = q?.type;

    const keyOf = (o: any): string | number => {
      if (!o) return '__nil';
      if (o.optionId != null) return o.optionId;
      if (o.id != null) return o.id;
      const v = norm(o.value);
      const t = norm(o.text ?? o.label);
      return `${v}|${t}`;
    };

    const selectedKeys = new Set<string | number>();
    for (const o of uiSnapshot) if (o?.selected) selectedKeys.add(keyOf(o));

    const rawSel = this.selectedOptionService?.selectedOptionsMap?.get(questionIndex);
    const extraKeys = this.collectSelectedKeys(rawSel, keyOf);
    for (const k of extraKeys) selectedKeys.add(k);

    const canonical = Array.isArray(q?.options) ? (q!.options as Option[]) : [];
    this.ensureStableIds(questionIndex, canonical, uiSnapshot);

    const overlaid: Option[] = 
      (canonical.length ? canonical : this.normalizeOptionArray(uiSnapshot)).map((o, idx) => {
        const id = this.toStableId(o, idx);
        return this.toOption(o, idx, selectedKeys.has(id) || !!o.selected);
      }
    );

    const correctCount = overlaid.filter((o) => !!o?.correct).length;
    const qType: QuestionType = (correctCount > 1 || declaredType === QuestionType.MultipleAnswer)
      ? QuestionType.MultipleAnswer : (declaredType ?? QuestionType.SingleAnswer);

    return this.computeFinalMessage({
      index: questionIndex,
      total: totalQuestions,
      qType,
      opts: overlaid
    });
  }

  public computeFinalMessage(args: {
    index: number;
    total: number;
    qType: QuestionType;
    opts: Option[];
  }): string {
    const { index, total, qType, opts } = args;
    if (!opts || opts.length === 0) return index === 0 ? START_MSG : CONTINUE_MSG;
    const isLastQuestion = total > 0 && index === total - 1;

    const isCorrectHelper = isOptionCorrect;

    const totalCorrect = opts.filter(o => isCorrectHelper(o)).length;
    const selectedCorrect = opts.filter(o => o.selected && isCorrectHelper(o)).length;
    const selectedWrong = opts.filter(o => o.selected && !isCorrectHelper(o)).length;

    if (qType === QuestionType.SingleAnswer) {
      if (selectedCorrect > 0) {
        this._singleAnswerCorrectLock.add(index);
        this._singleAnswerIncorrectLock.delete(index);
        return isLastQuestion ? SHOW_RESULTS_MSG : NEXT_BTN_MSG;
      }
      if (selectedWrong > 0) {
        this._singleAnswerIncorrectLock.add(index);
        // Track cumulative wrong clicks per question for last-question logic.
        if (!this._wrongClickCounts) this._wrongClickCounts = new Map();
        const prevCount = this._wrongClickCounts.get(index) ?? 0;
        this._wrongClickCounts.set(index, prevCount + 1);
        // On the last question, show "Show Results" only when ALL incorrect
        // options have been exhausted (correct auto-revealed).
        if (isLastQuestion) {
          const totalIncorrect = opts.filter(o => !isCorrectHelper(o)).length;
          if (this._wrongClickCounts.get(index)! >= totalIncorrect) {
            return SHOW_RESULTS_MSG;
          }
        }
        return 'Please select the correct answer to continue.';
      }
      return index === 0 ? START_MSG : CONTINUE_MSG;
    }

    if (qType === QuestionType.MultipleAnswer) {
      const remaining = totalCorrect - selectedCorrect;
      const totalSelected = selectedCorrect + selectedWrong;

      // All correct answers selected → Next button or Show Results
      if (remaining === 0) {
        this._multiAnswerCompletionLock.add(index);
        return isLastQuestion ? SHOW_RESULTS_MSG : NEXT_BTN_MSG;
      }

      // Nothing selected → prompt for total correct count
      if (totalSelected === 0) {
        return `Select ${totalCorrect} correct options to continue...`;
      }

      // Some selected but not all correct yet → show remaining correct needed
      this._multiAnswerInProgressLock.add(index);
      return `Select ${remaining} more correct answer${remaining !== 1 ? 's' : ''} to continue...`;
    }

    return index === 0 ? START_MSG : CONTINUE_MSG;
  }

  public pushMessage(newMsg: string, _index: number): void {
    this.selectionMessageSig.set(newMsg);
  }

  public releaseBaseline(index: number): void {
    this._baselineReleased.add(index);
    this._pendingMsgTokens.set(index, -1);
  }

  public forceNextButtonMessage(index: number, opts: { isLastQuestion?: boolean } = {}): void {
    const total = this.quizService.totalQuestions();
    const isLast = opts.isLastQuestion ?? (total > 0 && index === total - 1);
    const nextMsg = isLast ? SHOW_RESULTS_MSG : NEXT_BTN_MSG;
    this.releaseBaseline(index);
    this._lastMessageByIndex.set(index, nextMsg);
    this.pushMessage(nextMsg, index);
  }

  public enforceBaselineAtInit(i0: number, qType: QuestionType, totalCorrect: number): void {
    if (this._baselineReleased.has(i0)) return;
    const msg = qType === QuestionType.MultipleAnswer
      ? `Select ${totalCorrect} correct options to continue...`
      : (i0 === 0 ? START_MSG : CONTINUE_MSG);
    this._lastMessageByIndex.set(i0, msg);
    this.pushMessage(msg, i0);
  }

  public forceBaseline(index: number): void {
    const q = this.getQuestion(index);
    const totalCorrect = (q?.options ?? []).filter((o: any) => o.correct).length;
    const qType = (totalCorrect > 1 || q?.type === QuestionType.MultipleAnswer)
      ? QuestionType.MultipleAnswer : (q?.type ?? QuestionType.SingleAnswer);

    // Clear released state so enforceBaselineAtInit doesn't skip
    this._baselineReleased.delete(index);
    this._pendingMsgTokens.delete(index);

    this.enforceBaselineAtInit(index, qType, totalCorrect);
  }

  public async setSelectionMessage(isAnswered: boolean): Promise<void> {
    const i0 = this.quizService.currentQuestionIndex;
    const total = this.quizService.totalQuestions();
    if (i0 < 0 || !this._baselineReleased.has(i0) && !isAnswered) return;

    queueMicrotask(() => {
      if (this._pendingMsgTokens.get(i0) === -1) return;
      const msg = this.determineSelectionMessage(i0, total, isAnswered);
      if (this._lastMessageByIndex.get(i0) !== msg) {
        this._lastMessageByIndex.set(i0, msg);
        this.pushMessage(msg, i0);
      }
    });
  }

  public setOptionsSnapshot(opts: Option[] | null | undefined): void {
    const safe = Array.isArray(opts) ? opts.map((o) => ({ ...o })) : [];
    if (safe.length > 0) this.optionsSnapshotSig.set(safe);
  }

  public notifySelectionMutated(options: Option[] | null | undefined): void {
    this.setOptionsSnapshot(options);
  }

  public emitFromClick(params: any): void {
    const opts = params.canonicalOptions as Option[];
    const correctCount = (opts ?? []).filter(
      (o: any) => isOptionCorrect(o)
    ).length;
    const declaredType = params.questionType;
    const qType: QuestionType = (correctCount > 1 || declaredType === QuestionType.MultipleAnswer)
      ? QuestionType.MultipleAnswer : (declaredType ?? QuestionType.SingleAnswer);

    const msg = this.computeFinalMessage({
      index: params.index,
      total: params.totalQuestions,
      qType,
      opts
    });
    if (params.onMessageChange) params.onMessageChange(msg);
    this.pushMessage(msg, params.index);
  }

  private ensureStableIds(index: number, canonical: Option[], uiSnapshot: any[]): void {
    let fwd = this._idMapByIndex.get(index) ?? new Map<string, string | number>();
    for (const [i, c] of canonical.entries()) {
      const id = c.optionId ?? (c as any).id ?? `q${index}o${i}`;
      c.optionId = id;
      fwd.set(this.stableKey(c, i), id);
      fwd.set(`ix:${i}`, id);
    }
    this._idMapByIndex.set(index, fwd);
    for (const [i, o] of uiSnapshot.entries()) {
      const id = fwd.get(this.stableKey(o as Option, i)) ?? fwd.get(`ix:${i}`);
      if (id != null) (o as any).optionId = id;
    }
  }

  public stableKey(opt: Option, idx?: number): string {
    if (!opt) return `unknown-${idx ?? 0}`;
    if (opt.optionId != null && String(opt.optionId) !== '-1') return String(opt.optionId);
    if ((opt as any).id != null && String((opt as any).id) !== '-1') return String((opt as any).id);
    const v = norm(opt.value);
    const t = norm(opt.text ?? (opt as any).label);
    const core = v || t ? `${v}|${t}` : 'any';
    return `ix:${idx ?? 0}:${core}`;
  }

  private toStableId(o: any, idx?: number): number | string {
    return o?.optionId ?? o?.id ?? o?.value ?? (o?.text ? `t:${o.text}` : `i:${idx ?? 0}`);
  }

  private toOption(o: any, idx: number, selectedOverride?: boolean): Option {
    const id = this.toStableId(o, idx);
    const selected = selectedOverride ?? !!o?.selected;
    return {
      optionId: id as any,
      text: String(o?.text ?? o?.label ?? ''),
      correct: !!(o?.correct ?? o?.isCorrect),
      value: o?.value ?? id,
      selected,
      highlight: selected,
      showIcon: selected,
      feedback: String(o?.feedback ?? ''),
      styleClass: String(o?.styleClass ?? '')
    } as Option;
  }

  public getLatestOptionsSnapshot(): OptionSnapshot[] {
    const snap = this.optionsSnapshotSig();
    return Array.isArray(snap) ? snap.map((o, i) => ({
      id: this.toStableId(o, i),
      selected: !!o.selected,
      correct: typeof o.correct === 'boolean' ? o.correct : undefined
    })) : [];
  }

  public getLatestOptionsSnapshotAsOptions(): Option[] {
    return this.normalizeOptionArray(this.getLatestOptionsSnapshot());
  }

  private normalizeOptionArray(input: any[]): Option[] {
    return (input ?? []).map((item, idx) => {
      if ('id' in item && 'selected' in item) {
        return this.toOption({ ...item, optionId: item.id }, idx);
      }
      return this.toOption(item, idx);
    });
  }

  private collectSelectedKeys(rawSel: any, keyFn: (o: any) => string | number): Set<string | number> {
    const keys = new Set<string | number>();
    if (!rawSel) return keys;
    if (rawSel instanceof Set) {
      for (const s of rawSel) keys.add(s?.optionId ?? s);
    } else if (Array.isArray(rawSel)) {
      for (const o of rawSel) keys.add(keyFn(o));
    }
    return keys;
  }

  public reconcileObservedWithCurrentSelection(index: number, optionsNow: Option[]): void {
    const totalCorrect = optionsNow.filter(o => !!o?.correct).length;
    const q = this.getQuestion(index);
    const qType = (totalCorrect > 1 || q?.type === QuestionType.MultipleAnswer)
      ? QuestionType.MultipleAnswer
      : (q?.type ?? QuestionType.SingleAnswer);

    const msg = this.computeFinalMessage({
      index,
      total: this.quizService.totalQuestions(),
      qType,
      opts: optionsNow
    });
    this.setSelectionMessageText(msg);
  }

  public setSelectionMessageText(message: string): void {
    this.selectionMessageSig.set(message);
  }
}
