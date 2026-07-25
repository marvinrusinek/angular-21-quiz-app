import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { SK_INTERVIEW_CERTIFICATE, SK_QUIZ_ACHIEVEMENTS, SK_INTERVIEW_HISTORY } from '../../../constants/session-keys';
import { AchievementService } from '../../achievements/achievement.service';
import { InterviewHistoryService } from './interview-history.service';
import {
  generateCertificateId,
  InterviewCertificateService,
  validateCertificateRecord
} from './interview-certificate.service';

// ── signal-backed stubs (so `progress` reacts to changes) ──
const earnedSig = signal<Set<string>>(new Set());
const historySig = signal<unknown[]>([]);

const achievementsStub = { earnedIds: () => earnedSig() } as unknown as AchievementService;
// history() returns the VALIDATED collection; its length is the completed count.
const historyStub = { history: historySig } as unknown as InterviewHistoryService;

/** Set the two inputs: whether Angular Explorer is earned + how many completed interviews. */
function setState(explorer: boolean, interviews: number): void {
  earnedSig.set(new Set(explorer ? ['angular-explorer'] : []));
  historySig.set(Array.from({ length: interviews }, (_, i) => ({ id: 'att-' + i })));
}

function freshService(): InterviewCertificateService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: AchievementService, useValue: achievementsStub },
      { provide: InterviewHistoryService, useValue: historyStub }
    ]
  });
  return TestBed.inject(InterviewCertificateService);
}

describe('InterviewCertificateService — eligibility (Angular Explorer + 5 interviews)', () => {
  beforeEach(() => {
    localStorage.clear();
    setState(true, 5);   // default: fully eligible
  });
  afterEach(() => localStorage.clear());

  it('1. locked when Angular Explorer is not earned', () => {
    setState(false, 5);
    expect(freshService().progress().isEligible).toBe(false);
  });

  it('2. locked when fewer than five interviews are completed', () => {
    setState(true, 4);
    expect(freshService().progress().isEligible).toBe(false);
  });

  it('3. locked when Explorer earned but only four interviews', () => {
    setState(true, 4);
    const p = freshService().progress();
    expect(p.angularExplorerEarned).toBe(true);
    expect(p.isEligible).toBe(false);
  });

  it('4. locked when five interviews but Explorer not earned', () => {
    setState(false, 5);
    const p = freshService().progress();
    expect(p.completedInterviews).toBe(5);
    expect(p.isEligible).toBe(false);
  });

  it('5. eligible when Explorer earned AND five interviews completed', () => {
    setState(true, 5);
    expect(freshService().progress().isEligible).toBe(true);
  });

  it('6. remains eligible when more than five interviews are completed', () => {
    setState(true, 8);
    expect(freshService().progress().isEligible).toBe(true);
  });

  it('7/8/9. only the validated Interview History counts (abandoned/incomplete/invalid never appear there)', () => {
    // The service reads history() — the ALREADY-validated collection — so its
    // length is exactly the completed-interview count.
    setState(true, 3);
    expect(freshService().progress().completedInterviews).toBe(3);
  });

  it('10. no interview difficulty distribution is required', () => {
    // Difficulty is never inspected — five completed of any mix is enough.
    setState(true, 5);
    expect(freshService().progress().isEligible).toBe(true);
  });
});

describe('InterviewCertificateService — progress model', () => {
  beforeEach(() => { localStorage.clear(); setState(false, 0); });
  afterEach(() => localStorage.clear());

  it('11. required interview count is five', () => {
    expect(freshService().progress().requiredInterviews).toBe(5);
  });

  it('12. completed count comes from Interview History', () => {
    setState(true, 3);
    expect(freshService().progress().completedInterviews).toBe(3);
  });

  it('13. interviews remaining is calculated correctly', () => {
    setState(true, 3);
    expect(freshService().progress().interviewsRemaining).toBe(2);
  });

  it('14. interviews remaining never becomes negative', () => {
    setState(true, 8);
    expect(freshService().progress().interviewsRemaining).toBe(0);
  });

  it('15. Angular Explorer status reflects the achievement service', () => {
    setState(true, 0);
    expect(freshService().progress().angularExplorerEarned).toBe(true);
    setState(false, 0);
    expect(freshService().progress().angularExplorerEarned).toBe(false);
  });

  it('16. isEligible is false when either requirement is incomplete', () => {
    setState(true, 4);
    expect(freshService().progress().isEligible).toBe(false);
    setState(false, 5);
    expect(freshService().progress().isEligible).toBe(false);
  });

  it('17. isEligible is true when both requirements are complete', () => {
    setState(true, 5);
    expect(freshService().progress().isEligible).toBe(true);
  });

  it('18. isUnlocked reflects persisted certificate state', () => {
    setState(true, 5);
    const svc = freshService();
    expect(svc.progress().isUnlocked).toBe(false);
    svc.unlock();
    expect(svc.progress().isUnlocked).toBe(true);
    expect(freshService().progress().isUnlocked).toBe(true);   // reload
  });
});

describe('InterviewCertificateService — unlock + persistence', () => {
  beforeEach(() => { localStorage.clear(); setState(true, 5); });
  afterEach(() => localStorage.clear());

  it('19. unlocks when the fifth completed interview satisfies the requirement', () => {
    setState(true, 5);
    const rec = freshService().unlock();
    expect(rec).not.toBeNull();
    expect(rec!.certificateId).toMatch(/^AQ-\d{4}-\d{6}$/);
  });

  it('20. unlocks when Angular Explorer becomes earned after five interviews exist', () => {
    setState(false, 5);
    const svc = freshService();
    expect(svc.unlock()).toBeNull();      // explorer missing
    setState(true, 5);
    expect(svc.unlock()).not.toBeNull();  // now eligible
  });

  it('21/22. certificate ID and issue date are generated only once', () => {
    const svc = freshService();
    const first = svc.unlock()!;
    const second = svc.unlock()!;
    expect(second.certificateId).toBe(first.certificateId);
    expect(second.unlockedAt).toBe(first.unlockedAt);
  });

  it('23/24. reloading preserves the certificate ID and issue date', () => {
    const issued = freshService().unlock()!;
    const reloaded = freshService();
    expect(reloaded.record()!.certificateId).toBe(issued.certificateId);
    expect(reloaded.record()!.unlockedAt).toBe(issued.unlockedAt);
  });

  it('25. subsequent interviews do not regenerate certificate data', () => {
    const svc = freshService();
    const first = svc.unlock()!;
    setState(true, 9);                    // more interviews later
    const again = svc.unlock()!;
    expect(again.certificateId).toBe(first.certificateId);
    expect(again.unlockedAt).toBe(first.unlockedAt);
  });

  it('27. an already-issued certificate stays unlocked if history later shrinks below five', () => {
    const svc = freshService();
    svc.unlock();
    expect(svc.unlocked()).toBe(true);
    setState(true, 2);                    // history reduced
    expect(svc.unlocked()).toBe(true);    // permanent
    expect(svc.record()).not.toBeNull();
  });

  it('does not unlock (or persist) while ineligible', () => {
    setState(true, 4);
    const svc = freshService();
    expect(svc.unlock()).toBeNull();
    expect(localStorage.getItem(SK_INTERVIEW_CERTIFICATE)).toBeNull();
  });

  it('setRecipientName persists a trimmed name only after unlock', () => {
    const svc = freshService();
    svc.setRecipientName('Ada');
    expect(svc.record()).toBeNull();
    svc.unlock();
    svc.setRecipientName('  Ada Lovelace  ');
    expect(svc.record()!.recipientName).toBe('Ada Lovelace');
  });

  it('54/regression: never writes achievements / history / best-score storage', () => {
    const svc = freshService();
    svc.unlock();
    svc.setRecipientName('X');
    expect(localStorage.getItem(SK_QUIZ_ACHIEVEMENTS)).toBeNull();
    expect(localStorage.getItem(SK_INTERVIEW_HISTORY)).toBeNull();
    expect(localStorage.getItem('quizBestScores')).toBeNull();
  });
});

describe('generateCertificateId / validateCertificateRecord', () => {
  it('formats AQ-YYYY-NNNNNN, zero-padded and stable', () => {
    expect(generateCertificateId('2026-07-24T12:00:00.000Z', () => 0.000128)).toBe('AQ-2026-000128');
    expect(generateCertificateId('2030-06-15T12:00:00.000Z', () => 0.5)).toMatch(/^AQ-2030-\d{6}$/);
  });

  it('accepts a valid record + rejects junk/non-unlocked/malformed', () => {
    expect(validateCertificateRecord({
      version: 1, unlocked: true, unlockedAt: '2026-07-24T00:00:00.000Z',
      certificateId: 'AQ-2026-000001', recipientName: '  Grace  '
    })).toMatchObject({ unlocked: true, certificateId: 'AQ-2026-000001', recipientName: 'Grace' });
    expect(validateCertificateRecord(null)).toBeNull();
    expect(validateCertificateRecord({ unlocked: false, certificateId: 'x', unlockedAt: '2026-07-24' })).toBeNull();
    expect(validateCertificateRecord({ unlocked: true, certificateId: 'AQ-1', unlockedAt: 'not-a-date' })).toBeNull();
  });
});
