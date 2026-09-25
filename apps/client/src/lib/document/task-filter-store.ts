/**
 * The [[Tasks View]]'s filter, remembered per device and per [[Knowledge Graph]].
 *
 * Per-device presentation state, exactly like [[Layout]] and [[Reading Position]] — never
 * synced, never in an [[Export]] (ADR 0013). It deliberately does NOT live in the Layout
 * model: `ViewInstance` has no per-View state slot, and adding one bumps `LAYOUT_VERSION`,
 * which `parseSerializedLayout` treats as a reason to discard the saved Layout outright.
 * Everyone would lose their pane arrangement to persist a filter. Its own key and its own
 * version number cost nothing by comparison — a bad payload here loses a filter.
 *
 * Zod-validated; corrupt or incompatible payloads degrade to the defaults, never throw.
 */

import { z } from 'zod'

import {
    OPEN_TASK_STATUSES,
    TASK_PRIORITY_FILTERS,
    type TaskDueWindow,
    type TaskGroupBy,
    type TaskPriorityFilter,
    type TaskStatus,
} from './backlinks'

export const TASK_FILTER_KEY_PREFIX = 'etherpk-task-filter:'
const VERSION = 1
const SAVE_DEBOUNCE_MS = 300

/** The filter as the View holds it — the query minus `today`, which is never remembered. */
export interface TaskFilterState {
    concept: string | null
    statuses: TaskStatus[]
    priorities: TaskPriorityFilter[]
    due: TaskDueWindow
    groupBy: TaskGroupBy
}

const stateSchema = z.object({
    concept: z.string().nullable(),
    statuses: z.array(z.enum(['open', 'doing', 'waiting', 'done', 'cancelled'])),
    // `null` is the real "no priority" bucket, so the union must admit it.
    priorities: z.array(z.union([z.literal(1), z.literal(2), z.literal(3), z.null()])),
    due: z.enum(['any', 'overdue', 'today', 'next7']),
    groupBy: z.enum(['document', 'priority', 'due']),
})

const payloadSchema = z.object({ version: z.number(), filter: stateSchema })

/**
 * Everything not finished, every priority, every due date, grouped by priority — the AS Notes
 * default. The [[Name Filter]] starts empty, which is a valid and useful state: "every open
 * task in the graph" is half of what a task workbench is for.
 */
export function defaultTaskFilter(): TaskFilterState {
    return {
        concept: null,
        statuses: [...OPEN_TASK_STATUSES],
        priorities: [...TASK_PRIORITY_FILTERS],
        due: 'any',
        groupBy: 'priority',
    }
}

export interface TaskFilterStore {
    get(): TaskFilterState
    set(filter: TaskFilterState): void
    /** Write any pending debounced save now (teardown). */
    flush(): void
}

export function createTaskFilterStore(
    graphId: string,
    storage: Storage | undefined = globalThis.localStorage,
): TaskFilterStore {
    const key = `${TASK_FILTER_KEY_PREFIX}${graphId}`
    let current = load()
    let saveTimer: ReturnType<typeof setTimeout> | undefined

    function load(): TaskFilterState {
        const raw = storage?.getItem(key)
        if (!raw) return defaultTaskFilter()
        try {
            const parsed = payloadSchema.safeParse(JSON.parse(raw))
            if (!parsed.success || parsed.data.version !== VERSION) return defaultTaskFilter()
            return parsed.data.filter
        } catch {
            return defaultTaskFilter()
        }
    }

    function save(): void {
        saveTimer = undefined
        try {
            storage?.setItem(key, JSON.stringify({ version: VERSION, filter: current }))
        } catch {
            // A full or blocked quota costs a remembered filter, never the View.
        }
    }

    return {
        get: () => current,
        set(filter) {
            current = filter
            if (saveTimer) clearTimeout(saveTimer)
            saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS)
        },
        flush() {
            if (saveTimer) {
                clearTimeout(saveTimer)
                save()
            }
        },
    }
}
