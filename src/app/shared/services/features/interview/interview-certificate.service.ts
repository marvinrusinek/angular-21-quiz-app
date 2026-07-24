import { computed, inject, Injectable, signal } from '@angular/core';

import {
  CERTIFICATE_ID_PREFIX,
  CERTIFICATE_MIN_SCORE,
  CERTIFICATE_REQUIRED_BAND,
  CertificateEligibility,
  CertificateRequirement,
  INTERVIEW_CERTIFICATE_VERSION,
  InterviewCertificateRecord
} from '../../../models/interview-certificate.model';
import { InterviewReadinessBand } from '../../../models/interview-readiness.model';
import { SK_INTERVIEW_CERTIFICATE } from '../../../constants/session-keys';
import { readLocalJson, removeLocalKey, writeLocalJson } from '../../../utils/local-storage';

import { AchievementService } from '../../achievements/achievement.service';
import { InterviewReadinessService } from './interview-readiness.service';
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
 * Achievements, Interview Readiness, and Interview History services — never a
 * second calculation), a once-only unlock, persistence of the issued
 * certificate, and stable id generation.
 *
 * Eligibility is recomputed live from those sources, so it always reflects new
 * achievements / interviews and is never stored. Only the issued certificate
 * (unlock flag + date + id + optional name) is persisted, under its own key.
 */
@Injectable({ providedIn: 'root' })
export class InterviewCertificateService {
  private readonly achievements = inject(AchievementService);
  private readonly readinessService = inject(InterviewReadinessService);
  private readonly historyService = inject(InterviewHistoryService);

  private readonly _record = signal<InterviewCertificateRecord | null>(this.load());

  /** The issued certificate, or null until unlocked. */
  readonly record = this._record.asReadonly();

  /** Whether the certificate has been unlocked (and persisted). */
  readonly unlocked = computed(() => this._record()?.unlocked === true);

  /**
   * Live eligibility snapshot. Reactive to Interview History / Readiness (both
   * signal-derived); achievement state is read fresh on each recompute. Drives
   * the Results-page progress checklist and gates unlock().
   */
  readonly eligibility = computed<CertificateEligibility>(() => this.computeEligibility());

  /**
   * Unlock the certificate exactly once, persisting it. Idempotent: if already
   * unlocked it returns the existing record (stable id, unchanged date). Returns
   * null when not yet eligible. Once issued, the certificate stays unlocked even
   * if later state changes — the reward is permanent.
   */
  unlock(): InterviewCertificateRecord | null {
    const existing = this._record();
    if (existing?.unlocked) return existing;          // already issued — stable
    if (!this.eligibility().eligible) return null;    // requirements not yet met

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
    removeLocalKey(SK_INTERVIEW_CERTIFICATE);
  }

  // ── internals ───────────────────────────────────────────────────
  private computeEligibility(): CertificateEligibility {
    // 1. Achievements — the Achievements system is the source of truth.
    const { earned, total } = this.achievements.summary();
    const achievementsMet = total > 0 && earned >= total;

    // 2. Interview Readiness — reuse the existing readiness estimate (signal).
    const readiness = this.readinessService.readiness();
    const readinessReady = readiness?.status === 'ready';
    const band = readiness?.band ?? null;
    const readinessMet = readinessReady && band === CERTIFICATE_REQUIRED_BAND;

    // 3. Strong interview score — best retained percentage (reuses history/result).
    const bestScore = this.historyService.trends().best;
    const scoreMet = (bestScore ?? 0) >= CERTIFICATE_MIN_SCORE;

    const requirements: CertificateRequirement[] = [
      {
        key: 'achievements',
        met: achievementsMet,
        label: $localize`All achievements unlocked`,
        detail: $localize`${earned} / ${total} earned`
      },
      {
        key: 'readiness',
        met: readinessMet,
        label: $localize`Interview Readiness: highest tier`,
        detail: readinessReady
          ? $localize`Currently ${readinessBandLabel(band)} (need ${readinessBandLabel(CERTIFICATE_REQUIRED_BAND)})`
          : $localize`Complete more interviews for a readiness rating`
      },
      {
        key: 'score',
        met: scoreMet,
        label: $localize`Strong interview score`,
        detail:
          bestScore == null
            ? $localize`No interviews yet (need ${CERTIFICATE_MIN_SCORE}%)`
            : $localize`Best ${bestScore}% (need ${CERTIFICATE_MIN_SCORE}%)`
      }
    ];

    return {
      eligible: achievementsMet && readinessMet && scoreMet,
      requirements,
      achievementsEarned: earned,
      achievementsTotal: total,
      readinessBand: band,
      readinessReady,
      bestScore
    };
  }

  private load(): InterviewCertificateRecord | null {
    return validateCertificateRecord(readLocalJson<unknown>(SK_INTERVIEW_CERTIFICATE, null));
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
