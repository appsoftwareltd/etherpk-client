/**
 * Graph-level sync (plan Phase 3 Task 5): one WebSocket per open graph, multiplexing all
 * documents. Owns per-doc engines (created lazily), the reconnect loop, and the graph-root
 * document — a hidden Y.Doc whose `registry` Y.Map (docId → {kind,title?,date?}) and `meta`
 * Y.Map (graph name, settings) are how a blind server's clients discover the doc set.
 *
 * The transport is injected (a `connect(url)` factory) so this unit-tests without real sockets.
 */
import * as Y from 'yjs'
import { currentEpoch, deriveJournalIdSecret, journalDocId, keyringReader, type KeyringSource } from '$lib/crypto'
import { performanceRecorder } from '$lib/diagnostics/performance'
import { SYNC_PROTOCOL_LIMITS, type QuotaErrorCode } from '@appsoftwareltd/etherpk-shared'
import { CACHE_SEED, createDocSync, type DocSync } from './doc-sync'
import type { GraphCache } from './local-cache'
import {
    SyncProtocolMismatchError,
    readServerMessage,
    serializeClientMessage,
    type RelayClientMessage,
} from './messages'
import { createPresenceSession, type PresenceSession } from './presence-session'
import type { SyncTokenSource } from './sync-token'
import { keyRetryDelayMs, reconnectDelayMs, refusalRetryDelayMs, STABLE_CONNECTION_MS } from './reconnect-backoff'
import { type QuickNote, sanitizeQuickNotes } from '$lib/document/quick-notes'
import { sanitizeDictionaryWords } from '$lib/document/spelling/graph-dictionary'
import { type Bookmark, type BookmarksChange, sanitizeBookmarks } from '$lib/document/bookmarks/bookmarks'
import { type GraphTheme, isThemeFilePath, sanitizeGraphTheme } from '$lib/document/publish/theme/graph-theme'
import { sanitizeFavourites } from '$lib/storage/fs/graph-settings'

/** Why a socket closed: the WebSocket close code and reason, when the transport knows them. */
export interface TransportCloseEvent {
    code: number
    reason: string
}

export interface TransportSocket {
    send(data: string): void
    close(): void
    onOpen(cb: () => void): void
    onMessage(cb: (data: string) => void): void
    /** The event is optional so a test transport can simply say "it closed". */
    onClose(cb: (event?: TransportCloseEvent) => void): void
}

/**
 * Why this session stopped syncing for good.
 *
 * - `membership`: the account may no longer reach this graph. The relay closed with 4403 or sent
 *   `membership_revoked`, or the Sync Server refused a sync token with 403: the member left in
 *   another tab, the owner removed them, or the owner deleted the graph.
 * - `credentials`: this device's sign-in is no longer accepted. The Sync Server refused a token
 *   mint with 401 (the account was signed out, its access token revoked, its password reset, or
 *   the account suspended or deleted), or the workspace ended the session itself because another
 *   tab signed out or disconnected. `cause` is the refusal, for the caller to word.
 */
export type SyncAccessLoss = { kind: 'membership' } | { kind: 'credentials'; cause?: unknown }

/**
 * The Sync Server refused this graph's writes on a quota: the owner's plan has ended or cannot
 * be confirmed, or an allowance such as storage is used up. The refused operations stay in the
 * durable outbox and are sent again until the server accepts one.
 */
export interface WriteRefusal {
    /** The allowance the write would have passed; absent when the server did not say. */
    quotaCode?: QuotaErrorCode
}

/** What a synced workspace shows about its sync; see {@link GraphSync.activity}. */
export interface SyncActivity {
    /**
     * `connecting` until the first socket opens, `open` while one is, `reconnecting` after it
     * closed while the next attempt waits, and `ended` once access has ended for good.
     */
    connection: 'connecting' | 'open' | 'reconnecting' | 'ended'
    /** Documents this session holds with outbox operations the relay has not acknowledged. */
    unsentDocuments: number
    /** The server's current refusal of this graph's writes, from the refusal until a write is accepted. */
    refusal: WriteRefusal | null
    /**
     * The graph moved to a Graph Key epoch this device holds no key for yet (ADR 0127): its number,
     * or null. Edits stay on the device until the owner's copy of the key arrives.
     */
    waitingForKey: number | null
}

export interface GraphSyncDeps {
    graphId: string
    rootDocId: string
    /**
     * Ask the relay for every document's live updates, not only the retained ones. A tab
     * retains what it shows and catches the rest up when it opens; a [[Headless Client]] serves
     * an index of the whole graph for as long as it runs, so a page created or edited on another
     * device must reach it live (2026-09-17: a serve that had run for half an hour had not
     * learned of two pages the server had held for ten minutes). An update for a document no
     * engine holds yet creates a synchronised engine, which catches its history up on its own.
     */
    subscribeAll?: boolean
    /**
     * The graph's keyring, or a getter for the current one: a session that can follow a new Graph
     * Key epoch (ADR 0127) passes a getter together with `refreshKeyring`.
     */
    keyring: KeyringSource
    /**
     * Collect this account's copy of the graph's newest keyring (ADR 0127), after which `keyring`
     * returns it. Called when the relay announces a new epoch, refuses a write as sealed under an
     * older one, or an update needs an epoch the keyring lacks. Absent, the session cannot follow a
     * new epoch and says it is waiting for the key.
     */
    refreshKeyring?: () => Promise<void>
    relayUrl: string
    /**
     * Asked for a token on every connect, NOT captured once: a session outlives its
     * token's 15 minutes, and a reconnect carrying an expired one is rejected forever.
     */
    token: SyncTokenSource
    cache: GraphCache
    connect(url: string): TransportSocket
    debounceMs?: number
    /** Called whenever the registry Y.Map changes (membership of the doc set). */
    onRegistryChange?: () => void
    /** Passed to every document engine - see `DocSyncDeps.collectRowWhen`. */
    collectRowWhen?: (doc: Y.Doc) => boolean
    /**
     * This device's PREFERRED identity for the awareness `user` field — what y-codemirror
     * renders a remote caret's colour and name from. Absent ⇒ collaborators all show as
     * the library's default-blue "Anonymous". The per-session allocator owns the colour
     * actually advertised (presence-session.ts): the preference is kept when free and
     * deterministically moved when an earlier live session already shows it.
     */
    presence?: { name: string; color: string; colorLight?: string }
    /** Surfaces cache quota and transport failures to the owning workspace. */
    onError?: (error: Error) => void
    /**
     * Called once when access ends for good (see {@link SyncAccessLoss}). The session has already
     * closed its socket and will not reconnect; unacknowledged local changes stay in the durable
     * outbox. The owner decides what the person is told and whether anything is kept.
     */
    onAccessLost?: (loss: SyncAccessLoss) => void
    /** The wait before reconnect attempt `attempt`; a test swaps it. See reconnect-backoff.ts. */
    retryDelayMs?: (attempt: number) => number
    /** The wait before retry round `round` of a refused write; a test swaps it. See reconnect-backoff.ts. */
    refusalRetryDelayMs?: (round: number) => number
    /** The wait before asking again for a new epoch's key; a test swaps it. See reconnect-backoff.ts. */
    keyRetryDelayMs?: (round: number) => number
    /**
     * Where the canonical [[Graph Name]] goes so devices that never opened this graph can
     * label it: the Sync Server's name envelope (ADR 0031, amended 2026-09-17;
     * graph-name-envelope.ts builds the callback). Called with the name once the root document
     * has caught up, then on every change, local or remote, and never twice with the same
     * value. Absent, the session publishes nothing.
     */
    publishName?: (name: string) => void
}

export interface RegistryEntry {
    kind: 'journal' | 'page'
    title?: string
    date?: string
    /**
     * Alternative names resolving to this document ([[Alias]]). Identity lives here (ADR 0024),
     * so this is where a rename's "keep the old name working" arm puts the old name (ADR 0037).
     * The document's [[Frontmatter]] shows them, in a block added for them if it has none
     * (ADR 0061, amended 2026-10-03).
     */
    aliases?: string[]
}

/**
 * The root doc's `meta` Y.Map: the [[Graph Name]] (identity metadata — one canonical,
 * any-member-writable name) and the shared [[Graph Settings]] object. Both are content:
 * encrypted like everything else, so the blind server never sees them.
 */
export interface GraphMeta {
    name?: string
    /** GraphSettings-shaped; consumers sanitize (storage/fs/graph-settings). */
    settings?: Record<string, unknown>
}

/** What a caller knows about a change to a member's [[Favourite]]s beyond the next list. */
export interface FavouritesReplaceChange {
    /**
     * The one favourite a move put somewhere else. Only that entry is deleted and re-inserted,
     * so a concurrent removal of any other entry on another device stays removed.
     */
    moved?: string
    /**
     * The shared Graph Settings favourites the person's list was shown joined with, when it is
     * not seeded yet (ADR 0159). The write then marks the list seeded, with this as the shared
     * list it saw, in the same transaction, so the seed never runs again over a list the person
     * has already changed. Ignored once the list is seeded.
     */
    seedFrom?: readonly string[]
}

/** A list of [[Quick Note]]s held in one root-doc Y.Array (ADR 0078, ADR 0159). */
export interface QuickNotesList {
    /** Every well-formed note, in array order (the View sorts by `createdAt`). */
    list(): QuickNote[]
    add(note: QuickNote): void
    remove(ids: readonly string[]): void
    /** Fires on any change to the array (local or remote). Returns an unsubscribe. */
    observe(listener: () => void): () => void
}

export interface GraphSync {
    readonly rootDoc: Y.Doc
    docSync(docId: string): DocSync
    retainDoc(docId: string): () => void
    /** Queue an ordered, durable lifecycle delete before the encrypted registry changes. */
    deleteDoc(docId: string): Promise<void>
    /** Drop deleted content from a document's cache row - after protecting it (ADR 0057). */
    compactDoc(docId: string): Promise<void>
    /**
     * Upload a consolidated encrypted snapshot of a document to the relay now, rather than
     * waiting for the idle trigger; the engine reads it back and verifies it (ADR 0025).
     */
    uploadSnapshot(docId: string): Promise<void>
    registry(): Y.Map<RegistryEntry>
    /**
     * The document id of the [[Journal Entry]] for a day (`YYYY-MM-DD`), derived from the graph's
     * epoch 1 key (ADR 0157), so every device that starts the day writes into one document.
     */
    journalDocId(date: string): Promise<string>
    /** Snapshot of the root doc's `meta` map (graph name + shared settings). */
    getMeta(): GraphMeta
    setMetaName(name: string): void
    setMetaSettings(settings: Record<string, unknown>): void
    /** Fires on any `meta` change (local or remote). Returns an unsubscribe. */
    onMetaChange(listener: () => void): () => void
    /**
     * The graph's [[Quick Note]]s: the root doc's `quickNotes` Y.Array (ADR 0078). Its own
     * container rather than a field of `meta.settings`, because an array of elements merges
     * concurrent inserts from two devices where a whole-object setting would keep one and
     * drop the other. Encrypted like the rest of the root doc.
     */
    quickNotes(): QuickNotesList
    /**
     * One member's [[Quick Note]]s: the root doc's top-level `quickNotes:<memberKey>` Y.Array
     * (ADR 0159), the same shape as {@link quickNotes}. The shared `quickNotes` array above has no
     * author, so it stays as the legacy list the workspace shows to the Owner only.
     */
    quickNotesOf(memberKey: string): QuickNotesList
    /**
     * One member's [[Favourite]]s: the root doc's top-level `favourites:<memberKey>` Y.Array of
     * concept names, in Sidebar order (ADR 0159). Top-level for the reason bookmarks are.
     */
    favourites(memberKey: string): {
        /** The list deduped case-insensitively (first spelling kept) and capped, as Graph Settings reads it. */
        list(): string[]
        /**
         * Make the array hold `next`, writing only the difference in one transaction: entries no
         * longer present are deleted and new ones inserted at their positions, a move being a
         * delete and an insert. Never a clear-and-refill, which would drop a concurrent add from
         * another device of the same person. With `change.moved`, and when that move is the whole
         * difference, only the moved entry is deleted and re-inserted.
         */
        replace(next: readonly string[], change?: FavouritesReplaceChange): void
        /**
         * The first-open copy (ADR 0159 decision 4): unless this member's `memberFlags:<memberKey>`
         * map says it already ran, append every `shared` favourite the list does not hold and
         * record that it ran, in one transaction. True when it ran. Recorded even when nothing
         * was copied, so a list the person empties later is never refilled. Records `shared` as
         * the shared list it saw, for {@link followShared}.
         */
        seedOnce(shared: readonly string[]): boolean
        /** True once the first-open copy ran, on this device or on another of the person's. */
        seeded(): boolean
        /**
         * Follow the shared list after the seed (ADR 0159): append every `shared` favourite that
         * was not in the shared list last seen and that the person does not hold, then record
         * `shared` as seen, in one transaction. An older Client still writes the shared list, so
         * this is how its additions reach the person. Its removals are not followed: the person's
         * list is theirs. A list seeded with no record of what it saw takes `shared` as seen and
         * adds nothing. False, with nothing written, before the seed or when nothing changed.
         */
        followShared(shared: readonly string[]): boolean
        /**
         * Fires on any change to this member's array or flags (local or remote): the seed flag
         * decides which list the person sees. Returns an unsubscribe.
         */
        observe(listener: () => void): () => void
    }
    /**
     * Empty the per-member lists (`favourites:`, `quickNotes:`, `bookmarks:`, `memberFlags:`) of
     * every member key not in `activeMemberKeys` (ADR 0159 decision 5: the Owner's Client
     * deletes a departed Member's lists). Returns the names of the types it emptied. An empty
     * `activeMemberKeys` clears nothing: a graph always has its Owner, so an empty roster means
     * the roster was not read.
     */
    clearDepartedMembers(activeMemberKeys: readonly string[]): string[]
    /**
     * Rewrite the concepts a [[Rename]] moved in every member's `favourites:` and `bookmarks:`
     * types, in one transaction (ADR 0159). Concept names are graph content every member can read,
     * so the renaming Client updates them all: a Member whose devices never saw the old name could
     * not follow it themselves. Matched case-insensitively. Each entry moves at most once, by the
     * first move that names it, so a move to a name another move starts from is not applied twice.
     *
     * The shared Graph Settings `favourites` move too, and with them each member's record of the
     * shared list they last saw (`sharedFavouritesSeen`). No upgraded Client writes the shared list
     * for a person's own change, but a Member who seeds later copies it, and `followShared`
     * compares it with that record: a dead name would be copied, and a new one read as a favourite
     * added. Returns the names of the types it changed (`meta` for the shared list), none when
     * nothing matched.
     */
    renameConceptInMemberLists(moves: readonly { from: string; to: string }[]): string[]
    /**
     * Every concept any member has bookmarked, once each as first spelt, read from every member's
     * `bookmarks:` map: the pages the protected-page sweep has to judge (ADR 0159).
     */
    bookmarkedConcepts(): string[]
    /**
     * Remove from every member's `bookmarks:` map each bookmark whose concept is one of `concepts`,
     * case-insensitively, in one transaction. A page that became a [[Protected Document]] keeps no
     * bookmark of anyone's (ADR 0159): each holds a line of its text in the clear, where every
     * member can read it. Returns the names of the maps it changed, none when nothing matched.
     */
    removeBookmarksOn(concepts: readonly string[]): string[]
    /**
     * The graph's [[Graph Dictionary]]: the root doc's `spellingDictionary` Y.Map of word ->
     * `true` (ADR 0095). A map of its own for the reason quick notes are an array of their own:
     * two devices adding words while apart both keep them. Encrypted like the rest of the root doc.
     */
    spellingDictionary(): {
        /** Every well-formed word, deduped and capped. */
        list(): string[]
        add(word: string): void
        remove(words: readonly string[]): void
        /** Fires on any change to the map (local or remote). Returns an unsubscribe. */
        observe(listener: () => void): () => void
    }
    /**
     * One member's [[Bookmark]]s: the root doc's top-level `bookmarks:<memberKey>` Y.Map of
     * bookmark id -> a Y.Map of that bookmark's fields (ADR 0159). Field by field, so a change to
     * one field on one device and to another field on another device both stay, and a bookmark
     * one device deleted is not brought back by an anchor update from another. A bookmark is the person's own, so
     * each member has a map of their own, which no other member's Client lists. Top-level rather
     * than nested under one shared map: two devices that each created a nested map under the same
     * key while apart would keep only one of them, where a top-level named type is the same type
     * on every device and its entries merge. Encrypted like the rest of the root doc.
     */
    bookmarks(memberKey: string): {
        /** Every well-formed bookmark, oldest first. */
        list(): Bookmark[]
        /** Put and remove entries by id, in one transaction, so peers see one change. */
        apply(change: BookmarksChange): void
        /** Fires on any change to this member's map (local or remote). Returns an unsubscribe. */
        observe(listener: () => void): () => void
    }
    /**
     * The graph's [[Theme]]s: the root doc's `themes` Y.Map (ADR 0082), theme id → a Y.Map of
     * the theme's fields with its files as a nested Y.Map of path → text. Per-file entries so a
     * save writes one file's text whole and two members editing different files of one theme
     * both keep their edits; a lost concurrent edit to the same file is visible and rare, unlike
     * the note loss ADR 0078 avoids. Encrypted like the rest of the root doc.
     */
    themes(): {
        list(): GraphTheme[]
        get(id: string): GraphTheme | null
        /** Write a whole theme: every file, replacing any it no longer has. */
        put(theme: GraphTheme): void
        /** Write one file's text. */
        putFile(id: string, path: string, text: string): void
        removeFile(id: string, path: string): void
        remove(id: string): void
        /** Fires on any change to any theme (local or remote). Returns an unsubscribe. */
        observe(listener: () => void): () => void
    }
    /** Resolves once the socket has opened (first connect). Short-lived flows need this
     *  before flushing — a flush into a never-opened socket dies with dispose. */
    connected(): Promise<void>
    /** Resolves once the ROOT doc's current catch-up reaches its terminal relay page. */
    rootCaughtUp(): Promise<void>
    /** Fires whenever ANY document's content (Y.Doc) changes — local or remote. The docId is
     *  the graph-root id for registry changes, else the content doc id. */
    onDocUpdate(listener: (docId: string) => void): () => void
    ready(): Promise<void>
    /**
     * Resolves when ONE doc's engine has seeded from the [[Local Cache]] (creating the
     * engine if needed). This is what lets an opened document show "loading" instead of
     * sitting silently empty while the background materialisation walk is still running.
     */
    whenReady(docId: string): Promise<void>
    /**
     * Hydrate a cold-index batch from the Local Cache without starting relay catch-up.
     * The caller must later promote stale documents through normal synchronized readiness.
     * Holds each engine until the caller's matching {@link retireDocs}, which the caller makes
     * whether or not this resolves.
     */
    seedDocsFromCache(docIds: readonly string[]): Promise<readonly Y.Doc[]>
    /**
     * Seed only this batch, without re-awaiting every engine created earlier. Holds each engine
     * until the caller's matching {@link retireDocs}, which the caller makes whether or not this
     * resolves.
     */
    readyDocs(docIds: readonly string[]): Promise<void>
    /**
     * Release background-only engines once their batch consumer has read them. Each call
     * releases one hold from {@link seedDocsFromCache} or {@link readyDocs}; an engine is retired
     * only once no batch walk holds it and nothing retains it.
     */
    retireDocs(docIds: readonly string[]): void
    /** Resolves after ONE doc's first relay page is applied, for presentation readiness. */
    firstCatchupPageDoc(docId: string): Promise<void>
    /** Resolves at the terminal page of ONE doc's current catch-up cycle. */
    caughtUpDoc(docId: string): Promise<void>
    /**
     * Compare the Local Cache with one bounded relay metadata request per batch. Warm indexes
     * only materialise documents whose server watermark actually moved while this browser
     * was away.
     */
    docsNeedingCatchup(docIds: readonly string[]): Promise<string[]>
    /**
     * Cache rows which changed after the last explicit index commit. The acknowledgement
     * closure clears only the exact tokens captured by this call.
     */
    pendingIndexChanges(): Promise<GraphIndexCheckpoint>
    /** Whether the relay socket is open right now — gate anything that waits on the server. */
    isConnected(): boolean
    /** The connection, the unacknowledged documents and any refusal, as of now. */
    activity(): SyncActivity
    /** Fires, coalesced, whenever {@link activity} may have changed. Returns an unsubscribe. */
    onActivity(listener: (activity: SyncActivity) => void): () => void
    /**
     * Send every write the server refused again now, rather than at the next retry round: the
     * person came back to the tab, or said to try again, after restarting a plan.
     */
    retryRefused(): void
    /**
     * Connect now, in place of a retry the backoff is waiting out, and start the backoff again:
     * the browser reports the network is back, or the person came back to the tab. Does nothing
     * while a socket is open or being made, or once the session has ended.
     */
    reconnectNow(): void
    /**
     * Encrypt and send every pending update. On a large [[Import]] this is where the minutes
     * go, so it reports as each document's engine finishes - without it the Activity sat at
     * "0 of 2401" until the first acknowledgement arrived, looking hung.
     */
    flushAll(options?: { onProgress?: (flushed: number, total: number) => void }): Promise<void>
    /**
     * Wait until the server has acknowledged every operation in the durable outbox.
     *
     * `flushAll()` only gets bytes as far as `socket.send`; it never waited for the relay.
     * Anything that must not claim "the server has it" - an [[Import]] declaring itself
     * done, before the socket is disposed - has to wait here instead.
     *
     * Resolves `settled: false` when no ack has arrived for `stallMs`: the caller decides
     * what a stall means. It is NOT an error - unacked updates are already in the
     * durable outbox and replay on the next open, so a stall is a weaker claim, not a loss.
     */
    awaitAcked(options?: AwaitAckedOptions): Promise<AckResult>
    diagnostics(): { activeEngines: number; retainedDocuments: number }
    /**
     * Stop syncing for good because access ended, as if the relay had said so: for what the
     * relay cannot see, such as another tab of this browser signing out. Idempotent.
     */
    endAccess(loss: SyncAccessLoss): void
    /** Why access ended, or null while the session may still sync. */
    accessLoss(): SyncAccessLoss | null
    dispose(): void
}

export interface GraphIndexCheckpoint {
    docIds: readonly string[]
    /** Root bytes merged from durable cache and this tab's live CRDT, for identity mapping. */
    rootUpdate: Uint8Array | null
    /**
     * Read content at least as new as the captured cache token. A dirty missing row is a
     * deletion tombstone and deliberately does not fall back to a stale live engine.
     */
    readDocument(docId: string): Promise<Uint8Array | null>
    acknowledge(): Promise<void>
}

export interface AwaitAckedOptions {
    /** Called with the number of appends still outstanding, whenever that number falls. */
    onProgress?: (outstanding: number) => void
    signal?: AbortSignal
    /** Give up after this long with no ack at all. Default 30s. */
    stallMs?: number
}

export interface AckResult {
    /** True when everything was acked; false when the wait gave up on a stall or a refusal. */
    settled: boolean
    /** Appends still unacked (0 when `settled`). */
    outstanding: number
    /** Set when the server is refusing this graph's writes: why the outstanding ones were not acked. */
    refused?: WriteRefusal
}

/** The HTTP status a token source's refusal carries (SyncApiError, ManagedTokenError), if any. */
function refusalStatus(error: unknown): number | undefined {
    const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined
    return typeof status === 'number' ? status : undefined
}

/**
 * A bookmark's fields as its Y.Map stores them: only its own fields, and none that is undefined,
 * which Yjs cannot encode. A caller's object may carry more (a spread of a wider type).
 */
function bookmarkFields(bookmark: Bookmark): Record<string, string | number> {
    const out: Record<string, string | number> = {
        id: bookmark.id,
        concept: bookmark.concept,
        line: bookmark.line,
        text: bookmark.text,
        createdAt: bookmark.createdAt,
    }
    if (bookmark.before !== undefined) out.before = bookmark.before
    if (bookmark.after !== undefined) out.after = bookmark.after
    if (bookmark.label !== undefined) out.label = bookmark.label
    return out
}

/** The fields a bookmark may lack. A put without one deletes it from the stored bookmark. */
const OPTIONAL_BOOKMARK_FIELDS = ['before', 'after', 'label'] as const

/**
 * Write `bookmark` into one member's bookmarks map, field by field (ADR 0159). Each bookmark is a
 * nested Y.Map of its fields, so two devices that change different fields (a label here, an
 * anchor there) both keep their change, and a field set inside a bookmark another device deleted
 * is dropped with it. Only the fields that differ are set. The nested map is created once, when
 * the id is new: ids are random UUIDs, so two devices never create a map under one id.
 */
function putBookmark(map: Y.Map<unknown>, bookmark: Bookmark): void {
    const fields = bookmarkFields(bookmark)
    const held = map.get(bookmark.id)
    if (!(held instanceof Y.Map)) {
        // A new id, or one written as a plain object before bookmarks were maps of fields.
        const entry = new Y.Map<unknown>()
        for (const [field, value] of Object.entries(fields)) entry.set(field, value)
        map.set(bookmark.id, entry)
        return
    }
    for (const [field, value] of Object.entries(fields)) if (held.get(field) !== value) held.set(field, value)
    for (const field of OPTIONAL_BOOKMARK_FIELDS) if (!(field in fields) && held.has(field)) held.delete(field)
}

/** One stored bookmark as a plain object for {@link sanitizeBookmarks}: a nested map, or an older plain value. */
function storedBookmark(value: unknown): unknown {
    return value instanceof Y.Map ? value.toJSON() : value
}

/** The per-member list types in the root doc (ADR 0159), each named `<kind>:<memberKey>`. */
const MEMBER_LIST_KINDS = ['favourites', 'quickNotes', 'bookmarks', 'memberFlags'] as const
type MemberListKind = (typeof MEMBER_LIST_KINDS)[number]
/** Which Yjs type each kind is, so a type received but never asked for by name is read as the right one. */
const MEMBER_LIST_IS_ARRAY: Record<MemberListKind, boolean> = { favourites: true, quickNotes: true, bookmarks: false, memberFlags: false }

/** `kind` and member key of a per-member type's name, or null for any other root-doc type. */
function memberListName(name: string): { kind: MemberListKind; memberKey: string } | null {
    const colon = name.indexOf(':')
    if (colon <= 0 || colon === name.length - 1) return null
    const kind = name.slice(0, colon)
    if (!(MEMBER_LIST_KINDS as readonly string[]).includes(kind)) return null
    return { kind: kind as MemberListKind, memberKey: name.slice(colon + 1) }
}

/** An empty member key would name one list every member shares: the opposite of a per-person list. */
function requireMemberKey(memberKey: string, what: string): void {
    if (memberKey === '') throw new Error(`${what}: a member key is required`)
}

/** The concept of one stored bookmark: a nested map's field, or an older plain value's. */
function storedBookmarkConcept(value: unknown): unknown {
    return value instanceof Y.Map ? value.get('concept') : (value as { concept?: unknown } | null)?.concept
}

/**
 * Whether `transaction` removed a bookmark from any member's `bookmarks:` map, here or in an update
 * from the relay: a key of one of those top-level maps that now holds nothing, or a deleted item. A
 * field changed inside one bookmark (an anchor written back) is not a removal.
 */
function removedBookmark(doc: Y.Doc, transaction: Y.Transaction): boolean {
    for (const [name, type] of doc.share) {
        if (memberListName(name)?.kind !== 'bookmarks') continue
        const keys = transaction.changed.get(type)
        if (!keys) continue
        for (const key of keys) {
            if (key === null) continue
            const item = type._map.get(key)
            if (item === undefined || item.deleted) return true
        }
    }
    return false
}

/**
 * `list` with each name that `target` moves replaced, or null when it is not a list or nothing in
 * it moved. Entries that are not names are kept as they are.
 */
function renamedNames(list: unknown, target: (concept: unknown) => string | undefined): unknown[] | null {
    if (!Array.isArray(list)) return null
    let moved = false
    const next = list.map((entry) => {
        const to = target(entry)
        if (to === undefined || to === entry) return entry
        moved = true
        return to
    })
    return moved ? next : null
}

/**
 * The indexes of `current` and of `next` that a longest common subsequence pairs up: the entries
 * a minimal edit keeps where they are. Quadratic, which is fine for lists capped at a few hundred.
 *
 * When several subsequences are equally long, the one that keeps the most entries at the same
 * index in both lists is chosen. A kept entry keeps its Yjs item, and a deleted and re-inserted
 * one is a new item that a concurrent removal on another device does not reach. An entry that
 * did not move is the least surprising one to keep.
 */
function keptPairs(current: readonly unknown[], next: readonly string[]): { keptCurrent: Set<number>; keptNext: Set<number> } {
    const n = current.length
    const m = next.length
    // lengths[i][j]: the LCS length of current[i..] and next[j..]. inPlace[i][j]: of the LCSs
    // that long, the most pairs whose two indexes are equal.
    const lengths = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
    const inPlace = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
    // Which of the three moves at (i, j) gives the best (length, inPlace) pair.
    const better = (al: number, ap: number, bl: number, bp: number) => al > bl || (al === bl && ap > bp)
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            let length = lengths[i + 1][j]
            let place = inPlace[i + 1][j]
            if (better(lengths[i][j + 1], inPlace[i][j + 1], length, place)) {
                length = lengths[i][j + 1]
                place = inPlace[i][j + 1]
            }
            if (current[i] === next[j]) {
                const matchLength = lengths[i + 1][j + 1] + 1
                const matchPlace = inPlace[i + 1][j + 1] + (i === j ? 1 : 0)
                if (better(matchLength, matchPlace, length, place) || (matchLength === length && matchPlace === place)) {
                    length = matchLength
                    place = matchPlace
                }
            }
            lengths[i][j] = length
            inPlace[i][j] = place
        }
    }
    const keptCurrent = new Set<number>()
    const keptNext = new Set<number>()
    let i = 0
    let j = 0
    while (i < n && j < m) {
        const same = (l: number, p: number) => l === lengths[i][j] && p === inPlace[i][j]
        if (current[i] === next[j] && same(lengths[i + 1][j + 1] + 1, inPlace[i + 1][j + 1] + (i === j ? 1 : 0))) {
            keptCurrent.add(i++)
            keptNext.add(j++)
        } else if (same(lengths[i + 1][j], inPlace[i + 1][j])) i++
        else j++
    }
    return { keptCurrent, keptNext }
}

/**
 * Make `array` hold exactly `next` with the fewest deletes and inserts, in one transaction. The
 * entries both share in order stay put, so a concurrent insert on another device keeps a
 * neighbour to merge against and survives. A clear-and-refill would delete it with the rest.
 */
function replaceStrings(doc: Y.Doc, array: Y.Array<unknown>, next: readonly string[]): void {
    const current = array.toArray()
    const { keptCurrent, keptNext } = keptPairs(current, next)
    if (keptCurrent.size === current.length && keptNext.size === next.length) return
    doc.transact(() => {
        // Highest index first, so earlier deletions do not shift the later ones.
        for (let i = current.length - 1; i >= 0; i--) if (!keptCurrent.has(i)) array.delete(i, 1)
        // The array now holds the kept entries in `next` order. Insert the rest between them.
        for (let j = 0; j < next.length; j++) if (!keptNext.has(j)) array.insert(j, [next[j]])
    })
}

/**
 * Make `array` hold `next` by moving the one entry `moved` names, when that is the whole
 * difference: delete it and insert it at its new index, in one transaction. Every other entry
 * keeps its Yjs item. The two orders alone cannot say which entry moved (Kitchen up one and
 * Garden down one give the same list), and a guess that re-inserts the wrong entry would undo a
 * removal of it made on another device. False, with nothing written, when the lists differ in
 * any other way.
 */
function moveString(doc: Y.Doc, array: Y.Array<unknown>, next: readonly string[], moved: string): boolean {
    const key = moved.trim().toLowerCase()
    const current = array.toArray()
    const from = current.findIndex((entry) => typeof entry === 'string' && entry.trim().toLowerCase() === key)
    const to = next.findIndex((entry) => entry.toLowerCase() === key)
    if (from === -1 || to === -1) return false
    const rest = current.filter((_, i) => i !== from)
    const nextRest = next.filter((_, i) => i !== to)
    if (rest.length !== nextRest.length || rest.some((entry, i) => entry !== nextRest[i])) return false
    if (from === to) return true
    doc.transact(() => {
        array.delete(from, 1)
        array.insert(to, [next[to]])
    })
    return true
}

/** A {@link QuickNotesList} over one root-doc Y.Array. */
function quickNotesOver(doc: Y.Doc, array: Y.Array<unknown>): QuickNotesList {
    return {
        list: () => sanitizeQuickNotes(array.toArray()),
        add(note) {
            array.push([{ id: note.id, text: note.text, createdAt: note.createdAt }])
        },
        remove(ids) {
            // Highest index first, in one transaction, so earlier deletions do not shift
            // the indexes of later ones and peers see one change rather than several.
            const gone = new Set(ids)
            const items = array.toArray()
            if (!items.some((item) => gone.has(noteId(item) ?? ''))) return
            doc.transact(() => {
                for (let i = items.length - 1; i >= 0; i--) {
                    const id = noteId(items[i])
                    if (id !== undefined && gone.has(id)) array.delete(i, 1)
                }
            })
        },
        observe(listener) {
            array.observe(listener)
            return () => array.unobserve(listener)
        },
    }
}

function noteId(item: unknown): string | undefined {
    const id = typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined
    return typeof id === 'string' ? id : undefined
}

/** How long activity changes are gathered before listeners hear them: an import acks thousands. */
const ACTIVITY_COALESCE_MS = 50

/**
 * How many documents may have an operation (append, delete, resurrect) awaiting the relay's answer
 * at once. The relay handles one connection's messages in turn and closes it once 256 are queued
 * (ws-handler's MAX_QUEUED_MESSAGES). Each document has at most one operation in flight, but a
 * flush or a reconnect across an imported vault would otherwise send every document's at once and
 * be cut off, then again on each reconnect. Half the relay's limit leaves room for catch-ups,
 * subscriptions and presence.
 */
export const OPERATION_WINDOW = 128

/** Internal signal: a watermark request is safe to repeat on the next socket generation. */
class WatermarkConnectionInterruptedError extends Error {}

/**
 * The relay did not answer in time: the socket reads open, but nothing reaches the server, as on a
 * connection that dropped without closing. Named so a caller can say "can't reach the Sync Server"
 * rather than repeat the protocol's words.
 */
export class RelayUnansweredError extends Error {}

export function createGraphSync(deps: GraphSyncDeps): GraphSync {
    const engines = new Map<string, DocSync>()
    const retained = new Map<string, number>([[deps.rootDocId, 1]])
    const retiring = new Set<string>()
    /**
     * Batch walks holding an engine: one count per `seedDocsFromCache` or `readyDocs` not yet
     * matched by a `retireDocs`. Walks overlap - a publish's read, the Local Mirror's pass and
     * the index's catch-up can all be over the same document - so a count decides retirement.
     * With a plain flag, the first walk to finish would retire the engine while another still
     * waited on its catch-up; the catch-up's completion would destroy it, the waiter's
     * `caughtUpDoc` would resolve, and the waiter would read the empty engine created in its
     * place (a cold `etherpk-mcp publish` would read every page as empty and "settled").
     */
    const batchHolds = new Map<string, number>()
    function holdForBatch(docIds: readonly string[]): void {
        for (const docId of docIds) {
            if (docId === deps.rootDocId) continue
            batchHolds.set(docId, (batchHolds.get(docId) ?? 0) + 1)
        }
    }
    /**
     * Wait for a held batch's cache reads. The holds stay taken whether or not they succeed: the
     * caller releases the batch it asked for, once, in its own `finally`. Releasing here as well
     * would release a failed batch twice, and the second release would take the hold of another
     * walk over the same document.
     */
    async function awaitHeld(docIds: readonly string[]): Promise<void> {
        await Promise.all(docIds.map((docId) => readied.get(docId) ?? Promise.resolve()))
    }
    /** One hold per document back; an engine no walk holds or retains is retired once idle. */
    function releaseBatch(docIds: readonly string[]): void {
        for (const docId of docIds) {
            if (docId === deps.rootDocId) continue
            const holds = (batchHolds.get(docId) ?? 0) - 1
            if (holds > 0) {
                // Another walk still holds it: that walk's retirement is the one that counts.
                batchHolds.set(docId, holds)
                continue
            }
            batchHolds.delete(docId)
            if (retained.has(docId)) continue
            retiring.add(docId)
            retireEngineIfIdle(docId)
        }
    }
    const presenceSession: PresenceSession | undefined = deps.presence
        ? createPresenceSession({
              name: deps.presence.name,
              color: deps.presence.color,
              colorLight: deps.presence.colorLight ?? `${deps.presence.color}33`,
          })
        : undefined
    const presenceDetach = new Map<string, () => void>()
    const docUpdateListeners = new Set<(docId: string) => void>()
    // ack carries only outboxId (no docId); remember which doc issued each append so an
    // ack routes back to the right engine.
    const ackRoute = new Map<string, string>()
    let socket: TransportSocket | undefined
    let open = false
    let disposed = false
    /** Set once access has ended for good; nothing reconnects after it. */
    let lost: SyncAccessLoss | null = null
    /** See `SyncActivity.connection`. */
    let connection: SyncActivity['connection'] = 'connecting'
    /** Documents whose engines hold unacknowledged outbox operations, kept by `onQueueChange`. */
    const unsentDocs = new Set<string>()
    /**
     * Write refusals. The relay answers a refused append, delete or resurrect with `quota_denied`
     * naming the document and operation, and acknowledges nothing: the operation stays at the
     * head of that document's outbox, and without a retry the document would stay stalled until
     * a reload even after the allowance came back. `refusedDocs` are the documents to send
     * again; empty when a server too old to name them refused.
     */
    let refusal: WriteRefusal | null = null
    const refusedDocs = new Set<string>()
    /** Bumped by every refusal, so `awaitAcked` can tell one of its own writes from an older one. */
    let refusalCount = 0
    let refusalRounds = 0
    let refusalTimer: ReturnType<typeof setTimeout> | undefined
    const refusalDelay = deps.refusalRetryDelayMs ?? ((round: number) => refusalRetryDelayMs(round))
    const activityListeners = new Set<(activity: SyncActivity) => void>()
    let activityTimer: ReturnType<typeof setTimeout> | undefined
    const snapshotActivity = (): SyncActivity => ({
        connection,
        unsentDocuments: unsentDocs.size,
        refusal,
        waitingForKey,
    })

    // Following a new Graph Key epoch (ADR 0127). The keyring is read on every seal and open, so
    // once `refreshKeyring` has collected the new key every engine uses it; each is then told, to
    // seal again what the relay refused and ask again for what it could not open.
    const keyring = keyringReader(deps.keyring)
    /** The newest epoch the relay has said exists, or an update needed. */
    let wantedEpoch = 0
    /** Set while the keyring stops short of `wantedEpoch`: what the workspace shows. */
    let waitingForKey: number | null = null
    let refreshing: Promise<void> | undefined
    let lastRefreshAt = 0
    /** While waiting, how often a refused write or an unreadable update may fetch the key again. */
    const KEY_REFRESH_INTERVAL_MS = 15_000
    // While waiting, the session also asks again on a timer: nothing else may prompt it when this
    // device is not writing and nobody else is either.
    const keyRetryDelay = deps.keyRetryDelayMs ?? ((round: number) => keyRetryDelayMs(round))
    let keyRetryTimer: ReturnType<typeof setTimeout> | undefined
    let keyRetryRound = 0

    /**
     * The graph has reached epoch `epoch` (an announcement, a refusal or an unreadable update).
     * Collect the key when this device lacks it, at most every {@link KEY_REFRESH_INTERVAL_MS}
     * while it keeps lacking it unless the relay announced a new epoch, then tell every engine.
     */
    function followEpoch(epoch: number, announced = false): Promise<void> {
        wantedEpoch = Math.max(wantedEpoch, epoch)
        if (currentEpoch(keyring()).epochId >= wantedEpoch) {
            // The key may have arrived some other way, the workspace's own collection for one.
            if (waitingForKey !== null) {
                waitingForKey = null
                activityChanged()
                scheduleKeyRetry()
            }
            keysChangedEverywhere()
            return Promise.resolve()
        }
        if (refreshing) return refreshing
        if (!announced && waitingForKey !== null && Date.now() - lastRefreshAt < KEY_REFRESH_INTERVAL_MS) {
            return Promise.resolve()
        }
        lastRefreshAt = Date.now()
        refreshing = (async () => {
            try {
                await deps.refreshKeyring?.()
            } catch (error) {
                reportError(error)
            } finally {
                refreshing = undefined
            }
            if (disposed) return
            const held = currentEpoch(keyring()).epochId
            const nextWaiting = held >= wantedEpoch ? null : wantedEpoch
            if (nextWaiting !== waitingForKey) {
                waitingForKey = nextWaiting
                activityChanged()
            }
            scheduleKeyRetry()
            keysChangedEverywhere()
        })()
        return refreshing
    }

    /** Ask again later while the key is still missing; stop asking once it is held. */
    function scheduleKeyRetry(): void {
        if (waitingForKey === null) {
            clearTimeout(keyRetryTimer)
            keyRetryTimer = undefined
            keyRetryRound = 0
            return
        }
        if (keyRetryTimer) return
        keyRetryTimer = setTimeout(() => {
            keyRetryTimer = undefined
            // As an announcement would: the timer is the rate limit here.
            void followEpoch(wantedEpoch, true)
        }, keyRetryDelay(++keyRetryRound))
    }

    function keysChangedEverywhere(): void {
        for (const e of engines.values()) void e.keysChanged().catch(reportError)
    }
    function activityChanged(): void {
        if (disposed || activityTimer || activityListeners.size === 0) return
        activityTimer = setTimeout(() => {
            activityTimer = undefined
            if (disposed) return
            const current = snapshotActivity()
            for (const listener of activityListeners) listener(current)
        }, ACTIVITY_COALESCE_MS)
    }
    /**
     * Set when the Sync Server turned out to speak another protocol version. The session then
     * stops for good: every reconnect would meet the same server, and nothing either side
     * sends can be read by the other. Pending appends stay in the cache for a later session.
     */
    let protocolMismatch: SyncProtocolMismatchError | undefined
    const reportError = (error: unknown) => {
        if (!disposed) deps.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
    const outboundSnapshots: string[] = []
    type OperationMessage = Extract<RelayClientMessage, { type: 'append' | 'delete' | 'resurrect' }>
    /** Documents whose operation this socket has sent and the relay has not answered, to its outbox id. */
    const operationsInFlight = new Map<string, string>()
    /** Each document's operation waiting for room in {@link OPERATION_WINDOW}, oldest first. */
    const operationsWaiting = new Map<string, OperationMessage>()
    type CatchupRequest = Extract<RelayClientMessage, { type: 'catchup' }>
    const foregroundCatchups: CatchupRequest[] = []
    const backgroundCatchups: CatchupRequest[] = []
    let catchupInFlight: CatchupRequest | undefined
    /**
     * The request the in-flight one's document asked for again while it was in flight. The relay
     * may have composed the in-flight answer before whatever prompted the second request: an ack
     * naming a sequence that another device's concurrent first write took, for one. Dropped as a
     * duplicate, that document stayed behind for good, so it runs once more if the answer leaves
     * the document with a gap.
     */
    let catchupRepeat: CatchupRequest | undefined
    let resolveFirstOpen: (() => void) | undefined
    const firstOpen = new Promise<void>((resolve) => {
        resolveFirstOpen = resolve
    })
    const connectionWaiters = new Set<{
        resolve: () => void
        reject: (error: Error) => void
    }>()
    type DocumentWatermark = {
        docId: string
        generation: number
        state: 'active' | 'deleted'
        lastSeq: number
    }
    const watermarkRequests = new Map<
        string,
        {
            resolve: (documents: DocumentWatermark[]) => void
            reject: (error: Error) => void
            timer: ReturnType<typeof setTimeout>
        }
    >()

    /**
     * `connected()` is deliberately a first-open milestone. Watermark reconciliation can
     * start hours later, so it needs the socket that is live NOW rather than that settled
     * historical promise.
     */
    function waitForCurrentConnection(): Promise<void> {
        if (open && socket) return Promise.resolve()
        if (disposed) return Promise.reject(new Error('the graph sync session was disposed'))
        if (lost) return Promise.reject(new Error('access to this graph has ended'))
        if (protocolMismatch) return Promise.reject(protocolMismatch)
        return new Promise<void>((resolve, reject) => {
            connectionWaiters.add({ resolve, reject })
        })
    }

    async function requestWatermarks(docIds: readonly string[]): Promise<DocumentWatermark[]> {
        while (!disposed) {
            await waitForCurrentConnection()
            const activeSocket = socket
            // A close can land between the waiter resolving and this continuation running.
            if (!open || !activeSocket) continue

            try {
                return await new Promise<DocumentWatermark[]>((resolve, reject) => {
                    const requestId = crypto.randomUUID()
                    const timer = setTimeout(() => {
                        watermarkRequests.delete(requestId)
                        reject(new RelayUnansweredError('the sync relay did not answer a watermark check'))
                    }, 15_000)
                    watermarkRequests.set(requestId, { resolve, reject, timer })
                    activeSocket.send(
                        serializeClientMessage({
                            type: 'watermarks',
                            requestId,
                            docIds: [...docIds],
                        }),
                    )
                })
            } catch (error) {
                // The request is read-only and idempotent. A socket generation ending while
                // it is in flight means "try on the reconnect", not a failed reconciliation.
                if (error instanceof WatermarkConnectionInterruptedError && !disposed && !lost) continue
                throw error
            }
        }
        throw new Error('the graph sync session was disposed')
    }

    /**
     * Documents the CURRENT socket has subscribed to. The relay keeps and forwards presence
     * only for a subscribed document, and this mirrors that rule at the source:
     * y-protocols renews every engine's awareness state every fifteen seconds, and an engine
     * created for a background walk starts with an empty `{}` state, so without the gate every
     * unretained engine encrypted and sent presence the relay would only drop. Cleared with
     * the socket; the reconnect's subscribe rebuilds it before anything is advertised.
     */
    const subscribed = new Set<string>()

    function sendNow(message: RelayClientMessage): void {
        if (message.type === 'presence' && !subscribed.has(message.docId)) return
        const data = serializeClientMessage(message)
        if (open && socket) {
            socket.send(data)
            if (message.type === 'subscribe' && 'docIds' in message) for (const docId of message.docIds) subscribed.add(docId)
            if (message.type === 'unsubscribe') for (const docId of message.docIds) subscribed.delete(docId)
        } else if (message.type === 'snapshot_put') outboundSnapshots.push(data)
        // Appends are already durable and replay on open. Catch-up is regenerated from the
        // current watermark. Presence is ephemeral, and a lost ack confirmation merely
        // leaves a harmless server receipt, so none belongs in a volatile socket queue.
    }

    /**
     * Subscribe to every retained document on a freshly opened socket, in batches the relay
     * accepts. Above the protocol's per-message limit the relay rejects a subscribe as invalid,
     * which would leave a tab with many open views silently without live updates after a
     * reconnect.
     */
    function subscribeRetained(): void {
        const docIds = [...retained.keys()]
        const batchSize = SYNC_PROTOCOL_LIMITS.maxSubscriptionDocIds
        for (let start = 0; start < docIds.length; start += batchSize) {
            sendNow({ type: 'subscribe', docIds: docIds.slice(start, start + batchSize) })
        }
    }

    function pumpCatchups(): void {
        if (!open || !socket || catchupInFlight) return
        catchupInFlight = foregroundCatchups.shift() ?? backgroundCatchups.shift()
        if (catchupInFlight) socket.send(serializeClientMessage(catchupInFlight))
    }

    function queueCatchup(message: CatchupRequest): void {
        if (!open) return
        if (
            catchupInFlight?.docId === message.docId &&
            catchupInFlight.generation === message.generation &&
            catchupInFlight.afterSeq === message.afterSeq
        ) {
            catchupRepeat = message
            return
        }
        // A foreground open supersedes an unsent background request for the same document.
        const removeQueued = (queue: CatchupRequest[]) => {
            const index = queue.findIndex((candidate) => candidate.docId === message.docId)
            if (index >= 0) queue.splice(index, 1)
        }
        removeQueued(foregroundCatchups)
        removeQueued(backgroundCatchups)
        const queue = message.priority === 'foreground' ? foregroundCatchups : backgroundCatchups
        queue.push(message)
        pumpCatchups()
    }

    function finishCatchup(requestId?: string): void {
        if (!requestId || catchupInFlight?.requestId !== requestId) return
        const completedDocId = catchupInFlight.docId
        catchupInFlight = undefined
        const repeat = catchupRepeat?.docId === completedDocId ? catchupRepeat : undefined
        catchupRepeat = undefined
        // Only a document the answer left with a gap needs it: most repeats are the same open
        // asked for twice, and the answer just applied serves both.
        if (repeat && engines.get(completedDocId)?.health() === 'sequence-gap') queueCatchup(repeat)
        pumpCatchups()
        retireEngineIfIdle(completedDocId)
    }

    /**
     * Send a document's operation within the window, or hold it until an answer makes room. A
     * document's newer operation replaces one still waiting (the engine sends only its head).
     */
    function sendOperation(docId: string, message: OperationMessage): void {
        ackRoute.set(message.outboxId, docId)
        // Already durable: an operation that finds the socket closed is sent again on the next open.
        if (!open || !socket) return
        if (!operationsInFlight.has(docId) && operationsInFlight.size >= OPERATION_WINDOW) {
            operationsWaiting.set(docId, message)
            return
        }
        operationsWaiting.delete(docId)
        operationsInFlight.set(docId, message.outboxId)
        sendNow(message)
    }

    /**
     * The relay answered `docId`'s operation, by acking or refusing it: its place in the window
     * goes to the longest-waiting one. `outboxId`, when the answer names one, must be the
     * operation in flight; an answer to an older one frees nothing.
     */
    function operationAnswered(docId: string, outboxId?: string): void {
        const inFlight = operationsInFlight.get(docId)
        if (inFlight === undefined || (outboxId !== undefined && inFlight !== outboxId)) return
        operationsInFlight.delete(docId)
        for (const [waitingDocId, waiting] of operationsWaiting) {
            if (!open || !socket || operationsInFlight.size >= OPERATION_WINDOW) return
            operationsWaiting.delete(waitingDocId)
            operationsInFlight.set(waitingDocId, waiting.outboxId)
            sendNow(waiting)
        }
    }

    function rawSend(message: RelayClientMessage): void {
        if (message.type === 'catchup') {
            queueCatchup(message)
            return
        }
        sendNow(message)
    }

    // Cache seeding and relay synchronization are separate operations. A cold index needs
    // bounded, cache-only batches; foreground documents and post-commit reconciliation
    // explicitly promote an engine into synchronization.
    const readied = new Map<string, Promise<void>>()
    const syncEnabled = new Set<string>()

    function activate(docId: string, e: DocSync): void {
        readied.set(docId, e.ready())
    }

    function enableSync(docId: string, e: DocSync): void {
        if (syncEnabled.has(docId)) return
        syncEnabled.add(docId)
        // A lazily-created engine, including one first used by a cache-only index walk,
        // must catch up when a real consumer promotes it. Keep the cache failure visible
        // through `readied`; this detached branch only reports it without an unhandled
        // rejection while no caller is awaiting yet.
        void (readied.get(docId) ?? Promise.resolve())
            .then(() => {
                if (!disposed && open && engines.get(docId) === e) e.resync()
            })
            .catch(reportError)
    }

    /**
     * Identity is applied on RETENTION, not engine creation: background index and
     * materialisation walks create engines for documents nobody is editing, and an engine
     * can outlive a release/retain cycle. The session's apply also resurrects a state
     * cleared by clearPresence — setLocalStateField would silently no-op on it, leaving
     * this client permanently invisible after re-opening a document (live, 2026-07-30).
     */
    function attachPresence(docId: string, e: DocSync): void {
        if (!presenceSession || docId === deps.rootDocId || presenceDetach.has(docId)) return
        presenceDetach.set(docId, presenceSession.attach(e.awareness))
    }

    function detachPresence(docId: string): void {
        presenceDetach.get(docId)?.()
        presenceDetach.delete(docId)
    }

    function retireEngineIfIdle(docId: string): void {
        if (docId === deps.rootDocId || retained.has(docId) || batchHolds.has(docId) || !retiring.has(docId)) return
        if (
            catchupInFlight?.docId === docId ||
            foregroundCatchups.some((request) => request.docId === docId) ||
            backgroundCatchups.some((request) => request.docId === docId)
        ) {
            return
        }
        const candidate = engines.get(docId)
        if (!candidate || !candidate.isIdle()) return
        retiring.delete(docId)
        detachPresence(docId)
        candidate.destroy()
        engines.delete(docId)
        unsentDocs.delete(docId)
        readied.delete(docId)
        syncEnabled.delete(docId)
        performanceRecorder.mark('sync.engine.count', {
            active: engines.size,
            subscriptions: retained.size,
        })
    }

    function noteQueue(docId: string): void {
        const e = engines.get(docId)
        if (e && e.unsentOperations() > 0) unsentDocs.add(docId)
        else unsentDocs.delete(docId)
        activityChanged()
    }

    /**
     * The relay refused a write on a quota. A refused snapshot is not a stalled write - the relay
     * still holds the document's log, and the engine uploads another at a later idle - so only a
     * refused outbox operation (named by its outbox id), or a refusal a server too old to name
     * anything sent, counts.
     */
    function noteRefusal(message: { docId?: string; outboxId?: string; quotaCode?: QuotaErrorCode }): void {
        if (message.docId && !message.outboxId) return
        if (message.docId) refusedDocs.add(message.docId)
        refusal = message.quotaCode ? { quotaCode: message.quotaCode } : {}
        refusalCount += 1
        scheduleRefusalRetry()
        activityChanged()
    }

    function scheduleRefusalRetry(): void {
        if (refusalTimer || disposed || lost) return
        refusalTimer = setTimeout(() => {
            refusalTimer = undefined
            refusalRounds += 1
            resendRefused()
        }, refusalDelay(refusalRounds + 1))
    }

    /** Send each refused document's head operation again; the relay applies an outbox id once. */
    function resendRefused(): void {
        // Closed, the reconnect re-sends every document's head operation itself.
        if (disposed || lost || !open) return
        const docIds = refusedDocs.size > 0 ? [...refusedDocs] : [...unsentDocs]
        for (const docId of docIds) {
            const e = engines.get(docId)
            // Nothing left to send (a newer generation discarded it): nothing is refused there.
            if (!e || e.unsentOperations() === 0) {
                refusedDocs.delete(docId)
                continue
            }
            e.retryUnsent()
        }
        if (refusedDocs.size === 0 && unsentDocs.size === 0) clearRefusal()
    }

    /** Whether every document with unsent operations is one the server refused. */
    function everyUnsentRefused(): boolean {
        if (unsentDocs.size === 0) return false
        if (refusedDocs.size === 0) return true // a server too old to name the document refused
        for (const docId of unsentDocs) if (!refusedDocs.has(docId)) return false
        return true
    }

    /** An ack: the server accepted a write, so that document is refused no longer. */
    function writeAccepted(docId: string): void {
        if (!refusal) return
        refusedDocs.delete(docId)
        if (refusedDocs.size === 0) clearRefusal()
    }

    function clearRefusal(): void {
        refusal = null
        refusedDocs.clear()
        refusalRounds = 0
        clearTimeout(refusalTimer)
        refusalTimer = undefined
        activityChanged()
    }

    function engine(docId: string, synchronize = true): DocSync {
        let e = engines.get(docId)
        if (!e) {
            e = createDocSync({
                docId,
                graphId: deps.graphId,
                keyring,
                onMissingKey: (epochId) => void followEpoch(epochId),
                send: (message) => {
                    if (
                        message.type === 'append' ||
                        message.type === 'delete' ||
                        message.type === 'resurrect'
                    ) {
                        sendOperation(docId, message)
                        return
                    }
                    rawSend(message)
                },
                persist: deps.cache.docCache(
                    docId,
                    docId === deps.rootDocId ? 'root' : 'document',
                ),
                debounceMs: deps.debounceMs,
                collectRowWhen: docId === deps.rootDocId ? undefined : deps.collectRowWhen,
                // The root document's row is collected after a bookmark removal instead: see
                // `bookmarkRemovals` below.
                collectRowRequests: docId === deps.rootDocId ? () => bookmarkRemovals : undefined,
                // The disposed-guarded reporter, not the raw callback: an engine's late
                // rejection after dispose must not reach the next workspace's notice.
                onError: reportError,
                onIdle: () => queueMicrotask(() => retireEngineIfIdle(docId)),
                onQueueChange: () => noteQueue(docId),
                catchupPriority: () => {
                    return retained.has(docId) ? 'foreground' : 'background'
                },
            })
            engines.set(docId, e)
            performanceRecorder.mark('sync.engine.count', {
                active: engines.size,
                subscriptions: retained.size,
            })
            // Name this device's caret before any cursor is advertised, so a collaborator
            // never sees the default-blue "Anonymous" flash into a named one.
            if (retained.has(docId)) attachPresence(docId, e)
            // Any content change (local edit or remote update) notifies onDocUpdate, so the
            // store's onChange (index, mirror) fires on edits, not only on registry changes.
            e.doc.on('update', (_update, origin) => {
                // Rehydrating the already-indexed IndexedDB snapshot on every hard refresh
                // is not a content change. Genuine relay updates use REMOTE and still flow.
                if (origin === CACHE_SEED) return
                for (const l of docUpdateListeners) l(docId)
            })
            activate(docId, e)
        }
        if (synchronize) enableSync(docId, e)
        return e
    }

    async function indexDocumentUpdate(
        docId: string,
        missingCacheMeansDeleted: boolean,
    ): Promise<Uint8Array | null> {
        const cached = await deps.cache.docCache(docId).load()
        if (cached?.lifecycle === 'deleted' || (!cached && missingCacheMeansDeleted)) {
            return null
        }
        const live = engines.get(docId)
        if (!cached && !live) return null

        // A tab can be older than a cache boundary written by a peer, while a local edit can
        // be newer than its own asynchronous cache save. CRDT-merging both views gives the
        // index a snapshot at least as new as the captured token without creating a relay
        // subscription solely to read derived data.
        const merged = new Y.Doc()
        try {
            if (cached) Y.applyUpdate(merged, cached.update, CACHE_SEED)
            if (live) Y.applyUpdate(merged, Y.encodeStateAsUpdate(live.doc), CACHE_SEED)
            return Y.encodeStateAsUpdate(merged)
        } finally {
            merged.destroy()
        }
    }

    /**
     * How many bookmark removals the root document has seen this session, local or from the
     * relay. Each makes the root engine collect its Local Cache row once that row holds the
     * removal: the row is merged from every saved state and keeps deleted content otherwise, so a
     * removed bookmark's line text would stay at rest in the clear, the text of a page protected
     * since among it (ADR 0159). Counted in `afterTransaction`, which runs before the engine's own
     * `update` handler takes its snapshot. Not for the seed from the cache: the row already holds
     * what the seed read, and collecting it again on every open would cost a rewrite each time.
     */
    let bookmarkRemovals = 0

    // The root document is just another synced doc.
    const root = engine(deps.rootDocId)
    root.doc.on('afterTransaction', (transaction: Y.Transaction) => {
        if (transaction.origin === CACHE_SEED) return
        if (removedBookmark(root.doc, transaction)) bookmarkRemovals += 1
    })
    const registryMap = root.doc.getMap<RegistryEntry>('registry')
    if (deps.onRegistryChange) registryMap.observe(() => deps.onRegistryChange?.())
    const metaMap = root.doc.getMap<unknown>('meta')
    const quickNotesArray = root.doc.getArray<unknown>('quickNotes')
    const dictionaryMap = root.doc.getMap<unknown>('spellingDictionary')
    const themesMap = root.doc.getMap<Y.Map<unknown>>('themes')

    /** A stored theme as a plain object, or null when the entry is not one. */
    function readTheme(id: string): GraphTheme | null {
        const entry = themesMap.get(id)
        if (!(entry instanceof Y.Map)) return null
        const filesMap = entry.get('files')
        const files: Record<string, unknown> = {}
        if (filesMap instanceof Y.Map) for (const [path, text] of filesMap.entries()) files[path] = text
        return sanitizeGraphTheme({ id, name: entry.get('name'), origin: entry.get('origin'), updatedAt: entry.get('updatedAt'), files })
    }

    function themeEntry(id: string, create: boolean): Y.Map<unknown> | null {
        let entry = themesMap.get(id)
        if (!(entry instanceof Y.Map)) {
            if (!create) return null
            entry = new Y.Map<unknown>()
            themesMap.set(id, entry)
            entry.set('files', new Y.Map<string>())
        }
        return entry
    }

    function themeFiles(entry: Y.Map<unknown>): Y.Map<string> {
        let files = entry.get('files')
        if (!(files instanceof Y.Map)) {
            files = new Y.Map<string>()
            entry.set('files', files)
        }
        return files as Y.Map<string>
    }
    // The name envelope follows what this session sees of the canonical name, with two rules.
    // A name this session writes itself goes out at once: the user's own rename is never stale.
    // A name that arrived from the cache or the relay goes out only after the root document has
    // genuinely caught up, because until then it may be older than what another member already
    // published. Disposal marks catch-up complete so waiters can end (doc-sync.ts), which must
    // not count as caught up here, or closing an offline tab would overwrite a newer name.
    let publishedName: string | undefined
    let rootCaughtUpOnce = false
    const publishName = (name: unknown) => {
        if (disposed || !deps.publishName) return
        if (typeof name !== 'string' || name === '' || name === publishedName) return
        publishedName = name
        deps.publishName(name)
    }
    const publishNameOnceCaughtUp = () => {
        if (rootCaughtUpOnce) publishName(metaMap.get('name'))
    }
    if (deps.publishName) {
        metaMap.observe(publishNameOnceCaughtUp)
        void root.caughtUp().then(
            () => {
                if (disposed) return
                rootCaughtUpOnce = true
                publishNameOnceCaughtUp()
            },
            () => {
                // A failed catch-up is reported through the engine's own channels. This session
                // then publishes nothing (the next one will), and the rejection must not escape:
                // in the Node-based Headless Client an unhandled rejection ends the process.
            },
        )
    }

    /** Report once, fail everything waiting for a connection, and close without reconnecting. */
    function stopForProtocolMismatch(serverVersion: number): void {
        if (protocolMismatch) return
        protocolMismatch = new SyncProtocolMismatchError(serverVersion)
        connection = 'ended'
        clearTimeout(reconnectTimer)
        clearTimeout(refusalTimer)
        refusalTimer = undefined
        activityChanged()
        reportError(protocolMismatch)
        for (const waiter of connectionWaiters) waiter.reject(protocolMismatch)
        connectionWaiters.clear()
        socket?.close()
    }

    function handleMessage(raw: string): void {
        const read = readServerMessage(raw)
        if (read.kind === 'protocol_mismatch') {
            stopForProtocolMismatch(read.serverVersion)
            return
        }
        if (read.kind === 'malformed') return
        const message = read.message
        if (message.type === 'catchup_batch') {
            performanceRecorder.mark('sync.catchup.batch', {
                rows: message.updates.length,
                bytes: new TextEncoder().encode(raw).byteLength,
                continuation: message.hasMore ? 1 : 0,
            })
        }
        if (message.type === 'error') {
            if (message.code === 'membership_revoked') {
                endAccess({ kind: 'membership' })
                return
            }
            if (message.code === 'quota_denied') {
                if (message.docId) operationAnswered(message.docId, message.outboxId)
                noteRefusal(message)
                return
            }
            if (
                message.code === 'stale_generation' &&
                message.docId &&
                message.currentGeneration !== undefined
            ) {
                if (catchupInFlight?.docId === message.docId) {
                    catchupInFlight = undefined
                    catchupRepeat = undefined
                }
                // The engine discards its operations for the old generation.
                operationAnswered(message.docId)
                void engine(message.docId).staleGeneration(message.currentGeneration)
                pumpCatchups()
            }
            if (message.code === 'stale_epoch' && message.docId) {
                // Nothing was stored. The write is sealed again under the current epoch once this
                // device holds its key (ADR 0127).
                operationAnswered(message.docId, message.outboxId)
                engine(message.docId).staleEpoch(message.outboxId)
                void followEpoch(message.currentEpoch ?? currentEpoch(keyring()).epochId + 1)
            }
            return
        }
        if (message.type === 'epoch_changed') {
            void followEpoch(message.epoch, true)
            return
        }
        if (message.type === 'watermarks') {
            const pending = watermarkRequests.get(message.requestId)
            if (!pending) return
            clearTimeout(pending.timer)
            watermarkRequests.delete(message.requestId)
            pending.resolve(message.documents)
            return
        }
        const report = reportError
        if (message.type === 'presence') {
            if (!retained.has(message.docId)) return
            void engine(message.docId).receivePresence(message.envelope).catch(report)
            return
        }
        if (message.type === 'ack') {
            const docId = ackRoute.get(message.outboxId)
            if (docId) {
                operationAnswered(docId, message.outboxId)
                void engine(docId)
                    .receive(message)
                    .then(() => {
                        ackRoute.delete(message.outboxId)
                        writeAccepted(docId)
                    })
                    .catch(report)
            }
            return
        }
        if (message.type === 'catchup_batch') {
            void engine(message.docId)
                .receive(message)
                .catch(report)
                .finally(() => finishCatchup(message.requestId))
            return
        }
        void engine(message.docId).receive(message).catch(report)
    }

    /**
     * Forget everything that belonged to one socket generation. Durable IndexedDB rows, not these
     * entries, determine outstanding work and replay on the next open, which resubscribes every
     * retained document.
     */
    function forgetSocketGeneration(): void {
        subscribed.clear()
        ackRoute.clear()
        // The next open resends every document's head operation through the window afresh.
        operationsInFlight.clear()
        operationsWaiting.clear()
        catchupInFlight = undefined
        catchupRepeat = undefined
        foregroundCatchups.length = 0
        backgroundCatchups.length = 0
        for (const pending of watermarkRequests.values()) {
            clearTimeout(pending.timer)
            pending.reject(new WatermarkConnectionInterruptedError())
        }
        watermarkRequests.clear()
    }

    // Reconnection state. `attempts` counts consecutive failures and sets the
    // backoff; a connection that stayed up resets it. `forceToken` asks the source for a new
    // token rather than the one it holds, after the relay refused it (4401).
    let attempts = 0
    let openedAt = 0
    let forceToken = false
    let credentialRefusals = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    /** True while a retry waits on `reconnectTimer`: no socket is open or being made. */
    let retryWaiting = false
    const retryDelay = deps.retryDelayMs ?? ((attempt: number) => reconnectDelayMs(attempt))

    function scheduleConnect(delayMs: number): void {
        if (disposed || lost || protocolMismatch) return
        clearTimeout(reconnectTimer)
        retryWaiting = true
        reconnectTimer = setTimeout(connect, delayMs)
    }

    function backOff(): void {
        attempts += 1
        scheduleConnect(retryDelay(attempts))
    }

    /** Stop for good: close the socket, never reconnect, and tell the owner once. */
    function endAccess(loss: SyncAccessLoss): void {
        if (lost || disposed) return
        lost = loss
        connection = 'ended'
        clearTimeout(reconnectTimer)
        clearTimeout(refusalTimer)
        refusalTimer = undefined
        activityChanged()
        const current = socket
        socket = undefined
        open = false
        forgetSocketGeneration()
        current?.close()
        for (const waiter of connectionWaiters) waiter.reject(new Error('access to this graph has ended'))
        connectionWaiters.clear()
        deps.onAccessLost?.(loss)
    }

    /**
     * A token is fetched for EVERY connect, never captured: the source re-mints when the
     * held token nears expiry, so a socket that drops an hour in still reconnects.
     * Encrypted appends issued while the token is in flight remain in IndexedDB and replay
     * on open. Only rebuildable snapshot uploads use a volatile queue.
     */
    function connect(): void {
        retryWaiting = false
        if (disposed || lost || protocolMismatch) return
        const force = forceToken
        forceToken = false
        void deps.token(force ? { force: true } : undefined).then(
            (token) => {
                if (disposed || lost) return
                const s = deps.connect(`${deps.relayUrl}?token=${encodeURIComponent(token)}`)
                socket = s
                s.onOpen(() => {
                    if (disposed || lost || socket !== s) return
                    open = true
                    connection = 'open'
                    activityChanged()
                    openedAt = Date.now()
                    credentialRefusals = 0
                    resolveFirstOpen?.()
                    for (const waiter of connectionWaiters) waiter.resolve()
                    connectionWaiters.clear()
                    subscribeRetained()
                    if (deps.subscribeAll) sendNow({ type: 'subscribe', all: true })
                    for (const data of outboundSnapshots.splice(0)) s.send(data)
                    // A local awareness state set while the socket was closed was dropped
                    // (presence never queues). Advertise every retained document now so the
                    // relay can store the envelope and replay it to late subscribers.
                    for (const docId of retained.keys()) {
                        if (docId === deps.rootDocId) continue
                        const e = engines.get(docId)
                        if (e) void e.advertisePresence().catch(reportError)
                    }
                    // Resync only engines promoted into synchronization. Cache-only cold-index
                    // batches must not turn one quick derivation into thousands of hidden
                    // downloads before post-commit reconciliation acquires its graph lock.
                    for (const [docId, e] of engines) {
                        if (!syncEnabled.has(docId)) continue
                        void (readied.get(docId) ?? Promise.resolve())
                            .then(() => e.resync())
                            .catch(reportError)
                    }
                })
                s.onMessage(handleMessage)
                s.onClose((event) => {
                    if (socket !== s) return
                    const upFor = open ? Date.now() - openedAt : 0
                    open = false
                    socket = undefined
                    forgetSocketGeneration()
                    if (disposed || lost || protocolMismatch) return
                    connection = 'reconnecting'
                    activityChanged()
                    // 4403: the membership ended. Retrying cannot help and only costs the server.
                    if (event?.code === 4403) {
                        endAccess({ kind: 'membership' })
                        return
                    }
                    if (upFor >= STABLE_CONNECTION_MS) attempts = 0
                    // 4401: the relay refused the token or the credential behind it. Ask for a
                    // new one straight away, once; if the credential itself was revoked the
                    // Sync Server refuses that mint with 401 and access ends below.
                    if (event?.code === 4401) {
                        forceToken = true
                        credentialRefusals += 1
                        if (credentialRefusals === 1) {
                            scheduleConnect(0)
                            return
                        }
                    }
                    backOff()
                })
            },
            (error: unknown) => {
                if (disposed || lost) return
                // A refusal is an answer, not an outage: 401 is this device's sign-in, 403 is
                // this graph. Anything else (offline, a server that is down) is retried.
                const status = refusalStatus(error)
                if (status === 401) {
                    endAccess({ kind: 'credentials', cause: error })
                    return
                }
                if (status === 403) {
                    endAccess({ kind: 'membership' })
                    return
                }
                backOff()
            },
        )
    }
    connect()

    let journalIdSecret: Promise<Uint8Array> | undefined

    return {
        rootDoc: root.doc,
        docSync: (docId) => engine(docId),
        retainDoc(docId) {
            const count = retained.get(docId) ?? 0
            retained.set(docId, count + 1)
            retiring.delete(docId)
            performanceRecorder.mark('sync.subscription.count', {
                subscriptions: retained.size,
                active: engines.size,
            })
            const retainedEngine = engine(docId)
            // The engine may predate retention (background index walk) or have been
            // released and re-retained — both must (re)apply the session identity here.
            attachPresence(docId, retainedEngine)
            if (count === 0 && open) {
                rawSend({ type: 'subscribe', docIds: [docId] })
                // The relay stores the latest presence envelope per subscriber; advertising
                // right after subscribe makes this client immediately visible to the room
                // and replayable to whoever subscribes next.
                void retainedEngine.advertisePresence().catch(reportError)
                void (readied.get(docId) ?? Promise.resolve()).then(() => retainedEngine.resync())
            }
            let released = false
            return () => {
                if (released || docId === deps.rootDocId) return
                released = true
                const next = (retained.get(docId) ?? 1) - 1
                if (next > 0) {
                    retained.set(docId, next)
                    return
                }
                retained.delete(docId)
                retiring.add(docId)
                performanceRecorder.mark('sync.subscription.count', {
                    subscriptions: retained.size,
                    active: engines.size,
                })
                // Awareness removal is an encrypted, ephemeral message. Preserve its wire
                // ordering before unsubscribe so peers do not retain a stale collaborator.
                detachPresence(docId)
                void retainedEngine
                    .clearPresence()
                    .catch(reportError)
                    .finally(() => {
                        if (disposed) return
                        if (retained.has(docId)) {
                            // Re-retained while the tombstone was in flight: re-apply the
                            // session identity (this resurrects the cleared state) and
                            // re-advertise, or this client stays invisible in this doc.
                            attachPresence(docId, retainedEngine)
                            if (open) void retainedEngine.advertisePresence().catch(reportError)
                            return
                        }
                        rawSend({ type: 'unsubscribe', docIds: [docId] })
                        retireEngineIfIdle(docId)
                    })
            }
        },
        deleteDoc: (docId) => engine(docId).delete(),
        compactDoc: (docId) => deps.cache.docCache(docId).compact(),
        uploadSnapshot: (docId) => engine(docId).compact(),
        registry: () => registryMap,
        journalDocId(date) {
            // The secret never changes (epoch 1 is never replaced), so it is derived once.
            journalIdSecret ??= deriveJournalIdSecret(keyring())
            return journalIdSecret.then((secret) => journalDocId(secret, date))
        },
        getMeta() {
            const name = metaMap.get('name')
            const settings = metaMap.get('settings')
            return {
                ...(typeof name === 'string' && name !== '' ? { name } : {}),
                ...(typeof settings === 'object' && settings !== null ? { settings: settings as Record<string, unknown> } : {}),
            }
        },
        setMetaName(name) {
            metaMap.set('name', name)
            publishName(name)
        },
        setMetaSettings(settings) {
            metaMap.set('settings', settings)
        },
        onMetaChange(listener) {
            metaMap.observe(listener)
            return () => metaMap.unobserve(listener)
        },
        quickNotes: () => quickNotesOver(root.doc, quickNotesArray),
        quickNotesOf(memberKey) {
            requireMemberKey(memberKey, 'quickNotesOf')
            return quickNotesOver(root.doc, root.doc.getArray<unknown>(`quickNotes:${memberKey}`))
        },
        favourites(memberKey) {
            requireMemberKey(memberKey, 'favourites')
            const array = root.doc.getArray<unknown>(`favourites:${memberKey}`)
            const flags = root.doc.getMap<unknown>(`memberFlags:${memberKey}`)
            const seeded = () => flags.get('favouritesSeeded') === true
            // The shared list as last seen, or null when the seed ran on a build that kept none.
            const seen = (): string[] | null => {
                const raw = flags.get('sharedFavouritesSeen')
                return Array.isArray(raw) ? sanitizeFavourites(raw) : null
            }
            const markSeeded = (shared: readonly string[]) => {
                flags.set('favouritesSeeded', true)
                flags.set('sharedFavouritesSeen', sanitizeFavourites(shared))
            }
            /** Append the entries of `incoming` the list does not hold, case-insensitively. */
            const appendMissing = (incoming: readonly string[]) => {
                const held = new Set(sanitizeFavourites(array.toArray()).map((c) => c.toLowerCase()))
                const missing = sanitizeFavourites(incoming).filter((c) => !held.has(c.toLowerCase()))
                if (missing.length > 0) array.push(missing)
            }
            return {
                list: () => sanitizeFavourites(array.toArray()),
                replace(next, change) {
                    const clean = sanitizeFavourites(next)
                    root.doc.transact(() => {
                        if (change?.seedFrom && !seeded()) markSeeded(change.seedFrom)
                        if (change?.moved !== undefined && moveString(root.doc, array, clean, change.moved)) return
                        replaceStrings(root.doc, array, clean)
                    })
                },
                seedOnce(shared) {
                    if (seeded()) return false
                    root.doc.transact(() => {
                        // Appended after anything the person already favourited, which keeps its
                        // place. Two devices that seed while apart both append; list() dedupes.
                        appendMissing(shared)
                        markSeeded(shared)
                    })
                    return true
                },
                seeded,
                followShared(shared) {
                    if (!seeded()) return false
                    const current = sanitizeFavourites(shared)
                    const before = seen()
                    const unchanged = before !== null && before.length === current.length && before.every((c, i) => c === current[i])
                    if (unchanged) return false
                    root.doc.transact(() => {
                        if (before !== null) {
                            const known = new Set(before.map((c) => c.toLowerCase()))
                            appendMissing(current.filter((c) => !known.has(c.toLowerCase())))
                        }
                        flags.set('sharedFavouritesSeen', current)
                    })
                    return true
                },
                observe(listener) {
                    const onFlags = () => listener()
                    array.observe(listener)
                    flags.observe(onFlags)
                    return () => {
                        array.unobserve(listener)
                        flags.unobserve(onFlags)
                    }
                },
            }
        },
        clearDepartedMembers(activeMemberKeys) {
            if (activeMemberKeys.length === 0) return []
            const active = new Set(activeMemberKeys)
            const cleared: string[] = []
            root.doc.transact(() => {
                for (const name of [...root.doc.share.keys()]) {
                    const parsed = memberListName(name)
                    if (!parsed || active.has(parsed.memberKey)) continue
                    // A type that arrived from a peer but was never asked for by name here is a
                    // bare AbstractType until it is: getArray/getMap gives it its real shape.
                    if (MEMBER_LIST_IS_ARRAY[parsed.kind]) {
                        const array = root.doc.getArray<unknown>(name)
                        if (array.length === 0) continue
                        array.delete(0, array.length)
                    } else {
                        const map = root.doc.getMap<unknown>(name)
                        if (map.size === 0) continue
                        for (const key of [...map.keys()]) map.delete(key)
                    }
                    cleared.push(name)
                }
            })
            return cleared
        },
        renameConceptInMemberLists(moves) {
            const renamed = new Map<string, string>()
            for (const { from, to } of moves) {
                const key = from.trim().toLowerCase()
                const next = to.trim()
                if (key === '' || next === '' || renamed.has(key)) continue
                renamed.set(key, next)
            }
            const target = (concept: unknown) => (typeof concept === 'string' ? renamed.get(concept.trim().toLowerCase()) : undefined)
            const changed: string[] = []
            if (renamed.size === 0) return changed
            root.doc.transact(() => {
                for (const name of [...root.doc.share.keys()]) {
                    const parsed = memberListName(name)
                    if (parsed?.kind === 'favourites') {
                        const array = root.doc.getArray<unknown>(name)
                        const entries = array.toArray()
                        let hit = false
                        // Delete and insert at the same index, so the favourite keeps its place.
                        entries.forEach((entry, i) => {
                            const to = target(entry)
                            if (to === undefined || to === entry) return
                            array.delete(i, 1)
                            array.insert(i, [to])
                            hit = true
                        })
                        if (hit) changed.push(name)
                    } else if (parsed?.kind === 'bookmarks') {
                        const map = root.doc.getMap<unknown>(name)
                        let hit = false
                        for (const [id, value] of [...map.entries()]) {
                            const to = target(storedBookmarkConcept(value))
                            if (to === undefined) continue
                            if (value instanceof Y.Map) {
                                if (value.get('concept') === to) continue
                                // Only the one field, so a concurrent change to another field stays.
                                value.set('concept', to)
                            } else {
                                const [bookmark] = sanitizeBookmarks([value])
                                if (!bookmark || bookmark.concept === to) continue
                                putBookmark(map, { ...bookmark, id, concept: to })
                            }
                            hit = true
                        }
                        if (hit) changed.push(name)
                    } else if (parsed?.kind === 'memberFlags') {
                        // The shared list as this member's devices last saw it, moved with the
                        // shared list below, so `followShared` finds nothing new in the move.
                        const flags = root.doc.getMap<unknown>(name)
                        const seen = renamedNames(flags.get('sharedFavouritesSeen'), target)
                        if (seen) {
                            flags.set('sharedFavouritesSeen', seen)
                            changed.push(name)
                        }
                    }
                }
                // The shared Graph Settings favourites: every other setting kept exactly as stored.
                const settings = metaMap.get('settings')
                if (typeof settings === 'object' && settings !== null && !Array.isArray(settings)) {
                    const shared = renamedNames((settings as Record<string, unknown>).favourites, target)
                    if (shared) {
                        metaMap.set('settings', { ...(settings as Record<string, unknown>), favourites: shared })
                        changed.push('meta')
                    }
                }
            })
            return changed
        },
        bookmarkedConcepts() {
            const concepts = new Map<string, string>()
            for (const name of [...root.doc.share.keys()]) {
                if (memberListName(name)?.kind !== 'bookmarks') continue
                // getMap gives a type that arrived from a peer, and was never asked for here, its shape.
                for (const value of root.doc.getMap<unknown>(name).values()) {
                    const concept = storedBookmarkConcept(value)
                    if (typeof concept !== 'string' || concept.trim() === '') continue
                    const key = concept.trim().toLowerCase()
                    if (!concepts.has(key)) concepts.set(key, concept.trim())
                }
            }
            return [...concepts.values()]
        },
        removeBookmarksOn(concepts) {
            const keys = new Set(concepts.map((concept) => concept.trim().toLowerCase()).filter((key) => key !== ''))
            const changed: string[] = []
            if (keys.size === 0) return changed
            root.doc.transact(() => {
                for (const name of [...root.doc.share.keys()]) {
                    if (memberListName(name)?.kind !== 'bookmarks') continue
                    const map = root.doc.getMap<unknown>(name)
                    let hit = false
                    for (const [id, value] of [...map.entries()]) {
                        const concept = storedBookmarkConcept(value)
                        if (typeof concept !== 'string' || !keys.has(concept.trim().toLowerCase())) continue
                        map.delete(id)
                        hit = true
                    }
                    if (hit) changed.push(name)
                }
            })
            return changed
        },
        spellingDictionary: () => ({
            list: () => sanitizeDictionaryWords([...dictionaryMap.keys()]),
            add(word) {
                dictionaryMap.set(word, true)
            },
            remove(words) {
                root.doc.transact(() => {
                    for (const word of words) dictionaryMap.delete(word)
                })
            },
            observe(listener) {
                dictionaryMap.observe(listener)
                return () => dictionaryMap.unobserve(listener)
            },
        }),
        bookmarks(memberKey) {
            requireMemberKey(memberKey, 'bookmarks')
            const map = root.doc.getMap<unknown>(`bookmarks:${memberKey}`)
            return {
                list: () => sanitizeBookmarks([...map.values()].map(storedBookmark)),
                apply(change) {
                    root.doc.transact(() => {
                        for (const id of change.remove) map.delete(id)
                        for (const bookmark of change.put) putBookmark(map, bookmark)
                    })
                },
                observe(listener) {
                    // Deep: a field set inside one bookmark's map is a change to the list.
                    const deep = () => listener()
                    map.observeDeep(deep)
                    return () => map.unobserveDeep(deep)
                },
            }
        },
        themes: () => ({
            list() {
                const out: GraphTheme[] = []
                for (const id of themesMap.keys()) {
                    const theme = readTheme(id)
                    if (theme) out.push(theme)
                }
                return out.sort((a, b) => a.id.localeCompare(b.id))
            },
            get: (id) => readTheme(id),
            put(theme) {
                root.doc.transact(() => {
                    const entry = themeEntry(theme.id, true) as Y.Map<unknown>
                    entry.set('name', theme.name)
                    if (theme.origin !== undefined) entry.set('origin', theme.origin)
                    entry.set('updatedAt', theme.updatedAt ?? new Date().toISOString())
                    const files = themeFiles(entry)
                    for (const path of [...files.keys()]) if (!(path in theme.files)) files.delete(path)
                    for (const [path, text] of Object.entries(theme.files)) {
                        if (isThemeFilePath(path) && files.get(path) !== text) files.set(path, text)
                    }
                })
            },
            putFile(id, path, text) {
                if (!isThemeFilePath(path)) return
                root.doc.transact(() => {
                    const entry = themeEntry(id, true) as Y.Map<unknown>
                    themeFiles(entry).set(path, text)
                    entry.set('updatedAt', new Date().toISOString())
                })
            },
            removeFile(id, path) {
                const entry = themeEntry(id, false)
                if (!entry) return
                root.doc.transact(() => {
                    themeFiles(entry).delete(path)
                    entry.set('updatedAt', new Date().toISOString())
                })
            },
            remove(id) {
                themesMap.delete(id)
            },
            observe(listener) {
                themesMap.observeDeep(listener)
                return () => themesMap.unobserveDeep(listener)
            },
        }),
        connected: () => firstOpen,
        rootCaughtUp: () => root.caughtUp(),
        onDocUpdate(listener) {
            docUpdateListeners.add(listener)
            return () => docUpdateListeners.delete(listener)
        },
        async ready() {
            // Durable operations must replay even when their document is not otherwise
            // opened during this session.
            for (const docId of await deps.cache.pendingDocIds()) engine(docId)
            await Promise.all([...readied.values()])
        },
        async whenReady(docId) {
            engine(docId) // creating on demand also queues its cache read NOW, not at walk order
            await readied.get(docId)
        },
        async seedDocsFromCache(docIds) {
            holdForBatch(docIds)
            const batch = docIds.map((docId) => engine(docId, false))
            await awaitHeld(docIds)
            return batch.map((entry) => entry.doc)
        },
        async readyDocs(docIds) {
            holdForBatch(docIds)
            for (const docId of docIds) engine(docId)
            await awaitHeld(docIds)
        },
        retireDocs: releaseBatch,
        firstCatchupPageDoc: (docId) => engine(docId).firstCatchupPage(),
        caughtUpDoc: (docId) => engine(docId).caughtUp(),
        async docsNeedingCatchup(docIds) {
            const changed: string[] = []
            for (
                let start = 0;
                start < docIds.length;
                start += SYNC_PROTOCOL_LIMITS.maxSubscriptionDocIds
            ) {
                const batch = docIds.slice(
                    start,
                    start + SYNC_PROTOCOL_LIMITS.maxSubscriptionDocIds,
                )
                const local = await deps.cache.watermarks(batch)
                const remote = await requestWatermarks(batch)
                for (const watermark of remote) {
                    const cached = local.get(watermark.docId)
                    if (
                        (!cached &&
                            (watermark.generation !== 1 ||
                                watermark.state !== 'active' ||
                                watermark.lastSeq !== 0)) ||
                        (cached &&
                            (cached.generation !== watermark.generation ||
                                cached.lifecycle !== watermark.state ||
                                cached.lastSeq !== watermark.lastSeq))
                    ) {
                        changed.push(watermark.docId)
                    }
                }
            }
            return changed
        },
        async pendingIndexChanges() {
            const changes = await deps.cache.pendingIndexChanges()
            const dirtyDocIds = new Set(changes.map((change) => change.docId))
            return {
                docIds: changes.map((change) => change.docId),
                rootUpdate: await indexDocumentUpdate(
                    deps.rootDocId,
                    dirtyDocIds.has(deps.rootDocId),
                ),
                readDocument: (docId) =>
                    indexDocumentUpdate(docId, dirtyDocIds.has(docId)),
                acknowledge: () => deps.cache.acknowledgeIndexChanges(changes),
            }
        },
        isConnected: () => open,
        activity: snapshotActivity,
        onActivity(listener) {
            activityListeners.add(listener)
            return () => activityListeners.delete(listener)
        },
        retryRefused() {
            if (!refusal) return
            clearTimeout(refusalTimer)
            refusalTimer = undefined
            resendRefused()
        },
        reconnectNow() {
            if (!retryWaiting || disposed || lost || protocolMismatch) return
            // The wait was for a network that was away. With it back, a failure now is new, and
            // the backoff starts again from its shortest wait.
            attempts = 0
            scheduleConnect(0)
        },
        async flushAll({ onProgress } = {}) {
            const all = [...engines.values()]
            let flushed = 0
            await Promise.all(all.map((e) => e.flush().then(() => onProgress?.(++flushed, all.length))))
        },
        async awaitAcked({ onProgress, signal, stallMs = 30_000 } = {}) {
            // A refusal from before this wait may concern another write; one during it is an answer.
            const refusalsBefore = refusalCount
            const initial = await deps.cache.countPending()
            if (initial === 0) return { settled: true, outstanding: 0 }
            onProgress?.(initial)

            return new Promise<AckResult>((resolve) => {
                let last = initial
                let lastProgressAt = Date.now()
                const POLL_MS = 100
                let timer: ReturnType<typeof setTimeout> | undefined
                const finish = (result: AckResult) => {
                    if (timer) clearTimeout(timer)
                    resolve(result)
                }
                const poll = async () => {
                    try {
                        const current = await deps.cache.countPending()
                        if (current < last) {
                            last = current
                            lastProgressAt = Date.now()
                            onProgress?.(current)
                        }
                        if (current === 0) return finish({ settled: true, outstanding: 0 })
                        // The server said no: waiting out the stall would only delay saying so. A
                        // refusal counts when it arrived during this wait, or when every document
                        // still waiting is one the server refused (it may have answered while the
                        // caller was flushing, before this wait began).
                        if (refusal && (refusalCount > refusalsBefore || everyUnsentRefused())) {
                            return finish({ settled: false, outstanding: current, refused: refusal })
                        }
                        if (signal?.aborted) return finish({ settled: false, outstanding: current })
                        if (Date.now() - lastProgressAt >= stallMs) {
                            return finish({ settled: false, outstanding: current, ...(refusal ? { refused: refusal } : {}) })
                        }
                        timer = setTimeout(poll, POLL_MS)
                    } catch (error) {
                        reportError(error)
                        finish({ settled: false, outstanding: last })
                    }
                }
                timer = setTimeout(poll, POLL_MS)
            })
        },
        diagnostics: () => ({
            activeEngines: engines.size,
            retainedDocuments: retained.size,
        }),
        endAccess,
        accessLoss: () => lost,
        dispose() {
            disposed = true
            clearTimeout(reconnectTimer)
            clearTimeout(refusalTimer)
            clearTimeout(activityTimer)
            clearTimeout(keyRetryTimer)
            activityListeners.clear()
            socket?.close()
            for (const detach of presenceDetach.values()) detach()
            presenceDetach.clear()
            for (const e of engines.values()) e.destroy()
            engines.clear()
            retiring.clear()
            batchHolds.clear()
            syncEnabled.clear()
            foregroundCatchups.length = 0
            backgroundCatchups.length = 0
            catchupInFlight = undefined
            catchupRepeat = undefined
            for (const pending of watermarkRequests.values()) {
                clearTimeout(pending.timer)
                pending.reject(new Error('the graph sync session was disposed'))
            }
            watermarkRequests.clear()
            for (const waiter of connectionWaiters) {
                waiter.reject(new Error('the graph sync session was disposed'))
            }
            connectionWaiters.clear()
        },
    }
}

/** The real browser WebSocket adapter (not used in unit tests). */
export function browserTransport(url: string): TransportSocket {
    const ws = new WebSocket(url)
    return {
        send: (data) => ws.send(data),
        close: () => ws.close(),
        onOpen: (cb) => ws.addEventListener('open', () => cb()),
        onMessage: (cb) => ws.addEventListener('message', (e) => cb(String((e as MessageEvent).data))),
        // The close code is what tells access ending (4401, 4403) from a dropped connection.
        onClose: (cb) => ws.addEventListener('close', (event) => cb({ code: event.code, reason: event.reason })),
    }
}
