/**
 * The line above a [[Kanban Board]]'s lanes that says an agent on this computer can work on the
 * board's tasks through the [[Headless Client]], and links to how to set one up. Once a person
 * dismisses it, it stays gone on every board on this device: it is the same line on each.
 *
 * Per device and never synced, like the board's own state (`board-state.ts`). Storage that throws
 * (a private window, blocked site data) shows the line, which is the safe answer.
 */

const KEY = 'etherpk-kanban-agent-hint-dismissed'

export interface AgentHint {
    shown(): boolean
    dismiss(): void
}

export function createAgentHint(storage: Storage | undefined = globalThis.localStorage): AgentHint {
    return {
        shown() {
            try {
                return storage?.getItem(KEY) !== '1'
            } catch {
                return true
            }
        },
        dismiss() {
            try {
                storage?.setItem(KEY, '1')
            } catch {
                // Not remembered: the line comes back on the next board, which loses nothing.
            }
        },
    }
}
