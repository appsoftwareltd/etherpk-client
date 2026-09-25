/**
 * The upload seam refuses a locked Protected Document before a byte moves (`upload-activity.ts`):
 * the one check that covers the dialog, drag-and-drop and paste, surfaced as a failed Activity
 * so a refused drop is seen rather than silently dropped.
 */
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AssetStore, SavedAsset } from '$lib/storage/fs/asset-store'

import { type ProtectionStatus, setActiveProtectionStatus } from '../protection/active-protection'

import { isProtectedDocumentFacet } from './augmentations/protected-fence'
import { LOCKED_BODY_MESSAGE } from './body-writable'
import type { ImageOptimizer } from './image-optimize'
import { startAssetUpload, uploadDetail } from './upload-activity'

function status(readable: boolean): ProtectionStatus {
    return { reasonAt: () => 'locked', isReadable: () => readable, requestUnlock() {}, lockNow() {} }
}

/** A view over a real state (the predicate reads its facet) that records what it was asked to insert. */
function fakeView(isProtected: boolean) {
    const inserts: string[] = []
    const state = EditorState.create({
        doc: '---\ntitle: x\n---\n',
        extensions: [isProtectedDocumentFacet.of(() => isProtected)],
    })
    const view = {
        state,
        dispatch(spec: { changes?: { insert: string } }) {
            if (spec.changes) inserts.push(spec.changes.insert)
        },
    } as unknown as EditorView
    return { view, inserts }
}

function store() {
    const save = vi.fn(
        async ({ name }: { name: string; bytes: Uint8Array }): Promise<SavedAsset> => ({
            ref: `../assets/${name}`,
            name,
            stem: name.replace(/\.pdf$/, ''),
            isImage: false,
        }),
    )
    const s: AssetStore = {
        save,
        async readBytes() {
            return null
        },
        async resolve() {
            return null
        },
        dispose() {},
    }
    return { store: s, save }
}

const pdf = () => new File([new Uint8Array(4)], 'doc.pdf', { type: 'application/pdf' })

describe('startAssetUpload on a Protected Document', () => {
    afterEach(() => setActiveProtectionStatus(null))

    it('refuses while locked: the Activity fails with the locked message and the store never saves', async () => {
        setActiveProtectionStatus(status(false))
        const { view, inserts } = fakeView(true)
        const { store: s, save } = store()

        const activity = await startAssetUpload(view, s, [pdf()], 4)

        expect(activity.state).toBe('failed')
        expect(activity.detail).toBe(LOCKED_BODY_MESSAGE)
        expect(save).not.toHaveBeenCalled()
        expect(inserts).toEqual([])
    })

    it('uploads and inserts while unlocked', async () => {
        setActiveProtectionStatus(status(true))
        const { view, inserts } = fakeView(true)
        const { store: s, save } = store()

        const activity = await startAssetUpload(view, s, [pdf()], 4)

        expect(activity.state).toBe('done')
        expect(save).toHaveBeenCalledTimes(1)
        expect(inserts).toHaveLength(1)
    })

    it('leaves an ordinary document alone even with the graph locked', async () => {
        setActiveProtectionStatus(status(false))
        const { view } = fakeView(false)
        const { store: s, save } = store()

        const activity = await startAssetUpload(view, s, [pdf()], 4)

        expect(activity.state).toBe('done')
        expect(save).toHaveBeenCalledTimes(1)
    })
})

describe('startAssetUpload and Image Optimisation (ADR 0080)', () => {
    afterEach(() => setActiveProtectionStatus(null))

    const shot = () => new File([new Uint8Array(100)], 'shot.png', { type: 'image/png' })

    /** Halves a PNG into a WebP; records every file it was shown. */
    function halving() {
        const seen: string[] = []
        const optimizer: ImageOptimizer = async (file) => {
            seen.push(file.name)
            if (!file.name.endsWith('.png')) return { file, optimized: false }
            const half = new File([new Uint8Array(file.size / 2)], file.name.replace(/\.png$/, '.webp'), { type: 'image/webp' })
            return { file: half, optimized: true }
        }
        return { optimizer, seen }
    }

    it('optimises by default: every file passes through the optimiser and what it hands back is stored', async () => {
        const { view } = fakeView(false)
        const { store: s, save } = store()
        const { optimizer, seen } = halving()

        const activity = await startAssetUpload(view, s, [shot(), pdf()], 4, { optimizer })

        expect(activity.state).toBe('done')
        expect(seen).toEqual(['shot.png', 'doc.pdf'])
        expect(save.mock.calls.map(([f]) => [f.name, f.bytes.length])).toEqual([
            ['shot.webp', 50],
            ['doc.pdf', 4],
        ])
    })

    it('stores files exactly as given when optimisation is switched off for the upload', async () => {
        const { view } = fakeView(false)
        const { store: s, save } = store()
        const { optimizer, seen } = halving()

        await startAssetUpload(view, s, [shot()], 4, { optimizer, optimizeImages: false })

        expect(seen).toEqual([])
        expect(save.mock.calls.map(([f]) => [f.name, f.bytes.length])).toEqual([['shot.png', 100]])
    })

    it('reports the bytes before and after in the outcome line when something shrank', async () => {
        const { view } = fakeView(false)
        const { store: s } = store()

        const activity = await startAssetUpload(view, s, [shot(), pdf()], 4, { optimizer: halving().optimizer })

        expect(activity.detail).toBe('2 assets uploaded, 104 B → 54 B')
    })
})

describe('uploadDetail', () => {
    it('reads as before when nothing was optimised', () => {
        expect(uploadDetail({ uploaded: 1, reused: 0, optimized: 0, givenBytes: 10, storedBytes: 10 })).toBe('1 asset uploaded')
        expect(uploadDetail({ uploaded: 2, reused: 2, optimized: 0, givenBytes: 10, storedBytes: 10 })).toBe(
            '2 assets already in this graph, reused',
        )
    })

    it('appends the batch bytes before and after when a stored file was optimised', () => {
        expect(uploadDetail({ uploaded: 1, reused: 0, optimized: 1, givenBytes: 3_250_585, storedBytes: 491_520 })).toBe(
            '1 asset uploaded, 3.1 MB → 480.0 KB',
        )
        expect(uploadDetail({ uploaded: 3, reused: 1, optimized: 2, givenBytes: 2000, storedBytes: 900 })).toBe(
            '2 assets uploaded, 1 already in this graph, reused, 2.0 KB → 900 B',
        )
    })
})
