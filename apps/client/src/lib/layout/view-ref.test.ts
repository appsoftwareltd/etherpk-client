import { describe, expect, it } from 'vitest'

import {
    type ViewRef,
    isRegisterableViewKind,
    namespacedViewKind,
    parseViewKey,
    sameView,
    viewKey,
} from './view-ref'

describe('view identity', () => {
    it('derives a stable key from kind and target', () => {
        const ref: ViewRef = { kind: 'document', target: 'doc-A' }
        expect(viewKey(ref)).toBe('document:doc-A')
    })

    it('produces the same key for equal refs regardless of object identity', () => {
        expect(viewKey({ kind: 'backlinks', target: 'Physics' })).toBe(
            viewKey({ kind: 'backlinks', target: 'Physics' }),
        )
    })

    it('distinguishes views that differ only by kind or only by target', () => {
        expect(viewKey({ kind: 'document', target: 'x' })).not.toBe(
            viewKey({ kind: 'asset', target: 'x' }),
        )
        expect(viewKey({ kind: 'document', target: 'x' })).not.toBe(
            viewKey({ kind: 'document', target: 'y' }),
        )
    })

    it('round-trips a key back into a ViewRef', () => {
        const ref: ViewRef = { kind: 'document', target: 'doc-A' }
        expect(parseViewKey(viewKey(ref))).toEqual(ref)
    })

    it('preserves colons that appear inside the target when parsing', () => {
        // Targets may legitimately contain colons (e.g. scoped concepts / urls),
        // so only the first colon separates kind from target.
        const ref: ViewRef = { kind: 'asset', target: 'https://example.com/a' }
        const key = viewKey(ref)
        expect(key).toBe('asset:https://example.com/a')
        expect(parseViewKey(key)).toEqual(ref)
    })

    it('treats refs with the same key as the same view', () => {
        expect(sameView({ kind: 'document', target: 'a' }, { kind: 'document', target: 'a' })).toBe(true)
        expect(sameView({ kind: 'document', target: 'a' }, { kind: 'document', target: 'b' })).toBe(false)
    })
})

describe('view kind namespacing', () => {
    it('namespaces an extension kind with a dot, not the key separator', () => {
        expect(namespacedViewKind('acme-diagrams', 'flow')).toBe('acme-diagrams.flow')
    })

    it('keeps a namespaced kind intact through a view key round-trip', () => {
        // The dot namespace must not collide with the colon kind/target separator.
        const ref: ViewRef = { kind: namespacedViewKind('acme-diagrams', 'flow'), target: 'chart-1' }
        expect(viewKey(ref)).toBe('acme-diagrams.flow:chart-1')
        expect(parseViewKey(viewKey(ref))).toEqual(ref)
    })

    it('accepts core and namespaced kinds, rejects empty or colon-bearing ones', () => {
        expect(isRegisterableViewKind('document')).toBe(true)
        expect(isRegisterableViewKind('acme-diagrams.flow')).toBe(true)
        expect(isRegisterableViewKind('')).toBe(false)
        expect(isRegisterableViewKind('acme:flow')).toBe(false)
    })
})
