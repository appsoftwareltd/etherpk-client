/**
 * The Activity vocabulary (CONTEXT.md → [[Activity]], [[Activity Toast]]; ADR 0035).
 *
 * An **Activity** is a long-running operation that outlives the surface that started it:
 * the dialog closes, the user navigates away, and the work carries on. It belongs to the
 * Client session, not to a graph - it never syncs, never travels in an Export, and does
 * not survive a page reload.
 *
 * Nothing here knows what an import or an upload IS. The store is a collection of
 * progress-reporting runs; the tenants supply the phases and the work.
 */

import type { NoticeDismissal } from '$lib/notice-dismissal'

/** What a phase counts. `bytes` renders through `formatBytes`; `items` renders bare. */
export type ActivityUnit = 'items' | 'bytes'

/**
 * How an Activity ended.
 * - `done` - everything the Activity promised is finished.
 * - `partial` - the work landed but a weaker claim is true than `done` would imply
 *   (an import whose acks stalled: registered, content safe locally, still draining).
 * - `failed` - the work did not land; any rollback the tenant owns has already run.
 */
export type ActivityState = 'running' | 'done' | 'partial' | 'failed'

/** One step of an Activity, declared up front so "Step 3 of 5" is honest. */
export interface ActivityPhase {
    /** The user-facing label, e.g. "Uploading assets". */
    label: string
    unit: ActivityUnit
}

/** A progress report from inside a running Activity. */
export interface ActivityProgress {
    /** Index into the Activity's declared `phases`. */
    phase: number
    done: number
    /** 0 ⇒ uncounted; the toast shows the label alone rather than a lying bar. */
    total: number
}

export type ActivityProgressFn = (progress: ActivityProgress) => void

/**
 * The follow-on offered by a finished Activity's toast (ADR 0035: completion NEVER
 * navigates on its own - an eight-minute import must not yank the user out of whatever
 * they moved on to).
 */
export interface ActivityAction {
    label: string
    run: () => void | Promise<void>
}

/**
 * Whether a finished toast goes on its own or waits to be closed - see `$lib/notice-dismissal`.
 * `manual` while running: a running toast is never dismissed at all.
 */
export type ActivityDismissal = NoticeDismissal

/** A live Activity as the toast host sees it. */
export interface Activity {
    id: string
    /**
     * Distinguishes tenants; the store enforces at most one running `import`.
     *
     * `mirror` is reported only for a [[Local Mirror]]'s full pass over a graph big enough for
     * that pass to take noticeable time - the first one of a session, and every resume. A toast
     * per debounced write would be noise, and the Mirror tab carries the steady state instead.
     */
    kind: 'import' | 'asset-upload' | 'mirror' | 'publish' | 'export'
    /** The headline, e.g. `Importing "My Graph"`. */
    title: string
    phases: ActivityPhase[]
    phase: number
    done: number
    total: number
    state: ActivityState
    /** Set when `state` is `done`/`partial`/`failed`: the outcome line under the title. */
    detail?: string
    /** Offered by the toast once finished. */
    action?: ActivityAction
    /** True while the tenant supports cancellation and the Activity is still running. */
    cancellable: boolean
    /** True once cancellation has been requested but the run has not yet unwound. */
    cancelling: boolean
    /**
     * Once finished: `auto` when the outcome only reports (`done`, nothing to act on) and the
     * toast will go by itself; `manual` when it asks something of the user - a failure, a
     * partial outcome, a follow-on action - and stays until closed. A tenant's outcome may say
     * otherwise. `manual` while running.
     */
    dismissal: ActivityDismissal
}
