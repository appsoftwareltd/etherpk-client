/**
 * Where an [[Agent Chat]] is kept (ADR 0147): the graph's records on this device
 * (`context.records`), one record per chat under `chat:<id>`. Never synced, and deleted with the
 * graph's data when the graph leaves the device. A record is the chat as plain data, its images as
 * Blobs, so it is stored as the browser's structured clone.
 */
import type { ExtensionGraphRecords } from '@appsoftwareltd/etherpk-extension-api'

import { type Chat, GRANT_ORDER } from './model'

/** The prefix every chat's record key carries. */
export const CHAT_PREFIX = 'chat:'

export interface ChatStore {
    /** Every chat kept for the graph, the most recently changed first. */
    load(): Promise<Chat[]>
    /** Keep a chat, given as plain data (a snapshot, never a reactive proxy). */
    save(chat: Chat): Promise<void>
    remove(id: string): Promise<void>
}

/** Whether a stored value is a chat this Client can show. */
function isChat(value: unknown): value is Chat {
    if (typeof value !== 'object' || value === null) return false
    const chat = value as Partial<Chat>
    return typeof chat.id === 'string' && typeof chat.title === 'string' && typeof chat.home === 'string' && Array.isArray(chat.turns) && GRANT_ORDER.includes(chat.grant as Chat['grant'])
}

/**
 * A chat as it is shown after a reload: a turn that was streaming when the tab closed did not
 * finish, so it is stopped, and its unfinished tool calls failed.
 */
function settled(chat: Chat): Chat {
    for (const turn of chat.turns) {
        if (turn.status === 'streaming') turn.status = 'stopped'
        for (const tool of turn.tools ?? []) if (tool.status === 'running') tool.status = 'failed'
        turn.tools ??= []
        turn.sources ??= []
        turn.images ??= []
    }
    return chat
}

/**
 * The chats kept for a graph. A chat is kept from its first question: one with nothing asked in it
 * is never written, and one left from before that rule is cleared as the chats load.
 */
export function chatStore(records: ExtensionGraphRecords): ChatStore {
    return {
        async load() {
            const keys = (await records.keys()).filter((key) => key.startsWith(CHAT_PREFIX))
            const chats: Chat[] = []
            for (const key of keys) {
                const value = await records.get<unknown>(key)
                if (!isChat(value)) continue
                if (value.turns.length === 0) await records.remove(key)
                else chats.push(settled(value))
            }
            return chats.sort((a, b) => b.updatedAt - a.updatedAt)
        },
        save: async (chat) => {
            if (chat.turns.length > 0) await records.set(`${CHAT_PREFIX}${chat.id}`, chat)
        },
        remove: (id) => records.remove(`${CHAT_PREFIX}${id}`),
    }
}
