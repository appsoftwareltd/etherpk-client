/**
 * What this device remembers about a [[Kanban Board]] (ADR 0113): which lanes are collapsed, and
 * which task the [[Task Detail]] shows and how tall it is.
 *
 * Per device, per [[Knowledge Graph]] and per concept, like the [[Tasks View]]'s filter: never
 * synced and never in an [[Export]] (ADR 0013). It is kept out of the Layout model for the reason
 * `task-filter-store.ts` gives, and under one key per board, so two boards open at once never write
 * over each other's state.
 *
 * Zod-validated. A payload that cannot be read falls back to the defaults and never throws.
 */
import { z } from 'zod'

import { conceptKey, type TaskStatus } from '../document/backlinks'

export const BOARD_STATE_KEY_PREFIX = 'etherpk-kanban:'
const VERSION = 1
const SAVE_DEBOUNCE_MS = 300
const MIN_DETAIL_HEIGHT = 0.2
const MAX_DETAIL_HEIGHT = 0.8

/** The task the Task Detail shows: where it was when the board last saw it. */
export interface TaskDetailState {
    document: string
    /** 0-based and body-relative, as the index counts lines. */
    line: number
    label: string
}

export interface BoardState {
    /** Lanes shown as a narrow strip with their count. */
    collapsed: TaskStatus[]
    /** The task the Task Detail shows, or null while it is closed. */
    detail: TaskDetailState | null
    /** The Task Detail's share of the board's height. */
    detailHeight: number
}

const statusSchema = z.enum(['open', 'doing', 'waiting', 'done', 'cancelled'])
const stateSchema = z.object({
    collapsed: z.array(statusSchema),
    detail: z.object({ document: z.string(), line: z.number().int().nonnegative(), label: z.string() }).nullable(),
    detailHeight: z.number().min(MIN_DETAIL_HEIGHT).max(MAX_DETAIL_HEIGHT),
})
const payloadSchema = z.object({ version: z.literal(VERSION), state: stateSchema })

/**
 * Done and Cancelled start collapsed: they only grow, and a project's history would otherwise
 * push its open work off the screen. The Task Detail starts closed, at half the height.
 */
export function defaultBoardState(): BoardState {
    return { collapsed: ['done', 'cancelled'], detail: null, detailHeight: 0.5 }
}

export interface BoardStateStore {
    get(): BoardState
    set(next: BoardState): void
    /** Write any pending debounced save now (teardown). */
    flush(): void
}

export function createBoardStateStore(graphId: string, concept: string, storage: Storage | undefined = globalThis.localStorage): BoardStateStore {
    const key = `${BOARD_STATE_KEY_PREFIX}${graphId}:${conceptKey(concept)}`
    let current = load()
    let saveTimer: ReturnType<typeof setTimeout> | undefined

    function load(): BoardState {
        try {
            const raw = storage?.getItem(key)
            if (!raw) return defaultBoardState()
            const parsed = payloadSchema.safeParse(JSON.parse(raw))
            return parsed.success ? parsed.data.state : defaultBoardState()
        } catch {
            // Unreadable JSON, or storage that refuses to be read (a private window): defaults.
            return defaultBoardState()
        }
    }

    function save(): void {
        saveTimer = undefined
        try {
            storage?.setItem(key, JSON.stringify({ version: VERSION, state: current }))
        } catch {
            // A full or refused storage loses a preference, never the board.
        }
    }

    return {
        get: () => current,
        set(next) {
            current = { ...next, detailHeight: Math.min(MAX_DETAIL_HEIGHT, Math.max(MIN_DETAIL_HEIGHT, next.detailHeight)) }
            clearTimeout(saveTimer)
            saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS)
        },
        flush() {
            if (saveTimer === undefined) return
            clearTimeout(saveTimer)
            save()
        },
    }
}
