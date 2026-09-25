/**
 * One shutdown path for the process. Shared by the Sync Server and Corporate, which wire it
 * the same way from their `server.ts` and `hooks.server.ts`.
 *
 * `server.ts` and `hooks.server.ts` are compiled into two separate bundles by adapter-node,
 * each carrying its own copy of every module it imports. If each registered its own `SIGTERM`
 * listener, Node would run them in registration order: the hooks listener would start an async
 * log flush and return, then `server.ts`'s listener would call `process.exit(0)` synchronously,
 * cutting the flush and `server.close()` short, dropping in-flight requests and severing open
 * sync WebSockets without a close frame on every rolling update.
 *
 * Because the two bundles cannot import each other, the task list is held on `globalThis`
 * under a well-known symbol, so both module copies converge on one registry and one set of
 * signal handlers.
 *
 * Phases run in order, tasks within a phase run together:
 *   drain   - stop accepting new work and let what is in flight finish
 *   dispose - close what is still open (WebSockets, schedulers, pools)
 *   flush   - push buffered state out (log shipping) last, so it captures the phases above
 */

export type ShutdownPhase = 'drain' | 'dispose' | 'flush'

const PHASE_ORDER: readonly ShutdownPhase[] = ['drain', 'dispose', 'flush']

/**
 * Total budget for the whole shutdown. Kubernetes' default
 * `terminationGracePeriodSeconds` is 30, so finishing well inside that leaves room for the
 * SIGKILL that follows.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000

export interface ShutdownTask {
    /** Used in the timeout and failure diagnostics; make it identify the subsystem. */
    name: string
    phase: ShutdownPhase
    run: () => Promise<void> | void
}

interface ShutdownRegistry {
    tasks: ShutdownTask[]
    handlersInstalled: boolean
    running: Promise<void> | null
}

// Symbol.for gives one key across bundle copies; a plain module-level array would not.
const REGISTRY_KEY = Symbol.for('etherpk.shutdown.registry')

function registry(): ShutdownRegistry {
    const container = globalThis as unknown as Record<symbol, ShutdownRegistry | undefined>
    let existing = container[REGISTRY_KEY]
    if (!existing) {
        existing = { tasks: [], handlersInstalled: false, running: null }
        container[REGISTRY_KEY] = existing
    }
    return existing
}

/** Register work to run on shutdown. Returns a function that unregisters it. */
export function registerShutdownTask(task: ShutdownTask): () => void {
    const current = registry()
    current.tasks.push(task)
    return () => {
        const index = current.tasks.indexOf(task)
        if (index >= 0) current.tasks.splice(index, 1)
    }
}

/**
 * Resolve when `work` settles or when `timeoutMs` elapses, whichever comes first. A task
 * that hangs must not hold the process open past its budget, so the timeout resolves rather
 * than rejects and the timer is cleared either way.
 */
function withDeadline<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<void> {
    return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            onTimeout()
            resolve()
        }, timeoutMs)
        work.then(
            () => { clearTimeout(timer); resolve() },
            () => { clearTimeout(timer); resolve() },
        )
    })
}

export interface RunShutdownOptions {
    /** Total budget across all phases. */
    timeoutMs?: number
    /** Called when a task throws or a phase runs out of budget. */
    onError?: (message: string, detail: { task?: string; phase: ShutdownPhase; error?: unknown }) => void
}

/**
 * Run every registered task, in phase order. Idempotent: a second signal while a shutdown is
 * already in progress joins the first rather than starting another. Never rejects, and never
 * exits the process; the caller decides that.
 */
export function runShutdown(options: RunShutdownOptions = {}): Promise<void> {
    const current = registry()
    if (current.running) return current.running

    const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    const report = options.onError ?? (() => {})

    current.running = (async () => {
        const deadline = Date.now() + timeoutMs
        for (const phase of PHASE_ORDER) {
            const tasks = current.tasks.filter((task) => task.phase === phase)
            if (tasks.length === 0) continue

            const settled = Promise.all(
                tasks.map(async (task) => {
                    try {
                        await task.run()
                    } catch (error) {
                        report('shutdown task failed', { task: task.name, phase, error })
                    }
                }),
            )
            // Give every phase at least a moment even when an earlier one overran, so the
            // log flush is not skipped outright by a slow drain.
            const remaining = Math.max(250, deadline - Date.now())
            await withDeadline(settled, remaining, () => {
                report('shutdown phase timed out', { phase, task: tasks.map((t) => t.name).join(', ') })
            })
        }
    })()

    return current.running
}

/**
 * Install the process signal handlers, once per process however many bundles call this.
 * `onComplete` decides what happens after the tasks finish; production passes
 * `process.exit`.
 */
export function installShutdownSignalHandlers(
    options: RunShutdownOptions & { onComplete?: () => void } = {},
): boolean {
    const current = registry()
    if (current.handlersInstalled) return false
    current.handlersInstalled = true

    const complete = options.onComplete ?? (() => process.exit(0))
    const onSignal = () => { void runShutdown(options).then(complete) }
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)
    return true
}

/** Test-only: clear the shared registry between cases. */
export function _resetShutdownRegistry(): void {
    const container = globalThis as unknown as Record<symbol, ShutdownRegistry | undefined>
    container[REGISTRY_KEY] = undefined
}
