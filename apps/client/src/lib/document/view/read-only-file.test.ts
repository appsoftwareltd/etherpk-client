import { describe, expect, it } from 'vitest'

import { EXTERNAL } from './cm-document'
import { listItemBindings, plainLists } from './list-items-keymap'
import { readOnlyFile } from './read-only-file'
import { editorFixture } from './testing/editor-state-fixture'

const readOnly = (text: string) => editorFixture(text, { extensions: [readOnlyFile(), plainLists.of(true)] })

describe('an editor over a file that must not be edited', () => {
    it('takes no change from a key, whichever command the key runs', () => {
        for (const key of ['Tab', 'Shift-Tab', 'Enter', 'Backspace', 'Alt-ArrowUp', 'Mod-Enter']) {
            const dashes = readOnly('- beds\n  - fe|nce')
            dashes.key(key)
            expect(dashes.text(), key).toBe('- beds\n  - fence')

            const stars = readOnly('* beds\n* fe|nce')
            for (const binding of listItemBindings()) if (binding.key === key) binding.run?.(stars as never)
            expect(stars.text(), key).toBe('* beds\n* fence')
        }
    })

    it('takes no typing and no paste', () => {
        const editor = readOnly('- beds|')
        editor.type('x')
        editor.paste('more\nlines')
        expect(editor.text()).toBe('- beds')
    })

    it('still shows what the store reads from the file', () => {
        const editor = readOnly('- beds|')
        editor.dispatch(editor.state.update({ changes: { from: 0, to: 6, insert: '- rows' }, annotations: EXTERNAL.of(true) }))
        expect(editor.text()).toBe('- rows')
    })
})
