import { containsCipherFence } from '../protection/fence-info'
import { whenDocumentText } from '../draft'
import type { DocumentStore } from '../types'

/** Asked to print a Protected Document, which never prints (ADR 0207). */
export class ProtectedPrintError extends Error {
    readonly name = 'ProtectedPrintError'
}

/**
 * How long a document that is not loaded may take. Long enough for a folder on a network, since a
 * document given up on would print with no text and no word said.
 */
const LOAD_MS = 10_000

/** Whether the store shows `concept` as a Protected Document now, locked (its cipher fence) or unlocked. */
export function protectedNow(store: DocumentStore, concept: string): boolean {
    const doc = store.open(concept)
    return (doc as { isProtected?: boolean }).isProtected === true || containsCipherFence(doc.getText())
}

/**
 * The text of a document to print, as any open editor of it shows it. Refused for a Protected
 * Document, locked or not, whatever its menus offered. The workspace asks again before each
 * extension is asked for a picture and as the dialog opens, since protection can arrive meanwhile.
 */
export async function textToPrint(store: DocumentStore, concept: string): Promise<string> {
    const release = (store as { retainDocument?: (target: string) => () => void }).retainDocument?.(concept)
    try {
        const text = await whenDocumentText(store, store.open(concept), concept, LOAD_MS)
        if (protectedNow(store, concept) || containsCipherFence(text)) throw new ProtectedPrintError('This is a Protected Document')
        return text
    } finally {
        release?.()
    }
}
