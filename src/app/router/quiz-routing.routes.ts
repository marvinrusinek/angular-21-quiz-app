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

import { QuizGuard } from './guards/quiz-guard';
import { InterviewSessionGuard } from './guards/interview-session-guard';

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

  // Backward compatibility redirects
  { path: 'select', redirectTo: 'quiz', pathMatch: 'full' },
  { path: 'intro/:quizId', redirectTo: 'quiz/intro/:quizId', pathMatch: 'full' },
  { path: 'question/:quizId/:questionIndex', redirectTo: 'quiz/question/:quizId/:questionIndex', pathMatch: 'full' },
  { path: 'results/:quizId', redirectTo: 'quiz/results/:quizId', pathMatch: 'full' }
];
