/**
 * SINGLE source of truth for Review filtering in Interview Mode. Pure data +
 * predicates — no component/template logic. Each filter carries its label, its
 * match predicate, and its friendly empty-state text, so counts, filtering and
 * empty states all derive from one place and stay in sync.
 *
 * FLAGGING (future-ready): the 'flagged' filter already works against
 * `item.flagged`; it is marked `requiresFlagging` so the UI hides it until a
 * flagging feature exists. Adding flagging later means populating `flagged` and
 * flipping availability — the filtering system itself does not change.
 */
export type ReviewStatus = 'correct' | 'incorrect' | 'unanswered';

export type ReviewFilterId = 'all' | 'incorrect' | 'correct' | 'skipped' | 'flagged';

/** The minimal per-question shape a filter needs (a subset of ReviewItem). */
export interface ReviewFilterItem {
  status: ReviewStatus;
  flagged: boolean;
}

export interface ReviewFilterDef {
  id: ReviewFilterId;
  label: string;
  /** Bold line shown when the filter matches nothing (empty when not needed). */
  emptyHeading: string;
  /** Supporting line for the empty state. */
  emptyMessage: string;
  /** True only while a real flagging feature is required to surface this filter. */
  requiresFlagging: boolean;
  match: (item: ReviewFilterItem) => boolean;
}

/**
 * Order matches the requested chip order: All, Incorrect, Correct, Skipped,
 * Flagged. `$localize` keeps the labels/messages translatable.
 */
export const REVIEW_FILTERS: readonly ReviewFilterDef[] = [
  {
    id: 'all',
    label: $localize`All`,
    emptyHeading: '',
    emptyMessage: $localize`No questions to review.`,
    requiresFlagging: false,
    match: () => true
  },
  {
    id: 'incorrect',
    label: $localize`Incorrect`,
    emptyHeading: $localize`Great job!`,
    emptyMessage: $localize`No incorrect answers.`,
    requiresFlagging: false,
    // Answered but wrong — including partially-correct multi-answer scored wrong
    // (status is 'incorrect' whenever the answer wasn't fully correct AND at
    // least one option was chosen). Skipped questions are NOT included here.
    match: (item) => item.status === 'incorrect'
  },
  {
    id: 'correct',
    label: $localize`Correct`,
    emptyHeading: '',
    emptyMessage: $localize`No correct answers yet.`,
    requiresFlagging: false,
    match: (item) => item.status === 'correct'
  },
  {
    id: 'skipped',
    label: $localize`Skipped`,
    emptyHeading: '',
    emptyMessage: $localize`No skipped questions.`,
    requiresFlagging: false,
    // No answer recorded before submission / timeout.
    match: (item) => item.status === 'unanswered'
  },
  {
    id: 'flagged',
    label: $localize`Flagged`,
    emptyHeading: '',
    emptyMessage: $localize`No flagged questions.`,
    requiresFlagging: true,
    match: (item) => item.flagged
  }
];
