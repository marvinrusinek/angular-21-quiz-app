import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  ViewEncapsulation
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';

import {
  CERTIFICATE_MIN_SCORE,
  CERTIFICATE_REQUIRED_BAND,
  CERTIFICATE_TITLE
} from '../../../shared/models/interview-certificate.model';
import {
  InterviewCertificateService,
  readinessBandLabel
} from '../../../shared/services/features/interview/interview-certificate.service';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';

/**
 * The Angular Interview Master Certificate page. READ-ONLY and presentation-only:
 * all eligibility / unlock / persistence logic lives in InterviewCertificateService.
 * Reachable at /interview/certificate. If the certificate hasn't been unlocked
 * (e.g. a direct visit) it shows a friendly locked state rather than a broken
 * page. Print-friendly: only the certificate itself prints (see the SCSS
 * `@media print`), so it doubles as a portfolio artifact.
 */
@Component({
  selector: 'codelab-interview-certificate',
  standalone: true,
  imports: [CommonModule, RouterLink, ThemeToggleComponent],
  templateUrl: './interview-certificate.component.html',
  styleUrls: ['./interview-certificate.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewCertificateComponent {
  private readonly certService = inject(InterviewCertificateService);

  readonly title = CERTIFICATE_TITLE;
  readonly minScore = CERTIFICATE_MIN_SCORE;
  readonly requiredTierLabel = readinessBandLabel(CERTIFICATE_REQUIRED_BAND);
  readonly record = this.certService.record;
  readonly unlocked = this.certService.unlocked;
  private readonly eligibility = this.certService.eligibility;

  // Live readiness tier — falls back to the required tier if history has since
  // aged out (the certificate stays valid; the tier was met when it was issued).
  readonly tierLabel = computed(() =>
    readinessBandLabel(this.eligibility().readinessBand ?? CERTIFICATE_REQUIRED_BAND)
  );

  // Best interview score (live). Null only if history was cleared post-issue.
  readonly score = computed(() => this.eligibility().bestScore);

  readonly recipientName = computed(() => this.record()?.recipientName ?? '');

  readonly issuedDate = computed(() => {
    const iso = this.record()?.unlockedAt;
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return iso;
    }
  });

  // ── recipient name editing (optional; persisted via the service) ──
  readonly editingName = signal(false);
  readonly nameDraft = signal('');

  startEditName(): void {
    this.nameDraft.set(this.recipientName());
    this.editingName.set(true);
  }

  onNameInput(value: string): void {
    this.nameDraft.set(value);
  }

  saveName(): void {
    this.certService.setRecipientName(this.nameDraft());
    this.editingName.set(false);
  }

  cancelEditName(): void {
    this.editingName.set(false);
  }

  print(): void {
    window.print();
  }
}
