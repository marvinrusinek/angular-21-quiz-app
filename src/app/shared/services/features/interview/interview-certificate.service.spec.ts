import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { InterviewReadiness, InterviewReadinessBand } from '../../../models/interview-readiness.model';
import { SK_INTERVIEW_CERTIFICATE, SK_QUIZ_ACHIEVEMENTS, SK_INTERVIEW_HISTORY } from '../../../constants/session-keys';
import { AchievementService } from '../../achievements/achievement.service';
import { InterviewReadinessService } from './interview-readiness.service';
import { InterviewHistoryService } from './interview-history.service';
import {
  generateCertificateId,
  InterviewCertificateService,
  validateCertificateRecord
} from './interview-certificate.service';

// ── signal-backed stubs (so the eligibility computed reacts to changes) ──
const summarySig = signal<{ earned: number; total: number }>({ earned: 6, total: 6 });
const readinessSig = signal<InterviewReadiness | null>(null);
const trendsSig = signal<{ best: number | null }>({ best: 95 });

const achievementsStub = { summary: () => summarySig() } as unknown as AchievementService;
const readinessStub = { readiness: readinessSig } as unknown as InterviewReadinessService;
const historyStub = { trends: trendsSig } as unknown as InterviewHistoryService;

function readiness(band: InterviewReadinessBand, status: 'ready' | 'insufficient' = 'ready'): InterviewReadiness {
  return {
    status, score: band === 'interview-ready' ? 92 : 80, band,
    recentPerformance: 90, consistency: 85, rawConsistency: 85, topicCoverage: 80, topicStrength: 80,
    coverageAvailable: true, practicedTopicCount: 5, eligibleTopicCount: 5,
    strongestFactor: 'recent-performance', limitingFactor: 'topic-strength',
    explanation: '', recommendations: [], attemptsUsed: 5, totalAttempts: 5
  };
}

function freshService(): InterviewCertificateService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: AchievementService, useValue: achievementsStub },
      { provide: InterviewReadinessService, useValue: readinessStub },
      { provide: InterviewHistoryService, useValue: historyStub }
    ]
  });
  return TestBed.inject(InterviewCertificateService);
}

// Configure all three inputs to the fully-eligible state.
function makeEligible(): void {
  summarySig.set({ earned: 6, total: 6 });
  readinessSig.set(readiness('interview-ready'));
  trendsSig.set({ best: 95 });
}

describe('InterviewCertificateService — eligibility', () => {
  beforeEach(() => {
    localStorage.clear();
    makeEligible();
  });
  afterEach(() => localStorage.clear());

  it('is eligible only when achievements + readiness + score are ALL satisfied', () => {
    const svc = freshService();
    expect(svc.eligibility().eligible).toBe(true);
  });

  it('achievement requirement: not eligible until every achievement is earned', () => {
    summarySig.set({ earned: 5, total: 6 });
    const svc = freshService();
    const e = svc.eligibility();
    expect(e.eligible).toBe(false);
    expect(e.requirements.find((r) => r.key === 'achievements')!.met).toBe(false);
    // Becomes met when the last one is earned.
    summarySig.set({ earned: 6, total: 6 });
    expect(svc.eligibility().requirements.find((r) => r.key === 'achievements')!.met).toBe(true);
  });

  it('readiness requirement: needs the HIGHEST tier (strong is not enough)', () => {
    readinessSig.set(readiness('strong'));
    const svc = freshService();
    expect(svc.eligibility().requirements.find((r) => r.key === 'readiness')!.met).toBe(false);
    expect(svc.eligibility().eligible).toBe(false);
    readinessSig.set(readiness('interview-ready'));
    expect(svc.eligibility().requirements.find((r) => r.key === 'readiness')!.met).toBe(true);
  });

  it('readiness requirement: an insufficient (single-attempt) rating is not eligible', () => {
    readinessSig.set(readiness('interview-ready', 'insufficient'));
    const svc = freshService();
    expect(svc.eligibility().requirements.find((r) => r.key === 'readiness')!.met).toBe(false);
  });

  it('score requirement: best interview score must reach the threshold', () => {
    trendsSig.set({ best: 89 });
    const svc = freshService();
    expect(svc.eligibility().requirements.find((r) => r.key === 'score')!.met).toBe(false);
    trendsSig.set({ best: 90 });
    expect(svc.eligibility().requirements.find((r) => r.key === 'score')!.met).toBe(true);
  });

  it('exposes a three-item checklist with human details', () => {
    const svc = freshService();
    const keys = svc.eligibility().requirements.map((r) => r.key);
    expect(keys).toEqual(['achievements', 'readiness', 'score']);
    expect(svc.eligibility().requirements.every((r) => r.label.length > 0 && r.detail.length > 0)).toBe(true);
  });
});

describe('InterviewCertificateService — unlock + persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    makeEligible();
  });
  afterEach(() => localStorage.clear());

  it('unlock issues a certificate with a valid id and persists it', () => {
    const svc = freshService();
    const rec = svc.unlock();
    expect(rec).not.toBeNull();
    expect(rec!.unlocked).toBe(true);
    expect(rec!.certificateId).toMatch(/^AQ-\d{4}-\d{6}$/);
    expect(svc.unlocked()).toBe(true);
    // Persisted under its own key.
    expect(localStorage.getItem(SK_INTERVIEW_CERTIFICATE)).not.toBeNull();
  });

  it('unlocks only ONCE — a second call returns the same record (stable id + date)', () => {
    const svc = freshService();
    const first = svc.unlock();
    const second = svc.unlock();
    expect(second!.certificateId).toBe(first!.certificateId);
    expect(second!.unlockedAt).toBe(first!.unlockedAt);
  });

  it('does not unlock (or persist) while ineligible', () => {
    trendsSig.set({ best: 50 });
    const svc = freshService();
    expect(svc.unlock()).toBeNull();
    expect(svc.unlocked()).toBe(false);
    expect(localStorage.getItem(SK_INTERVIEW_CERTIFICATE)).toBeNull();
  });

  it('a fresh service loads the persisted, already-unlocked certificate', () => {
    const issued = freshService().unlock()!;
    const reloaded = freshService();
    expect(reloaded.unlocked()).toBe(true);
    expect(reloaded.record()!.certificateId).toBe(issued.certificateId);
  });

  it('setRecipientName persists a trimmed name only after unlock', () => {
    const svc = freshService();
    svc.setRecipientName('Ada Lovelace');
    expect(svc.record()).toBeNull();          // ignored before unlock
    svc.unlock();
    svc.setRecipientName('  Ada Lovelace  ');
    expect(svc.record()!.recipientName).toBe('Ada Lovelace');
    expect(freshService().record()!.recipientName).toBe('Ada Lovelace');   // persisted
  });

  it('does NOT touch achievements / history / best-score storage (regression)', () => {
    const svc = freshService();
    svc.unlock();
    svc.setRecipientName('X');
    expect(localStorage.getItem(SK_QUIZ_ACHIEVEMENTS)).toBeNull();
    expect(localStorage.getItem(SK_INTERVIEW_HISTORY)).toBeNull();
    expect(localStorage.getItem('quizBestScores')).toBeNull();
  });
});

describe('generateCertificateId', () => {
  it('formats AQ-YYYY-NNNNNN, zero-padded and stable for given inputs', () => {
    const id = generateCertificateId('2026-07-24T12:00:00.000Z', () => 0.000128);
    expect(id).toBe('AQ-2026-000128');
    // Same inputs → same id (deterministic rand).
    expect(generateCertificateId('2026-07-24T12:00:00.000Z', () => 0.000128)).toBe(id);
    // Uses the issue year (midday UTC → same local year in any realistic tz).
    expect(generateCertificateId('2030-06-15T12:00:00.000Z', () => 0.5)).toMatch(/^AQ-2030-\d{6}$/);
  });
});

describe('validateCertificateRecord', () => {
  it('accepts a valid unlocked record and sanitizes the name', () => {
    const ok = validateCertificateRecord({
      version: 1, unlocked: true, unlockedAt: '2026-07-24T00:00:00.000Z',
      certificateId: 'AQ-2026-000001', recipientName: '  Grace  '
    });
    expect(ok).toMatchObject({ unlocked: true, certificateId: 'AQ-2026-000001', recipientName: 'Grace' });
  });

  it('rejects junk, non-unlocked, and malformed records', () => {
    expect(validateCertificateRecord(null)).toBeNull();
    expect(validateCertificateRecord('nope')).toBeNull();
    expect(validateCertificateRecord({ unlocked: false, certificateId: 'x', unlockedAt: '2026-07-24' })).toBeNull();
    expect(validateCertificateRecord({ unlocked: true, certificateId: '', unlockedAt: '2026-07-24' })).toBeNull();
    expect(validateCertificateRecord({ unlocked: true, certificateId: 'AQ-1', unlockedAt: 'not-a-date' })).toBeNull();
  });
});
