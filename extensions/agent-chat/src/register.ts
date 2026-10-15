/**
 * Everything [[Agent Chat]] adds to a graph (ADR 0147), through the context it is started with:
 *
 * - `/Agent` in the Command Menu, and the Command it runs (`agent-chat.open`, also on Alt+A),
 *   which opens a chat beneath the caret's line: inline on a desktop; on a phone, over the whole
 *   window, with a short line in the document where `/Agent` was typed;
 * - the Agent button pinned to the phone's Command Bar, which opens a chat at the caret while the
 *   person is typing in the document, and at its end otherwise;
 * - the [[Agent Chats View]], a resident of the right Sidebar;
 * - what keeps the chats right as the graph changes: a renamed home is followed, and a deleted one
 *   leaves its chats orphaned.
 *
 * The Client takes all of it back when the graph closes or the extension is switched off, and the
 * chats are kept on the device as they change. The Svelte parts arrive as `ui`, so this module is
 * tested in Node without compiling a component.
 */
import type { ExtensionContext, InlinePanel, ViewContribution } from '@appsoftwareltd/etherpk-extension-api'

import { AgentChats } from './chat/chats.svelte'
import type { Chat } from './chat/model'
import { chatStore } from './chat/store'
import type { ChatActions } from './ui/actions'
import { openingHeight, STUB_HEIGHT } from './ui/heights'
import type { ChatSession } from './ui/session.svelte'

export const CHATS_VIEW = 'agent-chat.chats'
export const OPEN_COMMAND = 'agent-chat.open'
/** The workspace's Command that opens a graph's settings at the Agents tab. */
export const AGENTS_SETTINGS_COMMAND = 'agents.settings'

/** What one `/Agent` opening is drawn with. */
export interface OpeningProps {
    chats: AgentChats
    home: string
    session: ChatSession
    where: 'inline' | 'window'
    panel: InlinePanel | null
    actions: ChatActions
    onChoose(chat: Chat): void
    onNew(): void
    onClose(): void
    /** After a Save from the window on a phone: back to the document. */
    onSaved?(): void
}

export interface AgentChatUi {
    /** A session for one opening: which chat it shows. */
    session(chatId: string | null): ChatSession
    /** The Agent Chats View. */
    view(chats: AgentChats, actions: ChatActions, active: { get(): string | null; subscribe(listener: () => void): () => void }): ViewContribution
    /** An opening drawn inline, or over the window. */
    opening(host: HTMLElement, props: OpeningProps): { destroy(): void }
    /** The short line left in the document on a phone. */
    stub(host: HTMLElement, props: { chats: AgentChats; session: ChatSession; onOpen(): void; onClose(): void }): { destroy(): void }
}

/** Resolve once `test` holds, or false after `timeoutMs`. */
function until(test: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const started = Date.now()
        const poll = () => {
            if (test()) resolve(true)
            else if (Date.now() - started > timeoutMs) resolve(false)
            else setTimeout(poll, 50)
        }
        poll()
    })
}

export function registerAgentChat(context: ExtensionContext, ui: AgentChatUi): AgentChats {
    const key = (name: string) => context.concepts.key(name)
    const chats = new AgentChats({
        documents: context.documents,
        assets: context.assets,
        store: chatStore(context.records),
        personStorage: context.personStorage,
        storage: context.storage,
        documentExists: (name) => context.index.allConcepts().some((candidate) => (candidate.kind === 'page' || candidate.kind === 'journal') && candidate.key === key(name)),
    })
    void chats.load()

    // A home deleted or made: whether a chat is orphaned is asked again.
    context.index.onUpdated(() => chats.documentsChanged())
    context.events.on('documents:changed', () => chats.documentsChanged())
    context.events.on('concept:renamed', ({ from, to }) => chats.conceptRenamed(from, to))

    const actions: ChatActions = {
        openDocument: (name) => context.layout.openDocument(name),
        openSettings: () => void context.commands.execute(AGENTS_SETTINGS_COMMAND).catch(() => context.notify('Open Settings, then Agents, to add a model connection.')),
        openInView(chatId) {
            chats.selected = chatId
            context.layout.reveal(CHATS_VIEW)
        },
        async saveTarget(chatId) {
            const open = chats.inline.get(chatId)
            if (open?.isOpen) return open
            const chat = chats.get(chatId)
            if (!chat || chats.isOrphaned(chat)) return null
            // The home document, opened if it is not the one in front, with the chat beneath its
            // last line: where the saved turns land, in view.
            if (context.layout.activeDocument() !== chat.home) {
                context.layout.openDocument(chat.home)
                if (!(await until(() => context.layout.activeDocument() === chat.home, 4000))) return null
                await new Promise((resolve) => setTimeout(resolve, 100))
            }
            return openChat({ at: 'end', chatId, showWindow: false })
        },
    }

    /**
     * Open a chat in the document the person is working in: a new one, or the picker when the
     * document has chats to resume or chats are waiting for a document, or a given chat.
     */
    function openChat(options: { at: 'caret' | 'end' | 'caret-or-end'; chatId?: string; showWindow?: boolean }): InlinePanel | null {
        const home = context.layout.activeDocument()
        if (!home) {
            context.notify('Open a document, then type /Agent in it to start an Agent Chat.')
            return null
        }
        const desktop = context.layout.isDesktop()
        const anything = chats.chatsFor(home).length + chats.orphans().length > 0
        const session = ui.session(options.chatId ?? (anything ? null : chats.create(home).id))
        let panel: InlinePanel | null = null
        let window: { close(): void } | null = null

        const track = () => {
            if (panel && session.chatId) chats.inline.set(session.chatId, panel)
        }
        const onChoose = (chat: Chat) => {
            if (chats.isOrphaned(chat)) chats.rehome(chat.id, home)
            session.chatId = chat.id
            track()
        }
        const onNew = () => {
            session.chatId = chats.create(home).id
            track()
        }
        const openWindow = () => {
            window = context.layout.openWindow({
                title: 'Agent Chat',
                mount: (host, opened) =>
                    ui.opening(host, { chats, home, session, where: 'window', panel, actions, onChoose, onNew, onClose: () => opened.close(), onSaved: () => opened.close() }),
                onClose: () => {
                    window = null
                },
            })
        }

        panel = context.editor.openPanel({
            at: options.at,
            // Compact until the chat has a question, then taller (ChatHost resizes it as that changes).
            height: desktop ? openingHeight(chats, session.chatId, home) : STUB_HEIGHT,
            mount: (host, opened) =>
                desktop
                    ? ui.opening(host, { chats, home, session, where: 'inline', panel: opened, actions, onChoose, onNew, onClose: () => opened.close() })
                    : ui.stub(host, { chats, session, onOpen: openWindow, onClose: () => opened.close() }),
            onClose: () => {
                for (const [chatId, open] of chats.inline) if (open === panel) chats.inline.delete(chatId)
                window?.close()
                // A chat closed with nothing asked in it is not kept.
                if (session.chatId) chats.discardIfEmpty(session.chatId)
            },
        })
        if (!panel) {
            context.notify('An Agent Chat opens beneath a line of a document you can write in: not in a protected document, the frontmatter, a code block or a table.')
            return null
        }
        track()
        if (!desktop && options.showWindow !== false) openWindow()
        panel.focus()
        return panel
    }

    context.views.register(CHATS_VIEW, ui.view(chats, actions, { get: () => context.layout.activeDocument(), subscribe: (listener) => context.events.on('document:active-changed', listener) }))
    context.commands.register(OPEN_COMMAND, (arg) => {
        // The Command Bar's button asks for `caret-or-end`: pressed from outside the text, it has no caret to mean.
        const at = (arg as { at?: unknown } | undefined)?.at === 'caret-or-end' ? 'caret-or-end' : 'caret'
        openChat({ at })
    })
    context.commandBar.register({ id: 'agent-chat.bar', title: 'Agent Chat', icon: 'agent-chat', command: OPEN_COMMAND, args: { at: 'caret-or-end' }, pinned: true })
    context.commandMenu.register({
        id: 'agent-chat.agent',
        title: 'Agent',
        detail: 'Ask a language model about this document',
        icon: 'agent-chat',
        keywords: ['ai', 'chat', 'ask', 'model', 'assistant'],
        when: (editor) => !editor.protectedDocument && editor.bodyWritable,
        command: OPEN_COMMAND,
    })
    try {
        context.keybindings.register({ key: 'Alt+A', command: OPEN_COMMAND, label: 'Ask an agent about this document', group: 'Agent Chat' })
    } catch {
        // Another extension took the chord: /Agent and the command menu still open a chat.
    }
    return chats
}
