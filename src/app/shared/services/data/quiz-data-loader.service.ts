import { inject, Injectable, signal, WritableSignal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, from, Observable, of } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';

import { Quiz } from '../../models/Quiz.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';
import { QuizResource } from '../../models/QuizResource.model';
import { Resource } from '../../models/Resource.model';

import { SK_SHUFFLED_QUESTIONS, SK_SHUFFLED_QUESTIONS_QUIZ_ID } from '../../constants/session-keys';

import { QuizShuffleService } from '../flow/quiz-shuffle.service';

import { getQuizData, getQuizResources } from '../../quiz-data-cache';
import { isOptionCorrect } from '../../utils/is-option-correct';
import { Utils } from '../../utils/utils';

@Injectable({ providedIn: 'root' })
export class QuizDataLoaderService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly quizShuffleService = inject(QuizShuffleService);
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);

  // ── remaining variables ─────────────────────────────────────────
  quizInitialState: Quiz[] = structuredClone(getQuizData());
  quizData: Quiz[] | null = structuredClone(getQuizData());
  quizResources: QuizResource[] = [];
  resources: Resource[] = [];

  readonly currentQuizSig = signal<Quiz | null>(null);
  readonly currentQuiz$: Observable<Quiz | null> = toObservable(this.currentQuizSig);

  private canonicalQuestionsByQuiz = new Map<string, QuizQuestion[]>();
  private canonicalQuestionIndexByText = new Map<string, Map<string, number>>();

  private quizUrl = 'assets/data/quiz.json';
  private fetchPromise: Promise<QuizQuestion[]> | null = null;

  private readonly shuffleEnabledSig = signal<boolean>(
    localStorage.getItem('checkedShuffle') === 'true'
  );
  checkedShuffle$ = toObservable(this.shuffleEnabledSig);

  // Read-only signal alias for new code; existing $ subscribers unaffected.
  readonly checkedShuffleSig = this.shuffleEnabledSig.asReadonly();

  public shuffledQuestions: QuizQuestion[] = (() => {
    try {
      if (!localStorage.getItem('_shuffleCacheV2')) {
        localStorage.removeItem(SK_SHUFFLED_QUESTIONS);
        localStorage.removeItem(SK_SHUFFLED_QUESTIONS_QUIZ_ID);
        localStorage.setItem('_shuffleCacheV2', '1');
        return [];
      }
      const stored = localStorage.getItem(SK_SHUFFLED_QUESTIONS);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  })();

  questionsQuizId: string | null = (() => {
    try { return localStorage.getItem(SK_SHUFFLED_QUESTIONS_QUIZ_ID); }
    catch { return null; }
  })();

  initializeData(
    quizId: string
  ): { questions: QuizQuestion[]; totalQuestions: number; resolvedQuizId: string } {
    const cachedQuizData = getQuizData();
    if (!cachedQuizData || !Array.isArray(cachedQuizData)) {
      this.quizData = [];
    } else {
      // Deep-clone so gameplay mutations never propagate back to the cache
      this.quizData = structuredClone(cachedQuizData);
    }

    let questions: QuizQuestion[] = [];
    let totalQuestions = 0;
    let resolvedQuizId = quizId;

    if (this.quizData.length > 0) {
      // Always clone from the cached pristine dataset — never from
      // this.quizData which may carry mutations from prior quiz runs.
      this.quizInitialState = structuredClone(getQuizData());
      let selectedQuiz = quizId
        ? this.quizData.find((quiz) => quiz.quizId === quizId) : undefined;

      if (!selectedQuiz && quizId) {
        console.warn(`[QuizDataLoader] Quiz id=${quizId} not found, using default`);
      }

      selectedQuiz = selectedQuiz ?? this.quizData[0];
      resolvedQuizId = selectedQuiz.quizId;

      if (Array.isArray(selectedQuiz.questions) && selectedQuiz.questions.length > 0) {
        questions = [...selectedQuiz.questions];
      } else {
        questions = [];
      }

      totalQuestions = questions.length;
    } else {
      questions = [];
    }

    const cachedResources = getQuizResources();
    this.quizResources = Array.isArray(cachedResources) ? cachedResources : [];

    if (questions.length > 0) {
      const firstQuestion = questions[0];
      if (!this.isValidQuestionStructure(firstQuestion)) {
        console.warn('[QuizDataLoader] Invalid question structure detected', firstQuestion);
      }
    }

    return { questions, totalQuestions, resolvedQuizId };
  }

  loadResourcesForQuiz(quizId: string): void {
    const quizResource = this.quizResources.find(r => r.quizId === quizId);
    this.resources = quizResource?.resources ?? [];
  }

  setCurrentQuizSubject(quiz: Quiz | null): void {
    this.currentQuizSig.set(quiz);
  }

  getCurrentQuiz(quizId: string, activeQuiz: Quiz | null): Observable<Quiz | null> {
    if (activeQuiz) return of(activeQuiz);

    const quiz = Array.isArray(this.quizData)
      ? this.quizData.find((q) => q.quizId === quizId) : null;
    if (!quiz) {
      console.warn(`[QuizDataLoader] Quiz id=${quizId} not found in quizData`);
    }

    return of(quiz ?? null);
  }

  findQuizByQuizId(quizId: string): Observable<Quiz | undefined> {
    const foundQuiz = this.quizData?.find((quiz) => quiz.quizId === quizId) ?? null;
    if (foundQuiz && this.isQuiz(foundQuiz)) return of(foundQuiz as Quiz);

    return of(undefined);
  }

  async ensureQuizIdExists(quizId: string): Promise<{ exists: boolean; resolvedId: string }> {
    let resolved = quizId;
    if (!resolved) {
      resolved = this.activatedRoute.snapshot.paramMap.get('quizId') || quizId;
      if (resolved) localStorage.setItem('quizId', resolved);
    }
    return { exists: !!resolved, resolvedId: resolved };
  }

  getTotalQuestionsCount(quizId: string, questions: QuizQuestion[]): Observable<number> {
    return this.currentQuiz$.pipe(
      map((quiz) => {
        if (quiz && quiz.quizId === quizId) return quiz.questions?.length ?? 0;

        if (Array.isArray(questions) && questions.length > 0) {
          return questions.length;
        }

        return 0;
      }),
      distinctUntilChanged()
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Fetch & Shuffle
  // ═══════════════════════════════════════════════════════════════════════

  async fetchQuizQuestions(
    quizId: string,
    questionsSig: WritableSignal<QuizQuestion[]>,
    setInternalQuestions: (qs: QuizQuestion[]) => void
  ): Promise<QuizQuestion[]> {

    // Restore persisted shuffled order
    if (this.shouldShuffle() && (!this.shuffledQuestions || this.shuffledQuestions.length === 0)) {
      try {
        const persistedQuizId = localStorage.getItem(SK_SHUFFLED_QUESTIONS_QUIZ_ID);
        const persisted = localStorage.getItem(SK_SHUFFLED_QUESTIONS);
        if (persistedQuizId === quizId && persisted) {
          const parsed = JSON.parse(persisted);
          if (Array.isArray(parsed) && parsed.length > 0) {
            this.shuffledQuestions = parsed;
            this.questionsQuizId = quizId;
          }
        }
      } catch (e) {
        console.error('Failed to load shuffled questions from localStorage:', e);
      }
    }

    // Return existing shuffledQuestions if available
    if (this.shuffledQuestions && this.shuffledQuestions.length > 0) {
      const hasBadData = this.shuffledQuestions.some(q =>
        Array.isArray(q.options) &&
        q.options.length > 1 &&
        !q.options.some(o => isOptionCorrect(o))
      );

      if (hasBadData) {
        this.shuffledQuestions = [];
        setInternalQuestions([]);
        this.questionsQuizId = null;
        try {
          localStorage.removeItem(SK_SHUFFLED_QUESTIONS);
          localStorage.removeItem(SK_SHUFFLED_QUESTIONS_QUIZ_ID);
        } catch (e) {
          console.error('Failed to clear bad shuffled questions from localStorage:', e);
        }
      } else {
        const isSameQuiz = quizId && this.questionsQuizId === quizId;

        if (isSameQuiz) {
          if (Array.isArray(this.shuffledQuestions) && this.shuffledQuestions.length > 0) {
            questionsSig.set(this.shuffledQuestions);
            return this.shuffledQuestions;
          }
        } else {
          this.shuffledQuestions = [];
          setInternalQuestions([]);
          this.questionsQuizId = null;
          try {
            localStorage.removeItem(SK_SHUFFLED_QUESTIONS);
            localStorage.removeItem(SK_SHUFFLED_QUESTIONS_QUIZ_ID);
          } catch { }
        }
      }
    }

    if (this.fetchPromise) return this.fetchPromise;

    this.fetchPromise = (async () => {
      try {
        if (!quizId) return [];

        const quizzes = await firstValueFrom<Quiz[]>(
          this.http.get<Quiz[]>(this.quizUrl)
        );

        const quiz = quizzes.find((q) => String(q.quizId) === String(quizId));
        if (!quiz) return [];

        this.currentQuizSig.set(quiz);

        const isSameQuiz = quizId && this.questionsQuizId === quizId;
        const cachedLen = this.shuffledQuestions?.length || 0;
        const metadataLen = quiz.questions?.length || 0;
        const lengthMatches = cachedLen > 0 && cachedLen === metadataLen;

        if (isSameQuiz && lengthMatches) {
          questionsSig.set(this.shuffledQuestions);
          return this.shuffledQuestions;
        }

        this.shuffledQuestions = [];
        setInternalQuestions([]);
        this.questionsQuizId = quizId;

        const normalized: QuizQuestion[] = (quiz.questions ?? []).map((q, qIdx) => {
          const optsWithIds = this.quizShuffleService.assignOptionIds(q.options ?? [], qIdx);
          const alignedAnswers = this.quizShuffleService.alignAnswersWithOptions(q.answer, optsWithIds);

          const correctIds = new Set(alignedAnswers.map(a => Number(a.optionId)));
          const finalOpts = optsWithIds.map(o => ({
            ...o,
            correct: correctIds.has(Number(o.optionId))
          }));

          return {
            ...q,
            options: finalOpts.map(o => ({ ...o })),
            answer: alignedAnswers.map(a => ({ ...a }))
          } as QuizQuestion;
        });

        this.canonicalQuestionsByQuiz.set(quizId, JSON.parse(JSON.stringify(normalized)));
        setInternalQuestions(JSON.parse(JSON.stringify(normalized)));

        if (this.shouldShuffle()) {
          this.quizShuffleService.prepareShuffle(quizId, normalized);
          const shuffled = this.quizShuffleService.buildShuffledQuestions(quizId, normalized);

          this.shuffledQuestions = shuffled;
          try {
            localStorage.setItem(SK_SHUFFLED_QUESTIONS, JSON.stringify(shuffled));
            localStorage.setItem(SK_SHUFFLED_QUESTIONS_QUIZ_ID, quizId);
          } catch { }

          questionsSig.set(shuffled);
          return shuffled;
        }

        questionsSig.set(normalized);
        return normalized;
      } catch (e) {
        console.error('QuizDataLoaderService.getShuffledQuestions quiz data fetch failed:', e);
        return [];
      } finally {
        this.fetchPromise = null;
      }
    })();

    return this.fetchPromise;
  }

  clearFetchPromise(): void {
    this.fetchPromise = null;
  }

  shouldShuffle(): boolean {
    return this.shuffleEnabledSig();
  }

  isShuffleEnabled(): boolean {
    return this.shuffleEnabledSig();
  }

  setCheckedShuffle(isChecked: boolean): void {
    this.shuffleEnabledSig.set(isChecked);
    try {
      localStorage.setItem('checkedShuffle', String(isChecked));
      localStorage.removeItem(SK_SHUFFLED_QUESTIONS);
      localStorage.removeItem(SK_SHUFFLED_QUESTIONS_QUIZ_ID);
    } catch { }

    this.quizShuffleService.clearAll();
    this.shuffledQuestions = [];
    this.questionsQuizId = null;
  }

  getShuffledQuestions(
    quizId: string,
    questionsSig: WritableSignal<QuizQuestion[]>,
    fetchQuizQuestionsFn: (id: string) => Promise<QuizQuestion[]>
  ): Observable<QuizQuestion[]> {
    if (this.shuffledQuestions && this.shuffledQuestions.length > 0) {
      return of(this.shuffledQuestions);
    }

    const cachedQuestions = questionsSig();
    if (Array.isArray(cachedQuestions) && cachedQuestions.length > 0) {
      const shuffled = this.shuffleQuestions(cachedQuestions);
      return of(shuffled);
    }

    if (!quizId) return of([]);

    return from(fetchQuizQuestionsFn(quizId)).pipe(
      map(questions => this.shuffleQuestions(questions))
    );
  }

  shuffleQuestions(questions: QuizQuestion[]): QuizQuestion[] {
    if (this.shouldShuffle() && questions && questions.length > 0) {
      return Utils.shuffleArray([...questions]);
    }
    return questions;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Canonical Questions
  // ═══════════════════════════════════════════════════════════════════════

  setCanonicalQuestions(
    quizId: string,
    questions: QuizQuestion[] | null | undefined,
    cloneQuestionForSession: (q: QuizQuestion, idx?: number) => QuizQuestion | null,
    normalizeQuestionText: (text: string | null | undefined) => string
  ): void {
    if (!quizId) return;

    if (!Array.isArray(questions) || questions.length === 0) {
      this.canonicalQuestionsByQuiz.delete(quizId);
      this.canonicalQuestionIndexByText.delete(quizId);
      return;
    }

    const sanitized = questions
      .map((question, idx) => cloneQuestionForSession(question, idx))
      .filter((question): question is QuizQuestion => !!question)
      .map((question) => ({
        ...question,
        options: Array.isArray(question.options)
          ? question.options.map((option) => ({ ...option })) : []
      }));

    if (sanitized.length === 0) {
      this.canonicalQuestionsByQuiz.delete(quizId);
      this.canonicalQuestionIndexByText.delete(quizId);
      return;
    }

    const textIndex = new Map<string, number>();
    let idx = 0;
    for (const question of sanitized) {
      const key = normalizeQuestionText(question?.questionText);
      if (!key) { idx++; continue; }
      if (!textIndex.has(key)) {
        textIndex.set(key, idx);
      }
      idx++;
    }

    this.canonicalQuestionsByQuiz.set(quizId, sanitized);
    this.canonicalQuestionIndexByText.set(quizId, textIndex);
  }

  getCanonicalQuestions(quizId: string): QuizQuestion[] {
    if (!quizId) return [];
    return this.canonicalQuestionsByQuiz.get(quizId) || [];
  }

  getCanonicalQuestionsByQuiz(): Map<string, QuizQuestion[]> {
    return this.canonicalQuestionsByQuiz;
  }

  getCanonicalQuestionIndexByText(): Map<string, Map<string, number>> {
    return this.canonicalQuestionIndexByText;
  }

  hasCachedQuestion(quizId: string, questionIndex: number): boolean {
    const quiz = this.currentQuizSig();
    if (!quiz || quiz.quizId !== quizId) return false;

    const questions = quiz.questions ?? [];
    if (!Array.isArray(questions) || questionIndex < 0 || questionIndex >= questions.length) {
      return false;
    }

    const q = questions[questionIndex];
    if (!q) return false;

    const hasOptions = Array.isArray(q.options) && q.options.length > 0;
    const hasText = typeof q.questionText === 'string' && q.questionText.trim().length > 0;

    return hasOptions && hasText;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════

  getPristineQuestion(
    quizId: string,
    index: number,
    cloneQuestionForSession: (q: QuizQuestion, idx?: number) => QuizQuestion | null
  ): QuizQuestion | null {
    if (!quizId) return null;

    const canonical = this.canonicalQuestionsByQuiz.get(quizId);
    if (!canonical || canonical.length <= index) return null;

    // Return a clone to be safe
    return cloneQuestionForSession(canonical[index], index);
  }

  normalizeQuestionText(value: string | null | undefined): string {
    return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  isValidQuestionStructure(question: any): boolean {
    return (
      question &&
      typeof question === 'object' &&
      typeof question.questionText === 'string' &&
      Array.isArray(question.options) &&
      question.options.length > 0 &&
      question.options.every((opt: any) => opt && typeof opt.text === 'string')
    );
  }

  private isQuiz(item: any): item is Quiz {
    return typeof item === 'object' && 'quizId' in item;
  }
}
