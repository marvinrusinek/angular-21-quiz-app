import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { CommonModule, NgOptimizedImage } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';

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
  // ── injects ─────────────────────────────────────────────────────
  private readonly quizDataService = inject(QuizDataService);
  private readonly quizService = inject(QuizService);

  // ── remaining variables ─────────────────────────────────────────
  readonly currentQuiz = computed(
    () => this.quizDataService.quizzesSig().find(
      (quiz) => quiz.quizId === this.quizService.quizId
    ) ?? null
  );
}
