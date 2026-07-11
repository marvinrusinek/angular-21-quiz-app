import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { KeyboardShortcutsDialogComponent } from '../../../components/dialogs/keyboard-shortcuts-dialog/keyboard-shortcuts-dialog.component';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';

import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { QuizService } from '../../../shared/services/data/quiz.service';

@Component({
  selector: 'codelab-quiz-header',
  standalone: true,
  imports: [
    NgOptimizedImage,
    RouterModule,
    MatCardModule,
    MatIconModule,
    MatTooltipModule,
    ThemeToggleComponent,
  ],
  templateUrl: './quiz-header.component.html',
  styleUrls: ['./quiz-header.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CodelabQuizHeaderComponent {
  // ── injects ─────────────────────────────────────────────────────
  private readonly quizDataService = inject(QuizDataService);
  private readonly quizService = inject(QuizService);
  private readonly dialog = inject(MatDialog);

  // ── remaining variables ─────────────────────────────────────────
  readonly currentQuiz = computed(
    () =>
      this.quizDataService.quizzesSig().find((quiz) => quiz.quizId === this.quizService.quizId) ??
      null
  );

  // Open the presentational keyboard-shortcuts dialog. ariaLabelledBy /
  // ariaDescribedBy point at the ids in the dialog template; width + maxWidth
  // keep it responsive on mobile.
  openKeyboardShortcuts(): void {
    this.dialog.open(KeyboardShortcutsDialogComponent, {
      panelClass: 'keyboard-shortcuts-dialog',
      width: '90vw',
      maxWidth: '460px',
      autoFocus: 'dialog',
      restoreFocus: true,
      ariaLabelledBy: 'ksd-title',
      ariaDescribedBy: 'ksd-desc',
    });
  }
}
