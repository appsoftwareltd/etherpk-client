/**
 * How tall an inline Agent Chat is drawn on a desktop. Its content scrolls inside it, so it changes
 * height only at a few clear points, never while an answer streams: compact while the chat has no
 * question yet, full once it has one, and for the picker as tall as its chats need.
 */
import type { AgentChats } from '../chat/chats.svelte'

/** A chat with turns: room to read an answer. */
export const INLINE_HEIGHT = 460
/**
 * A chat with no question yet: its header, three lines of help (one of them wrapping in a narrow
 * document) and the field, with nothing to scroll.
 */
export const COMPACT_HEIGHT = 312
/** The short line left in the document on a phone. */
export const STUB_HEIGHT = 56

/** The picker's head and headings, and each chat it lists. */
const PICKER_BASE = 132
const PICKER_ROW = 52

/** The height for an opening showing `chatId`, or the picker for `home` when it is null. */
export function openingHeight(chats: AgentChats, chatId: string | null, home: string): number {
    if (chatId === null) return Math.min(INLINE_HEIGHT, PICKER_BASE + PICKER_ROW * (chats.chatsFor(home).length + chats.orphans().length))
    return (chats.get(chatId)?.turns.length ?? 0) > 0 ? INLINE_HEIGHT : COMPACT_HEIGHT
}
