import { computed, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import {
  CertificateEligibility,
  InterviewCertificateRecord
} from '../../../shared/models/interview-certificate.model';
import { InterviewCertificateService } from '../../../shared/services/features/interview/interview-certificate.service';
import { InterviewCertificateComponent } from './interview-certificate.component';

const recordSig = signal<InterviewCertificateRecord | null>(null);
const eligibilitySig = signal<CertificateEligibility>(eligibility());
const setRecipientName = jest.fn();

function eligibility(over: Partial<CertificateEligibility> = {}): CertificateEligibility {
  return {
    eligible: true,
    requirements: [],
    achievementsEarned: 6,
    achievementsTotal: 6,
    readinessBand: 'interview-ready',
    readinessReady: true,
    bestScore: 95,
    ...over
  };
}

const serviceStub = {
  record: recordSig,
  unlocked: computed(() => recordSig()?.unlocked === true),
  eligibility: eligibilitySig,
  setRecipientName
} as unknown as InterviewCertificateService;

function issued(over: Partial<InterviewCertificateRecord> = {}): InterviewCertificateRecord {
  return {
    version: 1,
    unlocked: true,
    unlockedAt: '2026-07-24T15:00:00.000Z',
    certificateId: 'AQ-2026-000128',
    ...over
  };
}

function render(): ComponentFixture<InterviewCertificateComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InterviewCertificateComponent],
    providers: [provideRouter([]), { provide: InterviewCertificateService, useValue: serviceStub }]
  });
  const fixture = TestBed.createComponent(InterviewCertificateComponent);
  fixture.detectChanges();
  return fixture;
}

describe('InterviewCertificateComponent', () => {
  beforeEach(() => {
    recordSig.set(null);
    eligibilitySig.set(eligibility());
    setRecipientName.mockClear();
  });

  it('shows a friendly locked state (no certificate) before it is unlocked', () => {
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-locked')).not.toBeNull();
    expect(el.querySelector('.ic-locked__title')?.textContent).toContain('not yet unlocked');
    expect(el.querySelector('.ic-cert')).toBeNull();
  });

  it('renders the certificate with title, id, tier, score and date once unlocked', () => {
    recordSig.set(issued());
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-locked')).toBeNull();
    expect(el.querySelector('.ic-cert__title')?.textContent).toContain('Angular Interview Master');
    expect(el.querySelector('.ic-cert__id')?.textContent).toContain('AQ-2026-000128');
    // Facts: tier label + score + a formatted date.
    const facts = el.querySelector('.ic-cert__facts')?.textContent ?? '';
    expect(facts).toContain('Interview Ready');
    expect(facts).toContain('95%');
    expect(facts).toMatch(/2026/);
    // One semantic h1 for the award title.
    expect(el.querySelectorAll('h1#ic-title')).toHaveLength(1);
  });

  it('shows a placeholder name until one is entered, then the entered name', () => {
    recordSig.set(issued());
    let el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-cert__name')?.textContent).toContain('Angular Developer');
    expect(el.querySelector('.ic-cert__name--placeholder')).not.toBeNull();

    recordSig.set(issued({ recipientName: 'Ada Lovelace' }));
    el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ic-cert__name')?.textContent).toContain('Ada Lovelace');
    expect(el.querySelector('.ic-cert__name--placeholder')).toBeNull();
  });

  it('edits the recipient name through the service', () => {
    recordSig.set(issued());
    const fixture = render();
    const comp = fixture.componentInstance;
    comp.startEditName();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.ic-name-input')).not.toBeNull();
    comp.onNameInput('Grace Hopper');
    comp.saveName();
    expect(setRecipientName).toHaveBeenCalledWith('Grace Hopper');
    expect(comp.editingName()).toBe(false);
  });

  it('print() triggers the browser print dialog', () => {
    recordSig.set(issued());
    const spy = jest.spyOn(window, 'print').mockImplementation(() => {});
    render().componentInstance.print();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('falls back to the required tier label if history aged out post-issue', () => {
    recordSig.set(issued());
    eligibilitySig.set(eligibility({ readinessBand: null, bestScore: null }));
    const el = render().nativeElement as HTMLElement;
    const facts = el.querySelector('.ic-cert__facts')?.textContent ?? '';
    expect(facts).toContain('Interview Ready');   // required tier fallback
    expect(facts).toContain('—');                 // score placeholder
  });
});
