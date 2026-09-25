/**
 * The [[Activity]] collection (ADR 0035): every long-running run the user has started in
 * this tab, and the progress each is reporting. The [[Activity Toast]] host subscribes;
 * tenants (import, asset upload) call {@link runActivity} and report through the handle.
 *
 * A plain observable rather than a `$state` rune, matching `asset-picker.ts`: the tenants
 * are node-tested modules outside any component, so they must be able to import this
 * without the Svelte compiler. The host mirrors it into a local rune.
 *
 * **Scope is this browser tab, and only this tab** - module state. Two tabs hold two
 * blind stores. That is deliberate: the realistic accident is clicking Import twice on
 * one page, and cross-tab coordination buys little that the server's own vault version
 * check does not already backstop.
 */

import { NOTICE_AUTO_DISMISS_MS } from '$lib/notice-dismissal'

import type { Activity, ActivityAction, ActivityDismissal, ActivityPhase, ActivityProgress, ActivityState } from './types'

/** Thrown when a run is asked to start while a conflicting one is already going. */
export class ActivityConflictError extends Error {}

/** The controls a running tenant holds over its own Activity. */
export interface ActivityHandle {
    readonly id: string
    /** Aborts when the user cancels; also the yield checkpoint (see `breathe`). */
    readonly signal: AbortSignal
    /** Move to a declared phase, resetting its counters. */
    beginPhase(phase: number, total: number): void
    /** Report progress within the current phase. */
    report(progress: ActivityProgress): void
    /** Advance the current phase's `done` counter by `amount` (default 1). */
    tick(amount?: number): void
}

interface Entry extends Activity {
    controller: AbortController
    /** The pending self-dismissal of an `auto` toast; cleared by a hand dismissal or a reset. */
    autoDismiss?: ReturnType<typeof setTimeout>
}

let entries: Entry[] = []
const listeners = new Set<(list: Activity[]) => void>()

/** The public snapshot: `controller` and the timer never leave this module. */
function snapshot(): Activity[] {
    return entries.map(({ controller: _controller, autoDismiss: _autoDismiss, ...rest }) => ({ ...rest }))
}

/**
 * The default kind of a finished toast: one that only reports goes by itself; one that asks
 * something of the user - a failure to read, a weaker claim to notice, a follow-on to take -
 * stays until they close it. See `$lib/notice-dismissal`.
 */
function defaultDismissal(entry: Entry): ActivityDismissal {
    return entry.state === 'done' && !entry.action ? 'auto' : 'manual'
}

function emit(): void {
    const list = snapshot()
    for (const listener of listeners) listener(list)
}

/** Subscribe to the Activity list; fires immediately with the current one. Returns an unsubscribe. */
export function subscribeActivities(listener: (list: Activity[]) => void): () => void {
    listeners.add(listener)
    listener(snapshot())
    return () => listeners.delete(listener)
}

/** The current list (a snapshot; prefer {@link subscribeActivities} for reactivity). */
export function getActivities(): Activity[] {
    return snapshot()
}

/** True while an Activity of this kind is running - the wizard's guard against a second import. */
export function isRunning(kind: Activity['kind']): boolean {
    return entries.some((e) => e.kind === kind && e.state === 'running')
}

function find(id: string): Entry | undefined {
    return entries.find((e) => e.id === id)
}

export interface RunActivityOptions {
    kind: Activity['kind']
    title: string
    phases: ActivityPhase[]
    cancellable?: boolean
    /**
     * The work. Resolving means success; returning an outcome overrides the default
     * `done` state and detail line (an import whose acks stalled returns `partial`).
     * Throwing means failure - the tenant's own rollback must have run by then.
     */
    run: (handle: ActivityHandle) => Promise<ActivityOutcome | void>
    /**
     * Replaces the title when the run throws. Without it a failed toast still reads
     * "Importing …", which says nothing about whether the work survived.
     */
    failureTitle?: string
}

export interface ActivityOutcome {
    state?: Extract<ActivityState, 'done' | 'partial'>
    detail?: string
    action?: ActivityAction
    /**
     * Replaces the title once finished. A toast that still says "Importing …" next to an
     * Open button reads as though it is somehow both running and done.
     */
    title?: string
    /**
     * Override the toast's kind. By default a `done` outcome with nothing to act on goes by
     * itself after the shared delay, and anything else stays until closed; say `manual` to
     * keep a plain report on screen, or `auto` to let one with an action go.
     */
    dismissal?: ActivityDismissal
}

/**
 * Start an Activity and run it to completion. Resolves with the finished Activity; it
 * does NOT reject on the run's failure - a failed Activity is a normal outcome the toast
 * reports, not an exception for the caller to catch. Rejects only on a conflict.
 */
export async function runActivity(options: RunActivityOptions): Promise<Activity> {
    // At most one import at a time: two large ones at once double a memory footprint that
    // is already the thing most likely to fall over on a real graph, and on a fresh account
    // each would mint its own identity and Recovery Code.
    if (options.kind === 'import' && isRunning('import')) {
        throw new ActivityConflictError('An import is already running.')
    }

    const controller = new AbortController()
    const entry: Entry = {
        id: crypto.randomUUID(),
        kind: options.kind,
        title: options.title,
        phases: options.phases,
        phase: 0,
        done: 0,
        total: 0,
        state: 'running',
        cancellable: options.cancellable ?? true,
        cancelling: false,
        dismissal: 'manual',
        controller,
    }
    entries = [...entries, entry]
    emit()

    const handle: ActivityHandle = {
        id: entry.id,
        signal: controller.signal,
        beginPhase(phase, total) {
            if (entry.state !== 'running') return
            entry.phase = phase
            entry.done = 0
            entry.total = total
            emit()
        },
        report({ phase, done, total }) {
            if (entry.state !== 'running') return
            entry.phase = phase
            entry.done = done
            entry.total = total
            emit()
        },
        tick(amount = 1) {
            if (entry.state !== 'running') return
            entry.done += amount
            emit()
        },
    }

    let requestedDismissal: ActivityDismissal | undefined
    try {
        const outcome = (await options.run(handle)) ?? {}
        entry.state = outcome.state ?? 'done'
        entry.detail = outcome.detail
        entry.action = outcome.action
        if (outcome.title) entry.title = outcome.title
        requestedDismissal = outcome.dismissal
    } catch (err) {
        entry.state = 'failed'
        entry.detail = controller.signal.aborted ? 'Cancelled. Nothing was kept.' : describe(err)
        if (options.failureTitle) entry.title = options.failureTitle
    } finally {
        entry.cancelling = false
        entry.dismissal = requestedDismissal ?? defaultDismissal(entry)
        // Only a toast still on the list can go by itself: a reset mid-run has already dropped it.
        if (entry.dismissal === 'auto' && find(entry.id)) {
            entry.autoDismiss = setTimeout(() => dismissActivity(entry.id), NOTICE_AUTO_DISMISS_MS)
        }
        emit()
    }
    // Built from the entry rather than looked up: `resetActivities` (or a dismiss racing a
    // slow rollback) can drop it from the list, and the caller still needs its outcome.
    const { controller: _controller, ...finished } = entry
    return { ...finished }
}

/** A message worth showing: an abort reads as a cancellation, not as a stack-trace. */
function describe(err: unknown): string {
    if (err instanceof DOMException && err.name === 'AbortError') return 'Cancelled. Nothing was kept.'
    return err instanceof Error ? err.message : String(err)
}

/**
 * Request cancellation. The run unwinds at its next checkpoint and its own rollback path
 * runs, so the Activity does not reach a terminal state here - `runActivity`'s catch does
 * that once the work has actually stopped.
 */
export function cancelActivity(id: string): void {
    const entry = find(id)
    if (!entry || entry.state !== 'running' || !entry.cancellable) return
    entry.cancelling = true
    entry.controller.abort()
    emit()
}

/** Remove a finished Activity's toast. A running one cannot be dismissed - that would hide work in flight. */
export function dismissActivity(id: string): void {
    const entry = find(id)
    if (!entry || entry.state === 'running') return
    clearTimeout(entry.autoDismiss)
    entries = entries.filter((e) => e.id !== id)
    emit()
}

/** Test seam: drop every Activity, running or not. */
export function resetActivities(): void {
    for (const e of entries) {
        e.controller.abort()
        clearTimeout(e.autoDismiss)
    }
    entries = []
    emit()
}
