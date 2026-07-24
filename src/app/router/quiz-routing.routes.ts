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

  // Backward compatibility redirects
  { path: 'select', redirectTo: 'quiz', pathMatch: 'full' },
  { path: 'intro/:quizId', redirectTo: 'quiz/intro/:quizId', pathMatch: 'full' },
  { path: 'question/:quizId/:questionIndex', redirectTo: 'quiz/question/:quizId/:questionIndex', pathMatch: 'full' },
  { path: 'results/:quizId', redirectTo: 'quiz/results/:quizId', pathMatch: 'full' }
];
