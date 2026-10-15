/**
 * Which chat one `/Agent` opening shows, shared by what draws it: on a phone, the small inline stub
 * in the document and the full window over it read the same session, so the stub names the chat
 * the window shows, and Save from the window writes through the stub's place in the document.
 */
export interface ChatSession {
    /** The chat shown, or null while the person picks one. */
    chatId: string | null
}

export function chatSession(chatId: string | null): ChatSession {
    const session = $state<ChatSession>({ chatId })
    return session
}
