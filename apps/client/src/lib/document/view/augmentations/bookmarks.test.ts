/**
 * Which lines can be bookmarked (bookmarks.ts `bookmarkRefusal`): not a [[Draft]]'s, not protected
 * text, not a blank line (ADR 0159).
 */

import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorDocument } from '../editor-document'
import { bookmarkRefusal, bookmarksAugmentation } from './bookmarks'
import { isProtectedDocumentFacet } from './protected-document'

function stateOf(doc: string, options: { draft?: boolean; protectedDoc?: boolean } = {}) {
    return EditorState.create({
        doc,
        extensions: [
            editorDocument.of({ concept: 'Garden' }),
            bookmarksAugmentation({ draft: options.draft }),
            isProtectedDocumentFacet.of(() => options.protectedDoc ?? false),
        ],
    })
}

describe('bookmarkRefusal', () => {
    it('lets a line with words be bookmarked', () => {
        expect(bookmarkRefusal(stateOf('- water the beans'), 1)).toBeNull()
    })

    it('refuses a blank line, a Draft and protected text, saying why', () => {
        for (const empty of ['   ', '- ', '- [ ] ', '## ', '1. ', '  - ']) {
            expect(bookmarkRefusal(stateOf(`- water the beans\n${empty}`), 2), JSON.stringify(empty)).toMatch(/no words/)
        }
        expect(bookmarkRefusal(stateOf('- water the beans', { draft: true }), 1)).toMatch(/not written yet/)
        expect(bookmarkRefusal(stateOf('- water the beans', { protectedDoc: true }), 1)).toBe("Protected text can't be bookmarked.")
    })
})
