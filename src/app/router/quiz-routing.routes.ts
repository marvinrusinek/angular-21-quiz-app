import { Routes } from '@angular/router';

import { QuizResolverService } from '../shared/services/flow/quiz-resolver.service';

import { IntroductionComponent } from
    '../containers/introduction/introduction.component';
import { QuizComponent } from '../containers/quiz/quiz.component';
import { QuizSelectionComponent } from
    '../containers/quiz-selection/quiz-selection.component';
import { ResultsComponent } from '../containers/results/results.component';
import { BuildYourInterviewComponent } from
    '../containers/interview/build-your-interview/build-your-interview.component';
import { InterviewSessionComponent } from
    '../containers/interview/interview-session/interview-session.component';
import { InterviewSessionHandoffComponent } from
    '../containers/interview/interview-session-handoff/interview-session-handoff.component';
import { InterviewResultsComponent } from
    '../containers/interview/interview-results/interview-results.component';
import { InterviewHistoryComponent } from
    '../containers/interview/interview-history/interview-history.component';
import { InterviewHistoryDetailComponent } from
    '../containers/interview/interview-history-detail/interview-history-detail.component';
import { InterviewCertificateComponent } from
    '../containers/interview/interview-certificate/interview-certificate.component';

import { QuizGuard } from './guards/quiz-guard';
import { InterviewSessionGuard } from './guards/interview-session-guard';
import { PracticeSessionGuard } from './guards/practice-session-guard';
import { PracticeResultGuard } from './guards/practice-result-guard';
import { WeakAreasPracticeComponent } from '../containers/practice/weak-areas-practice/weak-areas-practice.component';
import { WeakAreasPracticeResultsComponent } from '../containers/practice/weak-areas-practice-results/weak-areas-practice-results.component';
import { InterviewResultGuard } from './guards/interview-result-guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'quiz',
    pathMatch: 'full'
  },
  {
    path: 'quiz',
    component: QuizSelectionComponent
  },
  {
    path: 'quiz/intro/:quizId',
    component: IntroductionComponent
  },
  {
    path: 'quiz/question/:quizId/:questionIndex',
    component: QuizComponent,
    canActivate: [QuizGuard],
    resolve: { quizData: QuizResolverService },
    runGuardsAndResolvers: 'always'
  },
  {
    path: 'quiz/results/:quizId',
    component: ResultsComponent
  },

  // Interview Mode — Build Your Interview configuration page.
  {
    path: 'interview',
    component: BuildYourInterviewComponent
  },
  // URL-less Interview session (no question index in the URL). Guarded: requires
  // an active generated assessment; direct/stale access redirects to the builder.
  {
    path: 'interview/session',
    component: InterviewSessionComponent,
    canActivate: [InterviewSessionGuard]
  },
  // Stage 9C handoff. The builder now creates the assessment on the backend and
  // navigates here with the (non-secret) session id; the bearer token stays in
  // sessionStorage. Stage 9D replaces this shell with the real backend-backed
  // session component and removes this comment.
  {
    path: 'interview/session/:sessionId',
    component: InterviewSessionHandoffComponent
  },
  // Interview Results ("Assessment Complete"). Guarded: requires a submitted
  // result; direct/stale access redirects to the builder.
  {
    path: 'interview/results',
    component: InterviewResultsComponent,
    canActivate: [InterviewResultGuard]
  },
  // Interview History — read-only record of past attempts. Deep-linkable (reads
  // the durable history store); no session/result required. `:id` reopens ONE
  // attempt's read-only summary. More specific path is listed first.
  {
    path: 'interview/history',
    component: InterviewHistoryComponent
  },
  {
    path: 'interview/history/:id',
    component: InterviewHistoryDetailComponent
  },
  // Angular Interview Master Certificate — the certificate view. Read-only and
  // deep-linkable; shows a friendly locked state until it has been unlocked.
  {
    path: 'interview/certificate',
    component: InterviewCertificateComponent
  },

  // Weak Areas Practice — untimed learning session generated from the user's
  // calculated weak topics. Guarded: the session is created by the Practice
  // action, never by navigating to the URL; direct/stale access redirects to
  // Quiz Selection. A refresh passes because the session rehydrates from
  // sessionStorage before the guard runs.
  {
    path: 'practice/weak-areas',
    component: WeakAreasPracticeComponent,
    canActivate: [PracticeSessionGuard]
  },
  // Practice Results. Guarded: requires a SUBMITTED session with a scored
  // result. The result is persisted with the session snapshot, so a refresh
  // re-renders the same score instead of recomputing it.
  {
    path: 'practice/results',
    component: WeakAreasPracticeResultsComponent,
    canActivate: [PracticeResultGuard]
  },

  // Backward compatibility redirects
  { path: 'select', redirectTo: 'quiz', pathMatch: 'full' },
  { path: 'intro/:quizId', redirectTo: 'quiz/intro/:quizId', pathMatch: 'full' },
  { path: 'question/:quizId/:questionIndex', redirectTo: 'quiz/question/:quizId/:questionIndex', pathMatch: 'full' },
  { path: 'results/:quizId', redirectTo: 'quiz/results/:quizId', pathMatch: 'full' }
];
