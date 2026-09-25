/**
 * How a notice leaves the screen, and the one delay shared by everything that leaves on its own.
 *
 * Two kinds of finished notice (CONTEXT.md → [[Activity Toast]]): one that only *reports* -
 * "1 asset uploaded" - and can go by itself once it has been on screen long enough to be read;
 * and one that *asks something* of the user - a failure to read, a weaker claim to notice, a
 * follow-on to take - which stays until they close it, because closing it is the acknowledgement.
 *
 * The delay lives here rather than in the Activity store so the next self-dismissing notice
 * (a banner, a prompt) uses the same number, and changing it is one edit. It is deliberately not
 * a setting: a notice that lingers for a different length in each place reads as broken.
 */

/** A notice either goes on its own after {@link NOTICE_AUTO_DISMISS_MS} (`auto`) or stays until closed (`manual`). */
export type NoticeDismissal = 'auto' | 'manual'

/** How long a self-dismissing notice stays. Long enough to read twice; short enough not to pile up. */
export const NOTICE_AUTO_DISMISS_MS = 15_000
