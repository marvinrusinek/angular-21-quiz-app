/**
 * Angular Interview Master Certificate — a reward for sustained MASTERY across
 * the app, not mere completion. Eligibility is derived by REUSING the existing
 * Achievements, Interview Readiness, and Interview History systems (never a
 * second calculation). Only the issued certificate itself is persisted here.
 */
import { InterviewReadinessBand } from './interview-readiness.model';

/** Storage schema version. Bump only on a breaking shape change. */
export const INTERVIEW_CERTIFICATE_VERSION = 1 as const;

/** Human-facing certificate title. */
export const CERTIFICATE_TITLE = 'Angular Interview Master';

/** Minimum best Interview Mode score (percentage) required. Configurable. */
export const CERTIFICATE_MIN_SCORE = 90;

/** Required Interview Readiness tier — the HIGHEST band (90–100). Configurable. */
export const CERTIFICATE_REQUIRED_BAND: InterviewReadinessBand = 'interview-ready';

/** Certificate id prefix, e.g. `AQ-2026-000128`. */
export const CERTIFICATE_ID_PREFIX = 'AQ';

/** The three eligibility requirements, in display order. */
export type CertificateRequirementKey = 'achievements' | 'readiness' | 'score';

/** One requirement's state for the progress checklist. */
export interface CertificateRequirement {
  key: CertificateRequirementKey;
  met: boolean;
  label: string;    // "All achievements unlocked"
  detail: string;   // "6 / 6 earned", "Interview Readiness: Strong (need Interview Ready)"
}

/** A reactive snapshot of eligibility — drives both the progress UI and unlock. */
export interface CertificateEligibility {
  eligible: boolean;
  requirements: CertificateRequirement[];
  achievementsEarned: number;
  achievementsTotal: number;
  readinessBand: InterviewReadinessBand | null;
  readinessReady: boolean;      // ≥ 2 completed interviews (an authoritative score)
  bestScore: number | null;     // best retained interview percentage
}

/**
 * The persisted certificate. Deliberately minimal: the unlock flag, the issue
 * date, the stable id, and an optional user-entered name. Readiness tier and
 * score are NOT stored — they are shown live from the reused services, so this
 * record never duplicates achievement / readiness / interview-history data.
 */
export interface InterviewCertificateRecord {
  version: typeof INTERVIEW_CERTIFICATE_VERSION;
  unlocked: boolean;
  unlockedAt: string;          // ISO 8601
  certificateId: string;       // stable once issued
  recipientName?: string;      // optional; user-entered on the certificate page
}
