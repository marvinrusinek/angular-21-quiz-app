import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';

/**
 * Which surface the dialog is documenting. The two modes support genuinely
 * different keyboard interactions, so the content differs — but the component,
 * template and styles are shared rather than duplicated.
 */
export type KeyboardShortcutsMode = 'quiz' | 'interview';

export interface KeyboardShortcutsDialogData {
  mode?: KeyboardShortcutsMode;
}

/**
 * Presentational dialog listing keyboard shortcuts. It holds no state and
 * injects no services beyond its dialog data — it closes via the
 * `mat-dialog-close` directive.
 *
 * Open it with MatDialog and pass `ariaLabelledBy`/`ariaDescribedBy` so screen
 * readers announce it correctly (see CodelabQuizHeaderComponent for the topic
 * quiz and InterviewSessionComponent for the assessment).
 *
 * MODE: defaults to 'quiz' when no data is supplied, so existing callers keep
 * working unchanged. Pass `data: { mode: 'interview' }` for Interview Mode,
 * which documents ONLY the interactions that actually work there.
 */
@Component({
  selector: 'codelab-keyboard-shortcuts-dialog',
  standalone: true,
  imports: [MatButtonModule, MatDialogModule, MatIconModule],
  templateUrl: './keyboard-shortcuts-dialog.component.html',
  styleUrls: ['./keyboard-shortcuts-dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class KeyboardShortcutsDialogComponent {
  private readonly data = inject<KeyboardShortcutsDialogData | null>(MAT_DIALOG_DATA, {
    optional: true
  });

  readonly mode: KeyboardShortcutsMode = this.data?.mode ?? 'quiz';
  readonly isInterview = this.mode === 'interview';
}
