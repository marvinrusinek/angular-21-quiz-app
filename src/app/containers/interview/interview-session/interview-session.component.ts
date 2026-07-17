import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnDestroy,
  OnInit,
  ViewEncapsulation
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { toObservable } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { of } from 'rxjs';

import { Quiz } from '../../../shared/models/Quiz.model';
import { QuestionPayload } from '../../../shared/models/QuestionPayload.model';

import { InterviewSessionService } from '../../../shared/services/features/interview/interview-session.service';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { SelectedOptionService } from '../../../shared/services/state/selectedoption.service';

import { CodelabQuizContentComponent } from '../../quiz/quiz-content/codelab-quiz-content.component';
import { QuizQuestionComponent } from '../../../components/question/quiz-question/quiz-question.component';
import { InterviewPaginatorComponent } from '../../../components/interview/interview-paginator/interview-paginator.component';

/**
 * Thin Interview session shell. It does NOT duplicate the quiz UI — it composes
 * the EXISTING renderers (`codelab-quiz-content` heading projection +
 * `codelab-quiz-question` options) by loading the generated assessment into
 * QuizService's question-state, then drives navigation through the shared index
 * signal WITHOUT changing the URL. Feedback is deferred for the whole session
 * (set on mount, reset on destroy) so no FET/correctness ever shows.
 *
 * Timer, submission, and sessionStorage resume land in the next milestone.
 */
@Component({
  selector: 'codelab-interview-session',
  standalone: true,
  imports: [
    CommonModule,
    CodelabQuizContentComponent,
    QuizQuestionComponent,
    InterviewPaginatorComponent
  ],
  templateUrl: './interview-session.component.html',
  styleUrls: ['./interview-session.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewSessionComponent implements OnInit, OnDestroy {
  private readonly session = inject(InterviewSessionService);
  private readonly quizService = inject(QuizService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly router = inject(Router);

  readonly assessment = this.session.assessment;
  readonly currentIndex = this.session.currentIndex;
  readonly total = this.session.total;
  readonly answeredIndices = this.session.answeredIndices;

  // The current question's payload for the shared renderers.
  readonly payload = computed<QuestionPayload | null>(() => {
    const q = this.assessment()?.questions?.[this.currentIndex()];
    return q ? { question: q, options: q.options ?? [], explanation: q.explanation ?? '' } : null;
  });

  private readonly questionText = computed(() => this.payload()?.question?.questionText ?? '');
  readonly questionToDisplay$ = toObservable(this.questionText);
  // Deferred feedback → the display mode is always 'question' (never explanation).
  readonly displayState$ = of({ mode: 'question' as const, answered: false });

  ngOnInit(): void {
    if (!this.session.hasActiveSession()) {
      this.router.navigate(['/interview']);
      return;
    }
    this.loadAssessmentIntoRenderer();
    this.session.activateDeferredFeedback();
  }

  ngOnDestroy(): void {
    // Leaving the interview (navigate away / abandon) tears the session down and
    // restores immediate feedback so Interview state can't leak into quizzes.
    this.session.clear();
  }

  // Paginator / prev / next → move the shared index (no router navigation).
  onNavigate(index: number): void {
    this.session.goTo(index);
    this.quizService.setCurrentQuestionIndex(this.session.currentIndex());
  }

  // Record the user's current selection for this question (paginator answered
  // state + later scoring). Reads the authoritative selection map by index.
  handleQuizQuestionEvent(_event: unknown): void {
    const i = this.session.currentIndex();
    const selected = (this.selectedOptionService as any).selectedOptionsMap?.get?.(i) ?? [];
    const ids = selected
      .map((o: any) => o?.optionId)
      .filter((x: any): x is number => typeof x === 'number');
    this.session.setAnswer(i, ids);
  }

  // Load the generated assessment as the "active quiz" so the shared renderers
  // display it. shuffledQuestions is cleared first so getQuestionsInDisplayOrder
  // returns our (already-shuffled) questions WITHOUT toggling the user's global,
  // persisted shuffle preference.
  private loadAssessmentIntoRenderer(): void {
    const assessment = this.assessment();
    if (!assessment) return;

    const synthetic: Quiz = {
      quizId: assessment.id,
      milestone: assessment.title,
      summary: '',
      image: '',
      questions: assessment.questions
    };

    this.quizService.shuffledQuestions = [];
    this.quizService.setCurrentQuiz(synthetic);
    this.quizService.setSelectedQuiz(synthetic);
    this.quizService.setCurrentQuestionIndex(this.currentIndex());
  }
}
