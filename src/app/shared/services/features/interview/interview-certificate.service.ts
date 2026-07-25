import { computed, inject, Injectable, signal } from '@angular/core';

import {
  CERTIFICATE_ID_PREFIX,
  INTERVIEW_CERTIFICATE_VERSION,
  InterviewCertificateProgress,
  InterviewCertificateRecord,
  REQUIRED_CERTIFICATE_INTERVIEWS
} from '../../../models/interview-certificate.model';
import { AchievementId } from '../../../models/achievement.model';
import { InterviewReadinessBand } from '../../../models/interview-readiness.model';
import {
  SK_INTERVIEW_CERTIFICATE,
  SK_INTERVIEW_CERTIFICATE_QUAL
} from '../../../constants/session-keys';
import { readLocalJson, removeLocalKey, writeLocalJson } from '../../../utils/local-storage';

import { AchievementService } from '../../achievements/achievement.service';
import { InterviewHistoryService } from './interview-history.service';

// Display labels for readiness bands (kept local so this feature doesn't reach
// into the readiness component). Mirrors the readiness UI's labels.
const BAND_LABEL: Record<InterviewReadinessBand, string> = {
  'early-preparation': $localize`Early Preparation`,
  developing: $localize`Developing`,
  progressing: $localize`Progressing`,
  strong: $localize`Strong`,
  'interview-ready': $localize`Interview Ready`
};

/** Public helper so components render the same band label as the certificate. */
export function readinessBandLabel(band: InterviewReadinessBand | null): string {
  return band ? BAND_LABEL[band] : $localize`Not yet rated`;
}

/**
 * Owns the Angular Interview Master Certificate: eligibility (by REUSING the
 * Achievements + Interview History services — never a second calculation), a
 * once-only unlock, persistence of the issued certificate, and stable id
 * generation.
 *
 * Eligibility = the Angular Explorer achievement is earned (which already implies
 * every other achievement, incl. Interview Master) AND ≥ REQUIRED_CERTIFICATE_
 * INTERVIEWS completed interviews. Readiness / score / Interview Master formulas
 * are NOT re-checked here — they are subsumed by Angular Explorer. Progress is
 * recomputed live and never stored; only the issued certificate (unlock flag +
 * date + id + optional name) is persisted, under its own key.
 */
// Topic-curriculum achievements — earning ALL of them starts the certificate
// qualification period.
const CURRICULUM_ACHIEVEMENTS: readonly AchievementId[] = [
  'beginner-complete',
  'intermediate-complete',
  'advanced-complete'
];

@Injectable({ providedIn: 'root' })
export class InterviewCertificateService {
  private readonly achievements = inject(AchievementService);
  private readonly historyService = inject(InterviewHistoryService);

  private readonly _record = signal<InterviewCertificateRecord | null>(this.load());
  // The certificate qualification start date (ISO). Written ONCE the first time
  // the curriculum is complete; only interviews on/after it count.
  private readonly _qualStartedAt = signal<string | undefined>(this.loadQualStartedAt());

  /** The issued certificate, or null until unlocked. */
  readonly record = this._record.asReadonly();

  /** Whether the certificate has been unlocked (and persisted). */
  readonly unlocked = computed(() => this._record()?.unlocked === true);

  /**
   * Live certificate progress. Reactive to Interview History + the qualification
   * date (signals); the achievements are read fresh on each recompute. Drives the
   * Results + Builder progress UIs and gates unlock().
   *
   * IMPORTANT: this only COUNTS — it never writes the qualification date (a
   * computed must stay pure). Call ensureQualificationStarted() imperatively.
   */
  readonly progress = computed<InterviewCertificateProgress>(() => {
    // Angular Explorer is the achievement source of truth (implies all others).
    const angularExplorerEarned = this.achievements.earnedIds().has('angular-explorer');

    // Count ONLY completed interviews on/after the qualification date. Interviews
    // predating it (or all of them, if qualification hasn't started) do NOT count,
    // but stay in Interview History for Readiness / Trends / Topic Trends.
    const qualificationStartedAt = this._qualStartedAt();
    const qualifyingInterviewsCompleted = qualificationStartedAt
      ? this.historyService.history().filter((e) => e.completedAt >= qualificationStartedAt).length
      : 0;
    const interviewsRemaining = Math.max(REQUIRED_CERTIFICATE_INTERVIEWS - qualifyingInterviewsCompleted, 0);

    return {
      qualificationStartedAt,
      angularExplorerEarned,
      qualifyingInterviewsCompleted,
      requiredInterviews: REQUIRED_CERTIFICATE_INTERVIEWS,
      interviewsRemaining,
      isEligible: angularExplorerEarned && qualifyingInterviewsCompleted >= REQUIRED_CERTIFICATE_INTERVIEWS,
      isUnlocked: this._record()?.unlocked === true
    };
  });

  /**
   * Start the certificate qualification period exactly ONCE — the first time the
   * topic curriculum (Beginner/Intermediate/Advanced Complete) is complete. Safe
   * to call on every certificate-surface load: it no-ops if the date is already
   * set or the curriculum isn't finished yet. This ALSO handles migration —
   * existing users who finished the curriculum before this feature get their
   * qualification date on the first evaluation after the update (we deliberately
   * do NOT infer an older historical date).
   */
  ensureQualificationStarted(): void {
    if (this._qualStartedAt()) return;                 // written once — never overwritten
    const earned = this.achievements.earnedIds();
    if (!CURRICULUM_ACHIEVEMENTS.every((id) => earned.has(id))) return;   // not qualified yet

    const now = new Date().toISOString();
    this._qualStartedAt.set(now);
    writeLocalJson(SK_INTERVIEW_CERTIFICATE_QUAL, { startedAt: now });
  }

  /**
   * Unlock the certificate exactly once, persisting it. Idempotent: if already
   * unlocked it returns the existing record (stable id, unchanged date). Returns
   * null when not yet eligible. Once issued, the certificate stays unlocked even
   * if later history shrinks — the reward is permanent.
   */
  unlock(): InterviewCertificateRecord | null {
    const existing = this._record();
    if (existing?.unlocked) return existing;          // already issued — stable
    if (!this.progress().isEligible) return null;     // requirements not yet met

    const now = new Date().toISOString();
    const record: InterviewCertificateRecord = {
      version: INTERVIEW_CERTIFICATE_VERSION,
      unlocked: true,
      unlockedAt: now,
      certificateId: generateCertificateId(now),
      recipientName: existing?.recipientName
    };
    this._record.set(record);
    this.save(record);
    return record;
  }

  /** Set the optional recipient name shown on the certificate (unlocked only). */
  setRecipientName(name: string): void {
    const rec = this._record();
    if (!rec?.unlocked) return;
    const trimmed = name.trim().slice(0, 60);
    const updated: InterviewCertificateRecord = {
      ...rec,
      recipientName: trimmed.length > 0 ? trimmed : undefined
    };
    this._record.set(updated);
    this.save(updated);
  }

  /**
   * Remove the issued certificate. Exposed for a future global "reset progress"
   * action; NOT wired to any UI (a refresh / new interview never calls it).
   */
  clear(): void {
    this._record.set(null);
    this._qualStartedAt.set(undefined);
    removeLocalKey(SK_INTERVIEW_CERTIFICATE);
    removeLocalKey(SK_INTERVIEW_CERTIFICATE_QUAL);
  }

  // ── internals ───────────────────────────────────────────────────
  private load(): InterviewCertificateRecord | null {
    return validateCertificateRecord(readLocalJson<unknown>(SK_INTERVIEW_CERTIFICATE, null));
  }

  /** Load a persisted, valid ISO qualification date (else undefined). */
  private loadQualStartedAt(): string | undefined {
    const raw = readLocalJson<{ startedAt?: unknown } | null>(SK_INTERVIEW_CERTIFICATE_QUAL, null);
    const s = raw?.startedAt;
    return typeof s === 'string' && !Number.isNaN(Date.parse(s)) ? s : undefined;
  }

  private save(record: InterviewCertificateRecord): void {
    writeLocalJson(SK_INTERVIEW_CERTIFICATE, record);
  }
}

// ── pure helpers (exported for tests) ─────────────────────────────────

/**
 * Generate a stable, certificate-style id — `AQ-2026-000128`. Called ONCE at
 * unlock and then persisted, so it never changes. `rand` is injectable for
 * deterministic tests.
 */
export function generateCertificateId(iso: string, rand: () => number = Math.random): string {
  const parsed = new Date(iso);
  const year = Number.isNaN(parsed.getTime()) ? new Date().getFullYear() : parsed.getFullYear();
  const n = Math.floor(Math.max(0, Math.min(0.9999999, rand())) * 1_000_000);
  return `${CERTIFICATE_ID_PREFIX}-${year}-${String(n).padStart(6, '0')}`;
}

/**
 * Validate an untrusted persisted certificate record. Returns a clean record or
 * null (never throws). Only an explicitly-unlocked record with a valid id + date
 * survives; anything else is treated as "no certificate".
 */
export function validateCertificateRecord(raw: unknown): InterviewCertificateRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['unlocked'] !== true) return null;
  if (typeof r['certificateId'] !== 'string' || r['certificateId'].length === 0) return null;
  if (typeof r['unlockedAt'] !== 'string' || Number.isNaN(Date.parse(r['unlockedAt']))) return null;

  const name =
    typeof r['recipientName'] === 'string' && r['recipientName'].trim().length > 0
      ? r['recipientName'].trim().slice(0, 60)
      : undefined;

  return {
    version: INTERVIEW_CERTIFICATE_VERSION,
    unlocked: true,
    unlockedAt: r['unlockedAt'],
    certificateId: r['certificateId'],
    recipientName: name
  };
}
