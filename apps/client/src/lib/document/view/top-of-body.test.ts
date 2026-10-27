/**
 * Where the caret goes when a document is shown from its top (top-of-body.ts, ADR 0154), placed the
 * way DocumentView places it: as a selection the app sets, through the caret clamp and the
 * frontmatter boundary filter.
 */
import { describe, expect, it } from 'vitest'

import { editorFixture } from './testing/editor-state-fixture'
import { topOfBody } from './top-of-body'
import { placeSelection } from './view-position'

/** The fixture shown from its top: the caret `topOfBody` places, after the transaction filters. */
function shownFromTop(text: string) {
    const editor = editorFixture(text)
    editor.dispatch(editor.state.update(placeSelection(topOfBody(editor.state))))
    return editor
}

describe('topOfBody', () => {
    it('puts the caret on the first line, past its bullet marker', () => {
        expect(shownFromTop('- water the beans\n- weed the beds|').fixture()).toBe('- |water the beans\n- weed the beds')
    })

    it('puts it on the first line of the body, below the frontmatter', () => {
        expect(shownFromTop('---\naliases:\n  - Plot\n---\n- water the beans|').fixture()).toBe(
            '---\naliases:\n  - Plot\n---\n- |water the beans',
        )
    })

    it('puts it on an empty first body line, and in an empty document', () => {
        expect(shownFromTop('---\ntitle: Garden\n|---\n').fixture()).toBe('---\ntitle: Garden\n---\n|')
        expect(shownFromTop('|').fixture()).toBe('|')
    })

    it('never puts it at the start of the closer when the frontmatter has no body line after it', () => {
        // Typed at the closer's start, `first ` would make `first ---` and turn the block into prose.
        const editor = shownFromTop('---\ntitle: Garden\n|---')
        expect(editor.fixture()).toBe('---\ntitle: Garden\n---|')
    })
})
