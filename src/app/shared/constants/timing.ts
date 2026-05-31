/**
 * Timing constants. Anything `setTimeout`-ish should be defined here with
 * a name that explains WHY the delay exists, not just "X milliseconds".
 *
 * The retry cascades below exist because Angular's change-detection +
 * intermediate pipeline writes (option-lock-policy, processOptionBindings,
 * SOC backstop, MutationObservers) can stamp over a freshly-written FET
 * or H3 value during the first ~1 second after a question loads. Each
 * cascade re-attempts the write at staggered delays so eventually one
 * pass wins after the intermediate writers have settled.
 */

/** General FET / H3 write retry cascade. Short enough to survive a CD pass
 *  but long enough to clear most intermediate stomps. */
export const FET_WRITE_RETRY_CASCADE_MS: readonly number[] = [50, 200, 500];

/** Extended FET retry cascade for slower init paths (initial route hydration,
 *  shuffled-mode rebuild). Adds a 1-second tail for the late-arriving signal
 *  pipeline writes. */
export const FET_WRITE_RETRY_LONG_CASCADE_MS: readonly number[] = [50, 200, 500, 1000];

/** Cascade for re-stamping the H3 heading on tab-visibility restore.
 *  Longer-tailed because the QQC visibility-restore flow runs async
 *  (350ms + 400ms setTimeouts) and may clear/replace qText after first replay. */
export const VISIBILITY_RESTORE_REPLAY_CASCADE_MS: readonly number[] = [100, 500, 900, 1200, 2000];

/** Generic 5-second timeout for `Promise.race` patterns where a stuck
 *  async operation should surface as a rejection rather than hang. */
export const PROMISE_RACE_TIMEOUT_MS = 5000;
