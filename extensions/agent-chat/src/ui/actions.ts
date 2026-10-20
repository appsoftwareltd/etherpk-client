/**
 * What the chat's components ask of the Client, through the extension's context (`register.ts`),
 * so the components know nothing of the context and are drawn the same in each place.
 */
import type { InlinePanel } from '@appsoftwareltd/etherpk-extension-api'

export interface ChatActions {
    /** Open a document by name, as a wikilink does. */
    openDocument(name: string): void
    /** Open the Agents settings, where Model Connections are added. */
    openSettings(): void
    /** Show a chat in the Agent Chats View. */
    openInView(chatId: string): void
    /** Start a chat without a document in the Agent Chats View, and show it there. */
    startWithoutDocument(): void
    /**
     * The inline panel a Save of this chat writes through: the one it is open in, or one opened at
     * the end of its home document, or for a chat without a document of today's Journal Entry, which
     * is opened first. Null when that cannot be done.
     */
    saveTarget(chatId: string): Promise<InlinePanel | null>
}
