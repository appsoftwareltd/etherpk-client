/**
 * The one predicate every editing Command and the asset upload ask before writing to a body
 * (`body-writable.ts`): per view, answered by the document's own facet and the session accessor.
 */
import { EditorState } from '@codemirror/state'
import { afterEach, describe, expect, it } from 'vitest'

import { type ProtectionStatus, setActiveProtectionStatus } from '../protection/active-protection'

import { isProtectedDocumentFacet, protectedFenceAugmentation } from './augmentations/protected-fence'
import { bodyWritable } from './body-writable'

function status(readable: boolean): ProtectionStatus {
    return { reasonAt: () => 'locked', isReadable: () => readable, requestUnlock() {}, lockNow() {} }
}

const protectedState = (isProtected: boolean) =>
    EditorState.create({ doc: '---\ntitle: x\n---\n', extensions: [isProtectedDocumentFacet.of(() => isProtected)] })

describe('bodyWritable', () => {
    afterEach(() => setActiveProtectionStatus(null))

    it('is true for an ordinary document whatever the session says', () => {
        expect(bodyWritable(protectedState(false), null)).toBe(true)
        expect(bodyWritable(protectedState(false), status(false))).toBe(true)
    })

    it('is true for an editor with no fence augmentation at all', () => {
        expect(bodyWritable(EditorState.create({ doc: 'plain' }), status(false))).toBe(true)
    })

    it('follows the session for a Protected Document: readable means writable', () => {
        expect(bodyWritable(protectedState(true), status(true))).toBe(true)
        expect(bodyWritable(protectedState(true), status(false))).toBe(false)
    })

    it('treats an absent session as locked, like every other consumer of the accessor', () => {
        expect(bodyWritable(protectedState(true), null)).toBe(false)
    })

    it('reads the active accessor by default', () => {
        setActiveProtectionStatus(status(false))
        expect(bodyWritable(protectedState(true))).toBe(false)
        setActiveProtectionStatus(status(true))
        expect(bodyWritable(protectedState(true))).toBe(true)
    })

    it('is provided by the fence augmentation itself, from its isProtected option', () => {
        const state = EditorState.create({ doc: '', extensions: protectedFenceAugmentation({ isProtected: () => true }) })
        expect(bodyWritable(state, status(false))).toBe(false)
        expect(bodyWritable(state, status(true))).toBe(true)
    })

    it('stays false while the fence is still in the text, even once the session reads unlocked', () => {
        const fence = '---\ntitle: x\n---\n\n```etherpk-cipher\nAAAA\n```\n'
        const state = EditorState.create({ doc: fence, extensions: protectedFenceAugmentation({ isProtected: () => true }) })
        expect(bodyWritable(state, status(true))).toBe(false)
    })

    it('lets any provider of the facet say protected', () => {
        const state = EditorState.create({
            doc: '',
            extensions: [isProtectedDocumentFacet.of(() => false), isProtectedDocumentFacet.of(() => true)],
        })
        expect(bodyWritable(state, status(false))).toBe(false)
    })
})
