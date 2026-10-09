/**
 * Whether an editor's document is a [[Protected Document]], as a facet of the editor's own state.
 *
 * Supplied per editor by the View, from the document itself, because the editor cannot tell on
 * its own once unlocked: the projected text is frontmatter followed by ordinary plaintext, with
 * no fence left to find. Kept in a module of its own, with no imports beyond CodeMirror, so the
 * modules every augmentation shares can read it without importing the protected fence's guards
 * and everything they bring (`protected-fence.ts` re-exports it).
 */
import { Facet } from '@codemirror/state'

/** The document's own answer to "am I a Protected Document?". */
export type IsProtectedDocument = () => boolean

/**
 * The document's answer, readable from any editor state: what a Command or an upload asks before
 * writing to the body (`view/body-writable.ts`), since the active-view accessor cannot say which
 * pane a drop landed on. Combined so that any provider saying protected wins; an editor with no
 * provider reads as not protected.
 */
export const isProtectedDocumentFacet = Facet.define<IsProtectedDocument, IsProtectedDocument>({
    combine: (values) => () => values.some((isProtected) => isProtected()),
})
