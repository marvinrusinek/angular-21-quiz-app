import { ChangeDetectionStrategy, Component } from '@angular/core';
import { CommonModule, NgOptimizedImage } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { Quiz } from '../../../shared/models/Quiz.model';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { QuizDataService } from '../../../shared/services/data/quizdata.service';

@Component({
  selector: 'codelab-quiz-header',
  standalone: true,
  imports: [CommonModule, NgOptimizedImage, MatCardModule, RouterModule],
  templateUrl: './quiz-header.component.html',
  styleUrls: ['./quiz-header.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CodelabQuizHeaderComponent {
  currentQuiz$: Observable<Quiz | null>;

  constructor(
    private quizService: QuizService,
    private quizDataService: QuizDataService
  ) {
    this.currentQuiz$ = this.quizDataService.quizzes$.pipe(
      map(
        (quizzes: Quiz[]) =>
          quizzes.find(
            (quiz: Quiz) => quiz.quizId === this.quizService.quizId
          ) ?? null
      )
    );
  }
}
