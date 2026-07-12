import {
  bootstrapApplication,
  provideClientHydration,
  withEventReplay
} from '@angular/platform-browser';
import { HttpClient, provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideAnimations } from '@angular/platform-browser/animations';
import {
  ErrorHandler, inject, isDevMode, provideAppInitializer, provideZonelessChangeDetection
} from '@angular/core';
import { provideServiceWorker } from '@angular/service-worker';
import { firstValueFrom } from 'rxjs';

import { routes } from './app/router/quiz-routing.routes';
import { AppComponent } from './app/app.component';
import { AnswerComponent } from './app/components/question/answer/answer-component/answer.component';
import { ANSWER_COMPONENT } from './app/shared/tokens/answer-component.token';
import { PwaUpdateService } from './app/shared/services/pwa-update.service';
import { GlobalErrorHandler, installGlobalErrorLogging } from './app/shared/utils/error-logging';
import { setQuizDataCache } from './app/shared/quiz-data-cache';
import { Quiz } from './app/shared/models/Quiz.model';
import { QuizResource } from './app/shared/models/QuizResource.model';

installGlobalErrorLogging();

bootstrapApplication(AppComponent, {
  providers: [
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    provideZonelessChangeDetection(),
    // Provide AnswerComponent eagerly (imported here at the bootstrap entry,
    // outside the cyclic graph) so DynamicComponentService creates it without a
    // lazy import() — no separate chunk to fetch (fixes StackBlitz cold-load
    // "Failed to fetch dynamically imported module"), no circular dependency.
    { provide: ANSWER_COMPONENT, useValue: AnswerComponent },
    provideClientHydration(withEventReplay()),
    provideHttpClient(withFetch()),
    provideRouter(routes),
    provideAnimations(),
    // Fetch quiz dataset BEFORE app stabilizes. Populates the module-level
    // cache that QuizService.quizInitialState et al. read from synchronously
    // at construction time. The dataset is no longer bundled into main.js;
    // it lives in assets/data/quiz.json and ships with the static deploy.
    provideAppInitializer(async () => {
      const http = inject(HttpClient);
      try {
        const data = await firstValueFrom(
          http.get<{ quizzes: Quiz[]; resources: QuizResource[] }>('assets/data/quiz.json')
        );
        setQuizDataCache(data?.quizzes ?? [], data?.resources ?? []);
      } catch (err: any) {
        console.error('[bootstrap] failed to load assets/data/quiz.json', err);
        setQuizDataCache([], []);
      }
    }),
    // Prompt deployed users to reload onto a freshly-deployed bundle.
    provideAppInitializer(() => inject(PwaUpdateService).init()),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000'
    })
  ]
})
  .catch((err: any) => console.error(err));