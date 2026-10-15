/**
 * Every [[Agent Chat]] of the open graph on this device, and what is happening in each (ADR 0147).
 *
 * One instance per graph, made when the extension starts. The inline panel, the full-window chat
 * on a phone and the [[Agent Chats View]] all draw from it, so a chat open in two places is one
 * chat: a message sent in either shows in both, and Stop works from either.
 *
 * Chats are kept in the graph's records on this device (`store.ts`) as they change, a streaming
 * answer at most about once a second, and every finished turn at once. A chat is kept from its first
 * question: one closed with nothing asked in it is let go (`discardIfEmpty`), and the lists leave
 * out a chat that has nothing in it yet. The person's Model
 * Connections are read from their records kept with the person, and followed as they change.
 */
import type { ExtensionAssets, ExtensionDocuments, ExtensionPersonStorage, ExtensionStorage, InlinePanel } from '@appsoftwareltd/etherpk-extension-api'
import { SvelteMap } from 'svelte/reactivity'

import { PROVIDERS } from '../providers/catalogue'
import { listModels, type ModelInfo } from '../providers/models'
import { chatOutline } from '../save/outline'
import { type AgentChatSettings, defaultConnection, EMPTY_SETTINGS, type ModelConnection, readSettings } from '../settings/connections'
import { type Chat, type ChatImage, GRANT_ORDER, type GrantLevel, newId, titleFrom, todayOnDevice, type Turn } from './model'
import type { RunTurnInput } from './runner'
import type { ChatStore } from './store'

/** A connection's models, as far as they are known. */
export type ModelList = { status: 'loading' } | { status: 'ready'; models: ModelInfo[] } | { status: 'failed'; error: string }

export interface AgentChatsDeps {
    documents: ExtensionDocuments
    assets: ExtensionAssets
    store: ChatStore
    personStorage: Pick<ExtensionPersonStorage, 'get' | 'subscribe'>
    /** The extension's storage on this device: where model lists are kept for a day. */
    storage: ExtensionStorage
    /** Whether a document of this name exists in the graph now. */
    documentExists(name: string): boolean
    /** Asking a provider for its models; the real one unless a test supplies another. */
    fetchModels?: typeof listModels
    /** Running a turn; the runner, loaded when a chat first sends, unless a test supplies one. */
    runTurn?: (input: RunTurnInput) => Promise<void>
    now?: () => number
}

/** How long a connection's model list is believed before it is asked for again. */
const MODEL_LIST_TTL_MS = 24 * 60 * 60 * 1000
/** How often a streaming answer is written to the device, at most. */
const PERSIST_DELAY_MS = 1000

export class AgentChats {
    chats = $state<Chat[]>([])
    loaded = $state(false)
    /** Why the kept chats could not be read, if they could not. */
    loadError = $state<string | null>(null)
    settings = $state<AgentChatSettings>({ ...EMPTY_SETTINGS })
    /** The chat the Agent Chats View shows in full, or null for its list. */
    selected = $state<string | null>(null)
    /** Each connection's model list, by connection id. */
    readonly models = new SvelteMap<string, ModelList>()
    /** The inline panel each chat is open in, if it is open in one. */
    readonly inline = new SvelteMap<string, InlinePanel>()
    /** The chats whose turn is being answered now. */
    readonly running = new SvelteMap<string, AbortController>()

    /** Bumped when the graph's documents change, so whether a chat is orphaned is asked again. */
    #documentsVersion = $state(0)
    /**
     * The outline around each chat's bullet as last read from its inline panel, so a chat continued
     * in the view after its panel closed sends what it last saw. Kept in memory only: it is note text,
     * and a chat record never holds a copy of a document.
     */
    readonly #outlines = new Map<string, string>()
    readonly #timers = new Map<string, ReturnType<typeof setTimeout>>()
    readonly #deps: AgentChatsDeps
    readonly #stopSettings: () => void

    constructor(deps: AgentChatsDeps) {
        this.#deps = deps
        this.settings = readSettings(deps.personStorage)
        // Connections added or removed here, in another tab, or on another device.
        this.#stopSettings = deps.personStorage.subscribe(() => {
            this.settings = readSettings(deps.personStorage)
        })
    }

    #now(): number {
        return this.#deps.now?.() ?? Date.now()
    }

    async load(): Promise<void> {
        try {
            this.chats = await this.#deps.store.load()
            this.loadError = null
        } catch (error) {
            this.loadError = `The chats kept on this device could not be read: ${error instanceof Error ? error.message : String(error)}`
        } finally {
            this.loaded = true
        }
    }

    /** The graph's documents changed: a home may have been deleted or created. */
    documentsChanged(): void {
        this.#documentsVersion += 1
    }

    get(id: string): Chat | undefined {
        return this.chats.find((chat) => chat.id === id)
    }

    /**
     * Whether a chat's home document is gone, so it can read nothing through it. A chat open in a
     * panel in its own home never is: the home is a Draft there, a document not written yet, which
     * the first Save (or the person's typing) creates.
     */
    isOrphaned(chat: Chat): boolean {
        void this.#documentsVersion
        if (this.#deps.documentExists(chat.home)) return false
        const panel = this.inline.get(chat.id)
        return !(panel?.isOpen && panel.document === chat.home)
    }

    /** Whether a chat's home is a Draft open beside it: not written yet, so it has no text to send. */
    homeUnwritten(chat: Chat): boolean {
        return !this.#deps.documentExists(chat.home) && !this.isOrphaned(chat)
    }

    /** A document's chats with something asked in them, the most recently used first. */
    chatsFor(home: string): Chat[] {
        return this.chats.filter((chat) => chat.turns.length > 0 && chat.home === home && !this.isOrphaned(chat))
    }

    /** The chats with something asked in them whose home document is gone. */
    orphans(): Chat[] {
        return this.chats.filter((chat) => chat.turns.length > 0 && this.isOrphaned(chat))
    }

    /** Let a chat go that has nothing asked in it: it was opened and closed again. */
    discardIfEmpty(id: string): void {
        const chat = this.get(id)
        if (!chat || chat.turns.length > 0 || this.isRunning(id)) return
        this.chats = this.chats.filter((candidate) => candidate.id !== id)
        this.#outlines.delete(id)
        if (this.selected === id) this.selected = null
    }

    /**
     * The grants a chat may use now. An orphaned chat has no document to read. Block siblings and
     * ancestors is offered while the chat is open on a bullet, or has read one this visit, and stays
     * listed while it is the chat's choice, so the picker shows it (`cannotSend` says why it cannot
     * be sent then).
     */
    grantsFor(chat: Chat): GrantLevel[] {
        const model = this.modelInfo(chat)
        const orphaned = this.isOrphaned(chat)
        const block = !orphaned && (chat.grant === 'block' || this.blockOutline(chat.id) !== null)
        return GRANT_ORDER.filter((grant) => {
            if (orphaned && (grant === 'document' || grant === 'links')) return false
            if (grant === 'block' && !block) return false
            return grant !== 'graph' || model === null || model.tools
        })
    }

    /** The outline around a chat's bullet: read now from its open panel, or as it was last read. */
    blockOutline(id: string): string | null {
        const live = this.inline.get(id)?.outline() ?? null
        if (live !== null) this.#outlines.set(id, live)
        return live ?? this.#outlines.get(id) ?? null
    }

    /** Start a chat in `home`, on the default connection and its default model. */
    create(home: string): Chat {
        const connection = defaultConnection(this.settings)
        const chat: Chat = {
            id: newId('chat'),
            title: 'New chat',
            home,
            grant: 'document',
            connectionId: connection?.id ?? null,
            modelId: connection?.defaultModel || null,
            // The person's default, which the chat can change for itself.
            webSearch: this.settings.webSearchByDefault,
            turns: [],
            createdAt: this.#now(),
            updatedAt: this.#now(),
        }
        // Kept on the device from its first question (store.ts), so a chat opened and closed
        // with nothing asked in it leaves nothing behind.
        this.chats = [chat, ...this.chats]
        return this.get(chat.id)!
    }

    rename(id: string, title: string): void {
        const chat = this.get(id)
        const next = title.trim()
        if (!chat || next === '' || next === chat.title) return
        chat.title = next.slice(0, 120)
        this.#touch(chat)
    }

    /** Delete chats from this device, stopping any that are answering. */
    async remove(ids: readonly string[]): Promise<void> {
        for (const id of ids) {
            this.running.get(id)?.abort()
            this.inline.get(id)?.close()
            clearTimeout(this.#timers.get(id))
            this.#timers.delete(id)
        }
        for (const id of ids) this.#outlines.delete(id)
        this.chats = this.chats.filter((chat) => !ids.includes(chat.id))
        if (this.selected !== null && ids.includes(this.selected)) this.selected = null
        await Promise.all(ids.map((id) => this.#deps.store.remove(id)))
    }

    /** Make another document the chat's home: resuming a chat whose home is gone from a document. */
    rehome(id: string, home: string): void {
        const chat = this.get(id)
        if (!chat || chat.home === home) return
        chat.home = home
        this.#touch(chat)
    }

    /** A concept was renamed: chats at home there follow it. */
    conceptRenamed(from: string, to: string): void {
        for (const chat of this.chats) {
            if (chat.home !== from) continue
            chat.home = to
            this.#touch(chat)
        }
    }

    setGrant(id: string, grant: GrantLevel): void {
        const chat = this.get(id)
        if (!chat || chat.grant === grant) return
        chat.grant = grant
        this.#touch(chat)
    }

    setModel(id: string, connectionId: string, modelId: string): void {
        const chat = this.get(id)
        if (!chat) return
        chat.connectionId = connectionId
        chat.modelId = modelId
        // A narrower model may not take tools: the whole graph needs them.
        if (chat.grant === 'graph' && this.modelInfo(chat)?.tools === false) chat.grant = this.isOrphaned(chat) ? 'nothing' : 'links'
        this.#touch(chat)
    }

    setWebSearch(id: string, on: boolean): void {
        const chat = this.get(id)
        if (!chat || chat.webSearch === on) return
        chat.webSearch = on
        this.#touch(chat)
    }

    connectionOf(chat: Pick<Chat, 'connectionId'>): ModelConnection | null {
        return this.settings.connections.find((connection) => connection.id === chat.connectionId) ?? null
    }

    /** What is known about a chat's model, or null while its list is not in. */
    modelInfo(chat: Pick<Chat, 'connectionId' | 'modelId'>): ModelInfo | null {
        if (!chat.connectionId || !chat.modelId) return null
        const list = this.models.get(chat.connectionId)
        if (list?.status !== 'ready') return null
        return list.models.find((model) => model.id === chat.modelId) ?? null
    }

    /** Whether a chat can offer web search: its provider runs a search of its own. */
    canSearchWeb(chat: Pick<Chat, 'connectionId'>): boolean {
        const connection = this.connectionOf(chat)
        return connection !== null && PROVIDERS[connection.provider].webSearch
    }

    /** A connection's models: from the device's copy when it is fresh, else asked for now. */
    modelsFor(connectionId: string, options: { fresh?: boolean } = {}): ModelList | undefined {
        const known = this.models.get(connectionId)
        if (known && !options.fresh && known.status !== 'failed') return known
        const connection = this.settings.connections.find((candidate) => candidate.id === connectionId)
        if (!connection) return undefined
        const kept = this.#deps.storage.get<{ at: number; key: string; models: ModelInfo[] }>(`models:${connectionId}`)
        if (!options.fresh && kept && kept.key === fingerprint(connection) && this.#now() - kept.at < MODEL_LIST_TTL_MS && Array.isArray(kept.models)) {
            const list: ModelList = { status: 'ready', models: kept.models }
            this.models.set(connectionId, list)
            return list
        }
        this.models.set(connectionId, { status: 'loading' })
        void (this.#deps.fetchModels ?? listModels)(connection)
            .then((models) => {
                this.models.set(connectionId, { status: 'ready', models })
                this.#deps.storage.set(`models:${connectionId}`, { at: this.#now(), key: fingerprint(connection), models })
            })
            .catch((error: unknown) => {
                this.models.set(connectionId, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
            })
        return this.models.get(connectionId)
    }

    /**
     * Start reading every connection's model list that is not known yet: called as a chat is shown,
     * so lists are asked for when someone is about to choose a model, never on every graph open.
     */
    loadModels(): void {
        for (const connection of this.settings.connections) this.modelsFor(connection.id)
    }

    isRunning(id: string): boolean {
        return this.running.has(id)
    }

    /** Why a chat cannot send now, in the person's words, or null when it can. */
    cannotSend(chat: Chat): string | null {
        if (this.settings.connections.length === 0) return 'Add a model connection in Settings, Agents, to start chatting.'
        const connection = this.connectionOf(chat)
        if (!connection) return 'Choose a model for this chat.'
        if (!chat.modelId) return 'Choose a model for this chat.'
        if (chat.grant === 'block' && !this.isOrphaned(chat) && this.blockOutline(chat.id) === null) {
            return 'Block siblings and ancestors is read from the bullet this chat is open on. Open the chat there with /Agent, or choose another context.'
        }
        return null
    }

    /** Ask a question in a chat, and stream the answer into a new turn. */
    async send(id: string, question: string, images: ChatImage[] = []): Promise<void> {
        const chat = this.get(id)
        const text = question.trim()
        if (!chat || this.isRunning(id) || (text === '' && images.length === 0) || this.cannotSend(chat) !== null) return
        const connection = this.connectionOf(chat)!
        const modelId = chat.modelId!
        const known = this.modelInfo(chat)
        // A model the list does not know yet is taken to use tools and no images, as a local one is.
        const model: ModelInfo = known ?? { id: modelId, label: modelId, images: images.length > 0, tools: true }
        // An orphaned chat has no document to read: what it may read falls back to nothing.
        const grant: GrantLevel = this.isOrphaned(chat) && (chat.grant === 'block' || chat.grant === 'document' || chat.grant === 'links') ? 'nothing' : chat.grant
        chat.turns.push({
            id: newId('turn'),
            question: text,
            images,
            answer: '',
            connectionId: connection.id,
            modelId,
            modelLabel: model.label,
            grant,
            webSearch: chat.webSearch && this.canSearchWeb(chat),
            tools: [],
            sources: [],
            status: 'streaming',
            askedAt: this.#now(),
            saved: false,
        })
        if (chat.turns.length === 1) chat.title = titleFrom(text)
        await this.#run(chat, chat.turns[chat.turns.length - 1], connection, model)
    }

    /** Answer the last turn again, from nothing: after a failure, a Stop, or an answer not wanted. */
    async retry(id: string): Promise<void> {
        const chat = this.get(id)
        const turn = chat?.turns[chat.turns.length - 1]
        if (!chat || !turn || this.isRunning(id)) return
        const connection = this.connectionOf(chat)
        if (!connection || !chat.modelId) return
        const model: ModelInfo = this.modelInfo(chat) ?? { id: chat.modelId, label: chat.modelId, images: turn.images.length > 0, tools: true }
        Object.assign(turn, { answer: '', tools: [], sources: [], error: undefined, status: 'streaming', saved: false, connectionId: connection.id, modelId: chat.modelId, modelLabel: model.label, askedAt: this.#now() } satisfies Partial<Turn>)
        await this.#run(chat, turn, connection, model)
    }

    /** Stop the answer a chat is streaming. What arrived stays. */
    stop(id: string): void {
        this.running.get(id)?.abort()
    }

    async #run(chat: Chat, turn: Turn, connection: ModelConnection, model: ModelInfo): Promise<void> {
        const controller = new AbortController()
        this.running.set(chat.id, controller)
        this.#touch(chat, true)
        try {
            const run = this.#deps.runTurn ?? (await import('./runner')).runTurn
            await run({
                history: chat.turns.slice(0, -1),
                turn,
                home: chat.home,
                connection,
                model,
                documents: this.#deps.documents,
                block: turn.grant === 'block' ? this.blockOutline(chat.id) : null,
                homeUnwritten: this.homeUnwritten(chat),
                webSearch: turn.webSearch,
                signal: controller.signal,
                prepareImage: (image) => this.#deps.assets.prepareImage(image),
                today: todayOnDevice(),
                changed: () => this.#persist(chat.id),
            })
        } catch (error) {
            // The runner reports its own failures in the turn; this is the runner failing to load.
            turn.status = 'failed'
            turn.error = `The chat could not start: ${error instanceof Error ? error.message : String(error)}. Reload EtherPK and try again.`
        } finally {
            this.running.delete(chat.id)
            this.#touch(chat, true)
        }
    }

    /**
     * Write the chosen turns into the chat's home document through an inline panel, the block the
     * person sees land there, keeping the images as the graph's assets first. `progress` is told
     * how many of the turns' images are kept so far, before the first and after each, since an
     * upload to a Sync Server can take a while. False when the panel could not take it (closed, or
     * a document that cannot be written).
     */
    async save(id: string, turnIds: readonly string[], panel: InlinePanel, progress?: (done: number, total: number) => void): Promise<boolean> {
        const chat = this.get(id)
        if (!chat) return false
        const kept = chat.turns.filter((turn) => turnIds.includes(turn.id))
        if (kept.length === 0) return false
        const imageMarkdown = new Map<string, string>()
        const total = kept.reduce((count, turn) => count + turn.images.length, 0)
        let done = 0
        if (total > 0) progress?.(done, total)
        for (const turn of kept) {
            for (const image of turn.images) {
                const markdown = await this.#deps.assets.saveImage(image.blob, image.name)
                if (markdown) imageMarkdown.set(image.id, markdown)
                progress?.(++done, total)
            }
        }
        if (!panel.insertBlock(chatOutline(kept, { date: todayOnDevice(), imageMarkdown }))) return false
        for (const turn of kept) turn.saved = true
        this.#touch(chat, true)
        return true
    }

    /** Stop every answer, and write what is waiting: the graph is closing or the extension stopping. */
    dispose(): void {
        this.#stopSettings()
        for (const controller of this.running.values()) controller.abort()
        for (const [id, timer] of this.#timers) {
            clearTimeout(timer)
            const chat = this.get(id)
            if (chat) void this.#deps.store.save($state.snapshot(chat) as Chat).catch(() => {})
        }
        this.#timers.clear()
    }

    /** The chat changed: keep it, now or within a second. */
    #touch(chat: Chat, now = false): void {
        chat.updatedAt = this.#now()
        this.#persist(chat.id, now)
    }

    #persist(id: string, now = false): void {
        clearTimeout(this.#timers.get(id))
        this.#timers.delete(id)
        const write = () => {
            this.#timers.delete(id)
            const chat = this.get(id)
            if (!chat) return
            this.#deps.store.save($state.snapshot(chat) as Chat).catch((error: unknown) => {
                console.warn('[agent-chat] a chat could not be kept on this device', error)
            })
        }
        if (now) write()
        else this.#timers.set(id, setTimeout(write, PERSIST_DELAY_MS))
    }
}

/**
 * What a kept model list was fetched for, so a changed key or address asks again. The key goes in
 * as a short hash, so no part of it is copied into the device's model list.
 */
function fingerprint(connection: ModelConnection): string {
    let hash = 0x811c9dc5
    for (const char of connection.apiKey) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0
    return `${connection.provider}|${connection.address}|${hash.toString(36)}`
}
