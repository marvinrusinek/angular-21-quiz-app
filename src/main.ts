import { bootstrapApplication } from '@angular/platform-browser';
import { HttpClient, provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideAnimations } from '@angular/platform-browser/animations';
import {
  inject, isDevMode, provideAppInitializer, provideZonelessChangeDetection
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { routes } from './app/router/quiz-routing.routes';
import { AppComponent } from './app/app.component';
import { installGlobalFetWatchdog } from './app/shared/utils/fet-watchdog';
import { setQuizDataCache } from './app/shared/quiz-data-cache';
import { Quiz } from './app/shared/models/Quiz.model';
import { QuizResource } from './app/shared/models/QuizResource.model';
import { provideServiceWorker } from '@angular/service-worker';

installGlobalFetWatchdog();

bootstrapApplication(AppComponent, {
  providers: [
    provideZonelessChangeDetection(),
    provideHttpClient(withFetch()),
    provideRouter(routes),
    provideAnimations(),
    // Fetch quiz dataset BEFORE app stabilizes. Populates the module-level
    // cache that QuizService.quizInitialState et al. read from synchronously
    // at construction time. The dataset is no longer bundled into main.js;
    // it lives in assets/quiz.json and ships with the static deploy.
    provideAppInitializer(async () => {
      const http = inject(HttpClient);
      try {
        const data = await firstValueFrom(
          http.get<{ quizzes: Quiz[]; resources: QuizResource[] }>('assets/quiz.json')
        );
        setQuizDataCache(data?.quizzes ?? [], data?.resources ?? []);
      } catch (err) {
        console.error('[bootstrap] failed to load assets/quiz.json', err);
        setQuizDataCache([], []);
      }
    }),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
}).catch((err) => console.error(err));
