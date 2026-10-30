/**
 * A person's own lists on a synced graph (ADR 0159): how the workspace composes the Quick Notes
 * one person sees, and how the Owner's Client deletes the lists of a Member who left. The lists
 * themselves are root-doc types that `graph-sync.ts` owns; this module only decides which of
 * them a person sees and when a departed Member's are emptied, so the workspace stays thin and
 * the rules are tested here.
 *
 * The member key is the Member's Sync Principal id: the account's id on the Sync Server that holds
 * the graph, as the graph's registry record stores it (`serverScope.principalId`).
 */
import type { Bookmark, BookmarksPersist } from '$lib/document/bookmarks/bookmarks'
import type { QuickNote } from '$lib/document/quick-notes'
import { type GraphSettings, sanitizeGraphSettings } from '$lib/storage/fs/graph-settings'

import type { GraphSync, QuickNotesList } from './graph-sync'
import { type PersonalFavourites, personalFavourites } from './personal-favourites'
import type { GraphMember } from './sync-api'

/**
 * The [[Quick Note]]s one person sees on a synced graph.
 *
 * - No member key (the account is not known on this device): the shared `quickNotes` array,
 *   exactly as before per-person lists, since there is no list of their own to use.
 * - Otherwise the person's own `quickNotes:<memberKey>` array, where every new note goes.
 * - While `showsShared()` is true (the person is the graph's [[Owner]]), the notes in the shared
 *   array are listed too, and removing one removes it from there. That array has no author, and a
 *   device on an older build may keep appending to it, so its notes go to the Owner rather than to
 *   everyone or no one (ADR 0159 decision 4). It is read on every `list()`, so the Owner's role can
 *   arrive after the graph opens.
 */
export function personalQuickNotes(
    graph: Pick<GraphSync, 'quickNotes' | 'quickNotesOf'>,
    memberKey: string | undefined,
    showsShared: () => boolean,
): QuickNotesList {
    const shared = graph.quickNotes()
    if (!memberKey) return shared
    const own = graph.quickNotesOf(memberKey)
    return {
        list() {
            const mine = own.list()
            if (!showsShared()) return mine
            // An id in both is one note (an import or a move may have copied it): the person's copy wins.
            const held = new Set(mine.map((note) => note.id))
            return [...mine, ...shared.list().filter((note) => !held.has(note.id))]
        },
        add: (note) => own.add(note),
        remove(ids) {
            own.remove(ids)
            if (showsShared()) shared.remove(ids)
        },
        observe(listener) {
            // Both arrays, whatever the role is now: the role can become known later, and a
            // listener re-reads list(), which applies it.
            const offOwn = own.observe(listener)
            const offShared = shared.observe(listener)
            return () => {
                offOwn()
                offShared()
            }
        },
    }
}

/**
 * The member keys whose lists stay: every member the roster lists as active (a roster from a
 * server that predates `status` lists active members only), plus `ownKey`, so the person running
 * the clear never empties their own lists whatever the roster says. Invitees have not joined, so
 * they have no lists of their own to keep.
 */
export function activeMemberKeys(members: readonly Pick<GraphMember, 'userId' | 'status'>[], ownKey: string): string[] {
    const keys = new Set<string>()
    for (const member of members) if (member.status !== 'invited') keys.add(member.userId)
    keys.add(ownKey)
    return [...keys]
}

export interface ClearDepartedDeps {
    graph: Pick<GraphSync, 'rootCaughtUp' | 'clearDepartedMembers' | 'flushAll'>
    /** The graph's roster, owner-only on the Sync Server (`graphMembers`). */
    listMembers: () => Promise<readonly Pick<GraphMember, 'userId' | 'status'>[]>
    /** The Owner's own member key. */
    ownKey: string
    /** False once the graph this run started for has closed or been replaced. */
    stillOpen: () => boolean
}

/**
 * Empty the lists of every Member who left the graph (ADR 0159 decision 5). The Owner's Client
 * runs it in the background after the graph opens. Returns the names of the lists it emptied, or
 * null when it did nothing because it could not be sure who the members are.
 *
 * It waits for the root doc to catch up first, so it sees every list the relay holds, and reads
 * the roster after that, so the time between reading the roster and clearing is as short as it
 * can be: a member who joins in that time may have opened the graph already. It skips the clear
 * when the roster cannot be read (offline, or a refusal) and when it comes back empty, since a
 * graph always has its Owner and clearing against an empty roster would clear everyone else.
 */
export async function clearDepartedMemberLists(deps: ClearDepartedDeps): Promise<string[] | null> {
    try {
        await deps.graph.rootCaughtUp()
    } catch {
        return null
    }
    // Disposing the session also ends the catch-up wait, which must not count as caught up.
    if (!deps.stillOpen()) return null
    let members: readonly Pick<GraphMember, 'userId' | 'status'>[]
    try {
        members = await deps.listMembers()
    } catch {
        return null
    }
    if (members.length === 0 || !deps.stillOpen()) return null
    const cleared = deps.graph.clearDepartedMembers(activeMemberKeys(members, deps.ownKey))
    // Out of the append debounce at once, as other background root-doc writes are.
    if (cleared.length > 0) await deps.graph.flushAll()
    return cleared
}

/**
 * Whether this person owns the graph, from the Sync Server's list of their graphs (ADR 0159):
 * true or false from the graph's listed role, null when the graph is not listed or the list
 * cannot be read (offline, a refusal). Never rejects.
 */
export function ownerRoleFromListing(
    listing: Promise<readonly { id: string; role: string }[]>,
    graphId: string,
): Promise<boolean | null> {
    return listing.then(
        (graphs) => {
            const listed = graphs.find((graph) => graph.id === graphId)
            return listed ? listed.role === 'owner' : null
        },
        () => null,
    )
}

/** Why a synced graph opened without a member key cannot keep bookmarks. */
export const BOOKMARKS_NEED_MEMBER_KEY =
    'Bookmarks need this device to know your account on the sync server. Sign in again from the Graphs page.'

/**
 * A bookmarks persist that refuses every write with `reason`. `bookmarks.ts` then rolls the
 * change back and the caller shows the reason, so the person never sees a bookmark that only
 * this tab's memory holds and that is gone on the next open.
 */
export function refusingBookmarksPersist(reason: string): BookmarksPersist {
    return async () => {
        throw new Error(reason)
    }
}

/** What the Local Mirror and an Export write for the person beside the documents (ADR 0159). */
export interface MirroredLists {
    /** The shared Graph Settings, with `favourites` the person's own list, left out when empty. */
    settings: GraphSettings
    quickNotes: QuickNote[]
    /** The person's own bookmarks. Undefined without a member key: no file is written. */
    bookmarks?: Bookmark[]
}

/** One person's lists for one open of a synced graph (ADR 0159). */
export interface PersonalLists {
    /** The Member's Sync Principal id, or undefined when this device does not know the account. */
    readonly memberKey: string | undefined
    /** The Quick Notes the person sees. Their listeners also hear the Owner role arrive. */
    readonly quickNotes: QuickNotesList
    readonly favourites: PersonalFavourites
    /** The person's own bookmarks, or null without a member key (see {@link BOOKMARKS_NEED_MEMBER_KEY}). */
    readonly bookmarks: ReturnType<GraphSync['bookmarks']> | null
    /** True once the Sync Server said this person owns the graph. */
    isOwner(): boolean
    /**
     * Record the role the Sync Server gave. The role is read once per open, so a change of
     * owner while the graph is open shows on the next open.
     */
    setOwner(owner: boolean): void
    mirrored(): MirroredLists
    /** Fires when anything {@link mirrored} returns, other than the shared settings, may have changed. */
    observeMirrored(listener: () => void): () => void
}

export function createPersonalLists(
    graph: Pick<
        GraphSync,
        'quickNotes' | 'quickNotesOf' | 'favourites' | 'bookmarks' | 'getMeta' | 'setMetaSettings' | 'onMetaChange' | 'rootCaughtUp' | 'flushAll'
    >,
    memberKey: string | undefined,
): PersonalLists {
    let owner = false
    const ownerListeners = new Set<() => void>()
    const notes = personalQuickNotes(graph, memberKey, () => owner)
    // The Owner sees the shared array's notes too, so a role that arrives after the open changes
    // the list: its listeners hear it as they hear an array change.
    const quickNotes: QuickNotesList = {
        ...notes,
        observe(listener) {
            const offArrays = notes.observe(listener)
            ownerListeners.add(listener)
            return () => {
                offArrays()
                ownerListeners.delete(listener)
            }
        },
    }
    const favourites = personalFavourites(graph, memberKey)
    const bookmarks = memberKey ? graph.bookmarks(memberKey) : null

    return {
        memberKey,
        quickNotes,
        favourites,
        bookmarks,
        isOwner: () => owner,
        setOwner(next) {
            if (next === owner) return
            owner = next
            for (const listener of [...ownerListeners]) listener()
        },
        mirrored() {
            const { favourites: _shared, ...rest } = sanitizeGraphSettings(graph.getMeta().settings ?? {})
            const listed = favourites.list()
            return {
                settings: listed.length > 0 ? { ...rest, favourites: listed } : rest,
                quickNotes: quickNotes.list(),
                bookmarks: bookmarks?.list(),
            }
        },
        observeMirrored(listener) {
            const offNotes = quickNotes.observe(listener)
            const offFavourites = memberKey ? graph.favourites(memberKey).observe(listener) : () => {}
            const offBookmarks = bookmarks ? bookmarks.observe(listener) : () => {}
            return () => {
                offNotes()
                offFavourites()
                offBookmarks()
            }
        },
    }
}
