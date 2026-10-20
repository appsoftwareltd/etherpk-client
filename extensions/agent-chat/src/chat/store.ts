/**
 * Where an [[Agent Chat]] is kept (ADR 0147): the graph's records on this device
 * (`context.records`), one record per chat under `chat:<id>`. Never synced, and deleted with the
 * graph's data when the graph leaves the device. A record is the chat as plain data, its images as
 * Blobs, so it is stored as the browser's structured clone.
 */
import type { ExtensionGraphRecords } from '@appsoftwareltd/etherpk-extension-api'

import { type Chat, type Exchange, GRANT_ORDER } from './model'

/** The prefix every chat's record key carries. */
export const CHAT_PREFIX = 'chat:'

export interface ChatStore {
    /** Every chat kept for the graph, the most recently changed first. */
    load(): Promise<Chat[]>
    /** Keep a chat, given as plain data (a snapshot, never a reactive proxy). */
    save(chat: Chat): Promise<void>
    remove(id: string): Promise<void>
}

/**
 * A chat as kept before 2026-10-20: its exchanges under `turns`, each with one `saved` flag for the
 * question and answer together. Chats on people's devices are kept in this shape, so it is read.
 */
type KeptChat = Chat & { turns?: Exchange[] }
type KeptExchange = Exchange & { saved?: boolean }

/** Whether a stored value is a chat this Client can show. */
function isChat(value: unknown): value is KeptChat {
    if (typeof value !== 'object' || value === null) return false
    const chat = value as Partial<KeptChat>
    return (
        typeof chat.id === 'string' &&
        typeof chat.title === 'string' &&
        (typeof chat.home === 'string' || chat.home === null) &&
        (Array.isArray(chat.exchanges) || Array.isArray(chat.turns)) &&
        GRANT_ORDER.includes(chat.grant as Chat['grant'])
    )
}

/**
 * A chat as it is shown after a reload: an answer that was streaming when the tab closed did not
 * finish, so it is stopped, and its unfinished tool calls failed. A chat kept in the earlier shape
 * takes the current one, its one saved flag standing for both turns.
 */
function settled(kept: KeptChat): Chat {
    const { turns, ...rest } = kept
    const chat: Chat = { ...rest, exchanges: rest.exchanges ?? turns ?? [] }
    chat.exchanges = chat.exchanges.map((stored) => {
        const { saved, ...exchange } = stored as KeptExchange
        return { ...exchange, questionSaved: exchange.questionSaved ?? saved ?? false, answerSaved: exchange.answerSaved ?? saved ?? false }
    })
    for (const exchange of chat.exchanges) {
        if (exchange.status === 'streaming') exchange.status = 'stopped'
        for (const tool of exchange.tools ?? []) if (tool.status === 'running') tool.status = 'failed'
        exchange.tools ??= []
        exchange.sources ??= []
        exchange.images ??= []
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
                const chat = settled(value)
                if (chat.exchanges.length === 0) await records.remove(key)
                else chats.push(chat)
            }
            return chats.sort((a, b) => b.updatedAt - a.updatedAt)
        },
        save: async (chat) => {
            if (chat.exchanges.length > 0) await records.set(`${CHAT_PREFIX}${chat.id}`, chat)
        },
        remove: (id) => records.remove(`${CHAT_PREFIX}${id}`),
    }
}
