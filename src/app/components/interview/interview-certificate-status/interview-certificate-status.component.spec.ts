import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import {
  CertificateEligibility,
  InterviewCertificateRecord
} from '../../../shared/models/interview-certificate.model';
import { InterviewCertificateService } from '../../../shared/services/features/interview/interview-certificate.service';
import { InterviewCertificateStatusComponent } from './interview-certificate-status.component';

const unlockedSig = signal(false);
const eligibilitySig = signal<CertificateEligibility>(eligibility());
const unlock = jest.fn<InterviewCertificateRecord | null, []>(() => {
  unlockedSig.set(true);
  return { version: 1, unlocked: true, unlockedAt: '2026-07-24T00:00:00.000Z', certificateId: 'AQ-2026-000001' };
});

function eligibility(over: Partial<CertificateEligibility> = {}): CertificateEligibility {
  const met = over.eligible ?? false;
  return {
    eligible: met,
    requirements: [
      { key: 'achievements', met, label: 'All achievements unlocked', detail: '6 / 6 earned' },
      { key: 'readiness', met, label: 'Interview Readiness: highest tier', detail: 'Interview Ready' },
      { key: 'score', met, label: 'Strong interview score', detail: 'Best 95% (need 90%)' }
    ],
    achievementsEarned: 6, achievementsTotal: 6,
    readinessBand: 'interview-ready', readinessReady: true, bestScore: 95,
    ...over
  };
}

const stub = { unlocked: unlockedSig, eligibility: eligibilitySig, unlock } as unknown as InterviewCertificateService;

function render(): ComponentFixture<InterviewCertificateStatusComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InterviewCertificateStatusComponent],
    providers: [provideRouter([]), { provide: InterviewCertificateService, useValue: stub }]
  });
  const fixture = TestBed.createComponent(InterviewCertificateStatusComponent);
  fixture.detectChanges();
  return fixture;
}

describe('InterviewCertificateStatusComponent', () => {
  beforeEach(() => {
    unlockedSig.set(false);
    eligibilitySig.set(eligibility());
    unlock.mockClear();
  });

  it('shows the progress checklist (with reasons) when not yet eligible', () => {
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-status--progress')).not.toBeNull();
    expect(el.querySelectorAll('.ic-check')).toHaveLength(3);
    expect(el.textContent).toContain('All achievements unlocked');
    expect(el.textContent).toContain('Best 95% (need 90%)');
    expect(unlock).not.toHaveBeenCalled();
    expect(el.querySelector('.ic-dialog')).toBeNull();
  });

  it('unlocks ONCE and celebrates when eligible and not yet unlocked', () => {
    eligibilitySig.set(eligibility({ eligible: true }));
    const el = render().nativeElement as HTMLElement;
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(el.querySelector('.ic-dialog')).not.toBeNull();
    expect(el.querySelector('.ic-dialog__title')?.textContent).toContain('Congratulations');
  });

  it('does not unlock again when already unlocked (no dialog, shows the CTA)', () => {
    unlockedSig.set(true);
    const el = render().nativeElement as HTMLElement;
    expect(unlock).not.toHaveBeenCalled();
    expect(el.querySelector('.ic-dialog')).toBeNull();
    expect(el.querySelector('.ic-status--unlocked')).not.toBeNull();
    const cta = el.querySelector('.ic-status__cta') as HTMLAnchorElement;
    expect(cta?.getAttribute('href')).toContain('/interview/certificate');
  });

  it('dismiss() closes the celebration dialog', () => {
    eligibilitySig.set(eligibility({ eligible: true }));
    const fixture = render();
    expect((fixture.nativeElement as HTMLElement).querySelector('.ic-dialog')).not.toBeNull();
    fixture.componentInstance.dismiss();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.ic-dialog')).toBeNull();
  });
});
