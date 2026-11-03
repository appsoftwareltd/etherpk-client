/**
 * How tall a person has made each of the [[Task Editor]]'s part editors by dragging the handle under
 * it (ADR 0170): the description, the comments and the additional context. Kept on this device for
 * every Task Editor on it, in every graph, like the board's own state (`board-state.ts`): it suits a
 * screen, not a task, so it is never synced. A part with no height kept is drawn at its own.
 *
 * Storage that throws (a private window, blocked site data) keeps nothing and never throws.
 */
import { z } from 'zod'

const KEY = 'etherpk-kanban-task-editor-part-heights'

export type TaskEditorPart = 'description' | 'comments' | 'additionalContext'

const heightsSchema = z.object({
    description: z.number().positive().optional(),
    comments: z.number().positive().optional(),
    additionalContext: z.number().positive().optional(),
})
type Heights = z.infer<typeof heightsSchema>

export interface PartHeights {
    /** The height `part` was last given on this device, in CSS pixels, or null for none. */
    get(part: TaskEditorPart): number | null
    set(part: TaskEditorPart, height: number): void
}

export function createPartHeights(storage: Storage | undefined = globalThis.localStorage): PartHeights {
    function read(): Heights {
        try {
            const raw = storage?.getItem(KEY)
            if (!raw) return {}
            const parsed = heightsSchema.safeParse(JSON.parse(raw))
            return parsed.success ? parsed.data : {}
        } catch {
            return {}
        }
    }
    return {
        get: (part) => read()[part] ?? null,
        set(part, height) {
            try {
                storage?.setItem(KEY, JSON.stringify({ ...read(), [part]: Math.round(height) }))
            } catch {
                // Not kept: the part opens at its own height next time, which loses nothing.
            }
        },
    }
}
