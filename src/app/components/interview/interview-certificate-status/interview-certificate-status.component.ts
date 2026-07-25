import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  OnInit,
  signal,
  viewChild,
  ViewEncapsulation
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';

import { InterviewCertificateService } from '../../../shared/services/features/interview/interview-certificate.service';
import {
  certificateAccessibleSummary,
  certificateNextAction
} from '../../../shared/utils/interview-certificate-progress';

/**
 * Certificate status on the Interview Results page. When both requirements
 * (Angular Explorer earned + the required number of completed interviews) are
 * met it unlocks the certificate ONCE (via the service) and shows a tasteful,
 * subtle celebration dialog; thereafter it shows a "View Certificate" card.
 * Until then it shows transparent progress so the user always sees exactly what
 * remains — never both states at once.
 *
 * All rules/persistence live in InterviewCertificateService — this component
 * only RENDERS its progress model + triggers the one-time unlock.
 */
@Component({
  selector: 'app-interview-certificate-status',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './interview-certificate-status.component.html',
  styleUrls: ['./interview-certificate-status.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewCertificateStatusComponent implements OnInit {
  readonly cert = inject(InterviewCertificateService);

  readonly unlocked = this.cert.unlocked;
  readonly progress = this.cert.progress;

  readonly nextAction = computed(() => certificateNextAction(this.progress()));
  readonly srSummary = computed(() => certificateAccessibleSummary(this.progress()));

  // True only for the session in which the certificate was just unlocked here.
  readonly showDialog = signal(false);

  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');

  constructor() {
    // Move focus to the celebration dialog when it appears (accessibility).
    effect(() => {
      if (this.showDialog()) this.dialog()?.nativeElement.focus();
    });
  }

  ngOnInit(): void {
    // Unlock exactly once, the first time the user reaches Results while eligible.
    if (!this.cert.unlocked() && this.cert.progress().isEligible) {
      const issued = this.cert.unlock();
      if (issued) this.showDialog.set(true);
    }
  }

  dismiss(): void {
    this.showDialog.set(false);
  }
}
