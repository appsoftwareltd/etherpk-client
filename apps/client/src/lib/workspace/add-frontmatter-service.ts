/**
 * The workspace's side of **Add frontmatter**: writing what `add-frontmatter.ts` plans into a
 * document, through its open editor or through the store.
 *
 * Through the editor when the document is the one being edited: the addition is then one
 * transaction, so a single Mod-z takes it back, and the caret lands on the first value added.
 * Through the store otherwise, the way Publish… writes its keys (`publish-service.ts`): only the
 * block is replaced, and on a synced graph that is one change for the other members.
 */
import { isolateHistory } from '@codemirror/commands'
import type { EditorState, TransactionSpec } from '@codemirror/state'

import { type AddableKey, type AddedFrontmatter, withAddedFrontmatter } from '$lib/document/frontmatter/add-frontmatter'
import { isJournalConcept } from '$lib/document/journal-concept'
import { canCreateDocuments } from '$lib/document/draft'
import { DocumentNotFoundError } from '$lib/document/types'
import { editorHistory } from '$lib/document/view/editor-history'
import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'

import { type FrontmatterStore, registryAliases } from './publish-service'

/** The block of `text`, delimiters included, or '' when it has none. */
function blockOf(text: string): string {
    const span = frontmatterSpan(text)
    return span ? text.slice(0, span.end) : ''
}

/** Whether the store holds a document for the concept yet; a Draft's concept has none. */
function exists(store: FrontmatterStore, concept: string): boolean {
    try {
        store.open(concept)
        return true
    } catch (error) {
        if (error instanceof DocumentNotFoundError) return false
        throw error
    }
}

/**
 * The document's text as the dialog should plan from: what the store holds, edits still inside a
 * Filesystem store's autosave included, or '' for a concept with no document yet.
 */
export async function readForAddFrontmatter(store: FrontmatterStore, concept: string): Promise<string> {
    if (!exists(store, concept)) return ''
    await store.whenReady?.(concept)
    await store.flushDocument?.(concept)
    return store.open(concept).getText()
}

/**
 * Add the keys through the store. A concept with no document yet (a [[Draft]]) becomes one
 * first: laying out its keys is a decision to keep it.
 */
export async function addFrontmatterThroughStore(store: FrontmatterStore, concept: string, keys: readonly AddableKey[]): Promise<AddedFrontmatter> {
    if (!exists(store, concept)) {
        if (!canCreateDocuments(store)) throw new Error(`“${concept}” has no document yet, and this graph cannot create one here.`)
        if (isJournalConcept(concept)) await store.createJournal(concept, '')
        else await store.createPage(concept, '')
    }
    await store.whenReady?.(concept)
    // Edits still inside a Filesystem store's autosave are written first, so the listing the
    // aliases come from agrees with the text (the same order `rewriteFrontmatter` keeps).
    await store.flushDocument?.(concept)
    const handle = store.open(concept)
    const text = handle.getText()
    const added = withAddedFrontmatter(text, keys, { title: concept, aliases: registryAliases(store, concept) })
    if (added.text === text) return added
    handle.applyChange({ from: 0, to: blockOf(text).length, insert: blockOf(added.text) }, 'external')
    await store.flushDocument?.(concept)
    return added
}

/** The part of an `EditorView` this needs, so it tests without a DOM. */
export interface FrontmatterEditorView {
    readonly state: EditorState
    dispatch(spec: TransactionSpec): void
}

/**
 * Add the keys through the document's open editor: one transaction that replaces only the
 * block, so one undo removes it, with the caret placed on the first value added.
 */
export function addFrontmatterThroughEditor(view: FrontmatterEditorView, concept: string, keys: readonly AddableKey[], aliases: readonly string[]): AddedFrontmatter {
    const text = view.state.doc.toString()
    const added = withAddedFrontmatter(text, keys, { title: concept, aliases })
    if (added.text === text) return added
    // A step of its own on either history: typing just before it, or the value typed straight
    // after it, must not undo with it.
    const history = view.state.facet(editorHistory)
    history.closeStep?.()
    view.dispatch({
        changes: { from: 0, to: blockOf(text).length, insert: blockOf(added.text) },
        selection: added.caret === null ? undefined : { anchor: added.caret },
        scrollIntoView: true,
        userEvent: 'input.frontmatter',
        annotations: isolateHistory.of('full'),
    })
    history.closeStep?.()
    return added
}
