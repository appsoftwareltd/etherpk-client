/**
 * An [[Agent Chat]] as the extension keeps it (ADR 0147): on this device only, in the graph's
 * records, until the person deletes it. A chat's turns are what the person may save into its home
 * document; nothing else of it ever enters the graph.
 */

/**
 * What a chat may read from the graph: its [[Context Grant]]. `block` is the outline around the
 * bullet the chat is open on: the bullet's ancestors and its siblings with what is under them.
 */
export type GrantLevel = 'nothing' | 'block' | 'document' | 'links' | 'graph'

/** The grants from the narrowest to the widest, the order a person picks from. */
export const GRANT_ORDER: readonly GrantLevel[] = ['nothing', 'block', 'document', 'links', 'graph']

/** How each grant is named where a person picks one. */
export const GRANT_LABELS: Record<GrantLevel, string> = {
    nothing: 'Nothing else',
    block: 'Block siblings and ancestors',
    document: 'This document',
    links: 'This document and its links',
    graph: 'The whole graph',
}

/** A line that says what each grant sends, for the picker. */
export const GRANT_HINTS: Record<GrantLevel, string> = {
    nothing: 'Only this chat is sent.',
    block: "This bullet's siblings and ancestors are sent with each message.",
    document: "The document's text is sent with each message.",
    links: 'The document and the documents it links to directly are sent with each message.',
    graph: 'The document and its links are sent, and the model can search and read any other document. Each one it reads is shown.',
}

/**
 * The grant a new chat starts on: the outline around the bullet it opened on, when that bullet
 * has siblings or ancestors to send, else the document (ADR 0147, amended 2026-10-16). `outline`
 * is what Block siblings and ancestors would send now, or null where the chat is on no bullet.
 */
export function openingGrant(outline: string | null): GrantLevel {
    return outline !== null && outline.trim() !== '' ? 'block' : 'document'
}

/**
 * Whether a message must hold a prompt to be sent. Under the outline, the document, or the
 * document and its links, what is sent may already hold the question, so Send works with the field
 * empty. Nothing else sends no notes, and the whole graph has no one place the question could be.
 */
export function needsPrompt(grant: GrantLevel): boolean {
    return grant === 'nothing' || grant === 'graph'
}

/** A grant's label as it reads inside a sentence: "this document". */
function grantPhrase(grant: GrantLevel): string {
    const label = GRANT_LABELS[grant]
    return label.charAt(0).toLowerCase() + label.slice(1)
}

/** What the message field says while it is empty: what Send will do. */
export function composerPlaceholder(grant: GrantLevel): string {
    return needsPrompt(grant) ? 'Prompt the agent' : `Send ${grantPhrase(grant)}`
}

/**
 * A turn's question as it is shown, titled and saved: what the person wrote, or for a turn sent
 * with no prompt, what was sent ("Sent this document"). A picture sent on its own reads as nothing.
 */
export function questionText(turn: Pick<Turn, 'question' | 'grant' | 'images'>): string {
    const written = turn.question.trim()
    if (written !== '' || turn.images.length > 0) return written
    return `Sent ${grantPhrase(turn.grant)}`
}

/**
 * The message the model is given for a turn sent with no prompt: where the person's question is.
 * Under a grant that needs a prompt, only a picture can be sent with none, and the picture is it.
 */
export function promptlessMessage(grant: GrantLevel): string {
    switch (grant) {
        case 'block':
            return 'I have not written a message. The outline around this chat holds what I want: respond to it.'
        case 'document':
            return 'I have not written a message. This document holds what I want: respond to it.'
        case 'links':
            return 'I have not written a message. This document and the documents it links to hold what I want: respond to them.'
        default:
            return 'I have not written a message: respond to what I sent.'
    }
}

/** An image the person put in a message. */
export interface ChatImage {
    id: string
    name: string
    blob: Blob
}

/** One tool the model used while answering: a read of the graph, shown as a chip. */
export interface ToolUse {
    /** The chip's own id, unique within the turn. */
    id: string
    /**
     * The provider's id for the call, which its result names. Not unique across a turn's steps for
     * every provider: some local servers number each step's calls from 0 again.
     */
    callId: string
    /** What it did, in a few words: "Read Garden", "Searched for beans". */
    summary: string
    status: 'running' | 'done' | 'failed'
}

/** A page a web search answer drew on. */
export interface ChatSource {
    url: string
    title: string
}

export type TurnStatus = 'streaming' | 'done' | 'stopped' | 'failed'

/** The person's message and the model's reply to it. */
export interface Turn {
    id: string
    question: string
    images: ChatImage[]
    /** The reply's markdown, as much as has arrived. */
    answer: string
    connectionId: string
    modelId: string
    /** The model's name as the picker showed it, kept so a saved chat can name it. */
    modelLabel: string
    /** What the turn was allowed to read. */
    grant: GrantLevel
    /**
     * The documents sent whole with the question, and those left out for length, once known.
     * `excerpt`: only the outline around the chat's bullet was sent of the one document.
     * `unwritten`: the home is a Draft with no text yet, so nothing of it was sent.
     */
    context?: { included: string[]; leftOut: string[]; excerpt?: boolean; unwritten?: boolean }
    webSearch: boolean
    tools: ToolUse[]
    sources: ChatSource[]
    status: TurnStatus
    /** Why a failed turn failed, in the person's words. */
    error?: string
    askedAt: number
    /** Whether a Save has written the turn into the home document. */
    saved: boolean
}

export interface Chat {
    id: string
    title: string
    /** The document the chat was started in, by its name: its home. */
    home: string
    /** What the next message may read. */
    grant: GrantLevel
    /** The connection and model the next message goes to. */
    connectionId: string | null
    modelId: string | null
    /** Whether the next message may search the web, where web search is allowed. */
    webSearch: boolean
    turns: Turn[]
    createdAt: number
    updatedAt: number
}

/** A chat's title from its first message: the first line, cut short. */
export function titleFrom(question: string): string {
    const line = question.trim().split('\n')[0]?.trim() ?? ''
    if (line === '') return 'New chat'
    return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line
}

/** "Unsaved", or how many of the turns a Save has written. */
export function savedState(chat: Pick<Chat, 'turns'>): string {
    const saved = chat.turns.filter((turn) => turn.saved).length
    if (saved === 0) return 'Unsaved'
    return `Saved ${saved} of ${chat.turns.length} ${chat.turns.length === 1 ? 'turn' : 'turns'}`
}

/** A random id for a chat, a turn or an image. */
export function newId(prefix: string): string {
    return `${prefix}-${crypto.randomUUID()}`
}

/** Today on this device as `YYYY-MM-DD`, asked at the moment of use (tabs stay open for days). */
export function todayOnDevice(now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
