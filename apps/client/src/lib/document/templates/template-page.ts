/**
 * What makes a document a [[Template]], and the part of it a copy takes (ADR 0144).
 *
 * One predicate for every reader, so the index, the `/Template` picker, the Journal Template's
 * setting and the Headless Client cannot disagree about which pages are Templates.
 */

import { parseFrontmatter } from '../../storage/fs/frontmatter'
import type { DocumentKind } from '../../storage/fs/identity'
import { lineFeedsOnly } from '../line-endings'
import { containsCipherFence } from '../protection/fence-info'

/**
 * True for a [[Page]] whose frontmatter says `template: true`. The value must be the boolean, as
 * `public` must be (publication.ts), so a quoted `"true"` or a name is not a Template. A
 * [[Journal Entry]] is never one: a day is not a pattern.
 */
export function isTemplate(frontmatter: Readonly<Record<string, unknown>>, kind: DocumentKind): boolean {
    return kind === 'page' && frontmatter.template === true
}

/**
 * The text a copy of the Template takes: everything below its frontmatter, without the blank
 * lines before and after it. The frontmatter itself is never copied, so a Template that says
 * `public: true` cannot make a copy public.
 */
export function templateBody(text: string): string {
    return withoutBlankEnds(parseFrontmatter(text).body)
}

/** What a store's index snapshot says of a document (`snapshotDocument`): its kind, body and mark. */
export interface TemplateSnapshot {
    kind: DocumentKind
    /** The body below the frontmatter. */
    text: string
    template?: boolean
}

/**
 * The body a copy of a Template takes, read from a store's snapshot of it, which reads the
 * document without opening an editor for it. Null when the document is gone, is not a Template,
 * or is protected: a [[Protected Document]] is never a Template, and its text never leaves it.
 */
export function templateBodyOf(snapshot: TemplateSnapshot | null | undefined): string | null {
    if (!snapshot || snapshot.template !== true || snapshot.kind !== 'page' || containsCipherFence(snapshot.text)) return null
    return withoutBlankEnds(snapshot.text)
}

/**
 * The body in the form the editor holds text: line feeds only (ADR 0112), since a file another app
 * wrote may end its lines otherwise and a copy is offset by the editor's own lines. Then without
 * the blank lines before and after it.
 */
function withoutBlankEnds(body: string): string {
    return lineFeedsOnly(body).replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '')
}
