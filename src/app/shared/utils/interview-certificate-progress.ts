import { InterviewCertificateProgress } from '../models/interview-certificate.model';

/**
 * Pure presentation helpers for the certificate progress UI (Results + Interview
 * Builder). They only READ an already-computed progress model — no eligibility
 * logic lives here — so wording (incl. singular/plural) is easy to test and
 * stays identical across surfaces.
 */

/** "1 interview" / "2 interviews" — correct singular/plural. */
function interviewsWord(n: number): string {
  return n === 1 ? $localize`interview` : $localize`interviews`;
}

/**
 * The single clearest next action for a NOT-yet-unlocked certificate. Returns ''
 * when unlocked or already eligible (the UI shows the unlocked state instead).
 */
export function certificateNextAction(p: InterviewCertificateProgress): string {
  if (p.isUnlocked || p.isEligible) return '';

  const explorer = p.angularExplorerEarned;
  const interviewsDone = p.completedInterviews >= p.requiredInterviews;

  if (explorer && !interviewsDone) {
    const n = p.interviewsRemaining;
    return $localize`Complete ${n} more ${interviewsWord(n)} to earn your certificate.`;
  }
  if (!explorer && interviewsDone) {
    return $localize`Unlock Angular Explorer to earn your certificate.`;
  }
  // Both requirements still incomplete.
  return $localize`Continue earning achievements and completing interviews.`;
}

/**
 * A single screen-reader sentence summarising certificate progress. Used in an
 * sr-only element (static content — NOT a live region).
 */
export function certificateAccessibleSummary(p: InterviewCertificateProgress): string {
  if (p.isUnlocked) {
    return $localize`Angular Interview Master certificate unlocked.`;
  }
  const explorer = p.angularExplorerEarned
    ? $localize`Angular Explorer unlocked.`
    : $localize`Angular Explorer not yet unlocked.`;
  const counts = $localize`${p.completedInterviews} of ${p.requiredInterviews} required interviews completed.`;
  const remaining =
    p.interviewsRemaining > 0
      ? $localize`${p.interviewsRemaining} ${interviewsWord(p.interviewsRemaining)} remaining.`
      : '';
  return [$localize`Certificate progress:`, explorer, counts, remaining].filter(Boolean).join(' ');
}
