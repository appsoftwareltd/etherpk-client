/**
 * In-editor upload ordering. Uploads now run concurrently (dropping twenty files was twenty
 * round-trip latencies in a row), which means completions arrive out of order - but each
 * insert's position is derived from the previous one, so DOCUMENT order must still follow
 * the order the files were given.
 *
 * Non-image assets are used throughout: `insertAssetMarkdown` takes a branch that needs only
 * `view.dispatch`, so the ordering contract can be pinned without a DOM-backed EditorView.
 */
import { describe, expect, it } from 'vitest'
import type { EditorView } from '@codemirror/view'

import type { AssetStore, SavedAsset } from '$lib/storage/fs/asset-store'

import { uploadAndInsert } from './asset-upload'
import type { ImageOptimizer } from './image-optimize'
import { markEditorTornDown, recordEditorSuccessor } from './editor-succession'

/**
 * Records the text inserted at each dispatch, in the order the editor received them. `length` is
 * the document length the succession clamp reads; generous by default so it never bites here.
 */
function fakeView(length = 10_000) {
    const inserts: { from: number; insert: string }[] = []
    const view = {
        state: { doc: { length } },
        dispatch(spec: { changes: { from: number; insert: string } }) {
            inserts.push({ from: spec.changes.from, insert: spec.changes.insert })
        },
    } as unknown as EditorView
    return { view, inserts }
}

function file(name: string, size = 10): File {
    return new File([new Uint8Array(size)], name, { type: 'application/pdf' })
}

/** Finishes in reverse order, so anything depending on completion order breaks visibly. */
function reversingStore(count: number, onActive?: (n: number) => void): AssetStore {
    let active = 0
    return {
        async save({ name }): Promise<SavedAsset> {
            active += 1
            onActive?.(active)
            const index = Number(/(\d+)/.exec(name)?.[1] ?? 0)
            await new Promise((r) => setTimeout(r, (count - index) * 3))
            active -= 1
            return { ref: `../assets/${name}`, name, stem: name.replace(/\.pdf$/, ''), isImage: false }
        },
        async readBytes() {
            return null
        },
        async resolve() {
            return null
        },
        dispose() {},
    }
}

describe('uploadAndInsert', () => {
    it('inserts in FILE order even when uploads complete in reverse', async () => {
        const COUNT = 6
        const { view, inserts } = fakeView()
        const files = Array.from({ length: COUNT }, (_, n) => file(`doc${n}.pdf`))

        const result = await uploadAndInsert(view, reversingStore(COUNT), files, 0, { concurrency: 4 })

        expect(result).toEqual({
            uploaded: COUNT,
            reused: 0,
            cancelled: false,
            optimized: 0,
            givenBytes: COUNT * 10,
            storedBytes: COUNT * 10,
        })
        expect(inserts.map((i) => i.insert)).toEqual(
            Array.from({ length: COUNT }, (_, n) => `[doc${n}](../assets/doc${n}.pdf)`),
        )
        // Positions advance monotonically: each insert lands after the previous one.
        let last = -1
        for (const insert of inserts) {
            expect(insert.from).toBeGreaterThan(last)
            last = insert.from
        }
    })

    it('counts the assets the graph already held (reused) separately from the total', async () => {
        // A synced graph answers a begin call with the existing id when it already holds the
        // bytes (ADR 0053); the store flags that so the toast can say "reused", not "uploaded".
        const { view, inserts } = fakeView()
        const store: AssetStore = {
            async save({ name }): Promise<SavedAsset> {
                const stem = name.replace(/\.pdf$/, '')
                return { ref: `../assets/${name}`, name, stem, isImage: false, reused: stem === 'again' }
            },
            async readBytes() {
                return null
            },
            async resolve() {
                return null
            },
            dispose() {},
        }
        const result = await uploadAndInsert(view, store, [file('new.pdf'), file('again.pdf')], 0)
        // The byte figures cover only what was stored: the reused file moved nothing.
        expect(result).toEqual({ uploaded: 2, reused: 1, cancelled: false, optimized: 0, givenBytes: 10, storedBytes: 10 })
        // A reused asset is still referenced in the document exactly like a fresh one.
        expect(inserts.map((i) => i.insert)).toEqual(['[new](../assets/new.pdf)', '[again](../assets/again.pdf)'])
    })

    it('uploads in parallel, bounded by the limit', async () => {
        let peak = 0
        const { view } = fakeView()
        const files = Array.from({ length: 8 }, (_, n) => file(`doc${n}.pdf`))

        await uploadAndInsert(view, reversingStore(8, (a) => (peak = Math.max(peak, a))), files, 0, {
            concurrency: 3,
        })

        expect(peak).toBeGreaterThan(1)
        expect(peak).toBeLessThanOrEqual(3)
    })

    it('reports cumulative bytes, ending on the batch total', async () => {
        const { view } = fakeView()
        const files = [file('a.pdf', 100), file('b.pdf', 250)]
        const seen: number[] = []

        const store: AssetStore = {
            async save({ name, bytes }, onBytes): Promise<SavedAsset> {
                onBytes?.(bytes.length)
                return { ref: `../assets/${name}`, name, stem: name, isImage: false }
            },
            async readBytes() {
                return null
            },
            async resolve() {
                return null
            },
            dispose() {},
        }

        await uploadAndInsert(view, store, files, 0, { onBytes: (done) => seen.push(done) })

        expect(seen).toEqual([...seen].sort((a, b) => a - b)) // monotonic
        expect(seen.at(-1)).toBe(350)
    })

    it('keeps what landed when cancelled, and reports it as cancelled', async () => {
        // ADR 0035 §3: an asset upload does NOT roll back - each asset is independent and
        // its reference is already in the user's document.
        const controller = new AbortController()
        const { view, inserts } = fakeView()
        const files = Array.from({ length: 20 }, (_, n) => file(`doc${n}.pdf`))

        let started = 0
        const store: AssetStore = {
            async save({ name }): Promise<SavedAsset> {
                started += 1
                if (started === 3) controller.abort()
                await new Promise((r) => setTimeout(r, 2))
                return { ref: `../assets/${name}`, name, stem: name, isImage: false }
            },
            async readBytes() {
                return null
            },
            async resolve() {
                return null
            },
            dispose() {},
        }

        const result = await uploadAndInsert(view, store, files, 0, {
            signal: controller.signal,
            concurrency: 2,
        })

        expect(result.cancelled).toBe(true)
        expect(started).toBeLessThan(20)
        // Whatever finished was inserted - never silently discarded.
        expect(inserts.length).toBe(result.uploaded)
    })

    it('inserts the completed prefix even when a later file fails', async () => {
        const { view, inserts } = fakeView()
        const files = Array.from({ length: 4 }, (_, n) => file(`doc${n}.pdf`))

        const store: AssetStore = {
            async save({ name }): Promise<SavedAsset> {
                await new Promise((r) => setTimeout(r, 1))
                if (name === 'doc2.pdf') throw new Error('502 Bad Gateway')
                return { ref: `../assets/${name}`, name, stem: name, isImage: false }
            },
            async readBytes() {
                return null
            },
            async resolve() {
                return null
            },
            dispose() {},
        }

        await expect(uploadAndInsert(view, store, files, 0, { concurrency: 1 })).rejects.toThrow('502')
        // doc0 and doc1 uploaded successfully; stranding their references would leave paid-for
        // assets unreachable in the graph.
        expect(inserts.map((i) => i.insert)).toEqual([
            '[doc0.pdf](../assets/doc0.pdf)',
            '[doc1.pdf](../assets/doc1.pdf)',
        ])
    })

    it('inserts into the editor that replaced the one it was handed, at the mapped position', async () => {
        // A [[Draft]]'s first keystroke promotes it, and the promotion REMOUNTS the editor
        // (ADR 0050): the `EditorView` the upload dialog captured is destroyed by the time the
        // bytes land, and CodeMirror swallows a dispatch on a destroyed view without a word. The
        // upload has to follow the succession, or the asset is stored and referenced by nothing.
        const captured = fakeView()
        const successor = fakeView()
        let release: () => void = () => {}
        const held = new Promise<void>((r) => (release = r))
        const store: AssetStore = {
            async save({ name }): Promise<SavedAsset> {
                await held
                return { ref: `../assets/${name}`, name, stem: name, isImage: false }
            },
            async readBytes() {
                return null
            },
            async resolve() {
                return null
            },
            dispose() {},
        }

        // Caret at 4 in the Draft; the promoted document carries a 7-character prefix ahead of the
        // Draft's text (a Filesystem Backend's frontmatter block - zero on a Server Backend).
        const run = uploadAndInsert(captured.view, store, [file('a.pdf'), file('b.pdf')], 4, { concurrency: 1 })
        recordEditorSuccessor(captured.view, successor.view, { shift: 7, bodyStart: () => 7 })
        release()
        await run

        expect(captured.inserts).toEqual([])
        expect(successor.inserts.map((i) => i.from)).toEqual([11, 11 + '[a.pdf](../assets/a.pdf)'.length])
        expect(successor.inserts.map((i) => i.insert)).toEqual(['[a.pdf](../assets/a.pdf)', '[b.pdf](../assets/b.pdf)'])
    })

    it('clamps the position into a successor that is shorter than where the caret was', async () => {
        // A Draft with typed text superseded by a page created elsewhere, or a document protected
        // while the dialog was open: the successor shows different text, and an offset past its end
        // would make CodeMirror throw - failing the Activity with the asset stored and unreferenced.
        const captured = fakeView()
        const successor = fakeView(5)
        const store = heldStore()

        const run = uploadAndInsert(captured.view, store.store, [file('a.pdf')], 40)
        recordEditorSuccessor(captured.view, successor.view)
        store.release()
        await run

        expect(captured.inserts).toEqual([])
        expect(successor.inserts.map((i) => i.from)).toEqual([5])
    })

    it('clamps the position past a successor’s frontmatter when the remount was not a promotion', async () => {
        // Offset 0 of a page with a frontmatter block is inside `---`; an insert there dissolves the
        // block. A non-promotion remount records where the body starts, and the position is held to it.
        const captured = fakeView()
        const successor = fakeView()
        const store = heldStore()

        const run = uploadAndInsert(captured.view, store.store, [file('a.pdf')], 0)
        recordEditorSuccessor(captured.view, successor.view, { bodyStart: () => 12 })
        store.release()
        await run

        expect(successor.inserts.map((i) => i.from)).toEqual([12])
    })

    it('reads where the successor’s body starts when it inserts, not when the remount was recorded', async () => {
        // A Filesystem document mounts over an EMPTY buffer and shows its frontmatter only once
        // the read lands, so at remount time there is no block to measure. Asked at insert time,
        // the block that has since arrived is respected.
        const captured = fakeView()
        const successor = fakeView()
        const store = heldStore()
        let bodyStart = 0 // nothing read yet

        const run = uploadAndInsert(captured.view, store.store, [file('a.pdf')], 0)
        recordEditorSuccessor(captured.view, successor.view, { bodyStart: () => bodyStart })
        bodyStart = 17 // `---\ntitle: Foo\n---\n` landed
        store.release()
        await run

        expect(successor.inserts.map((i) => i.from)).toEqual([17])
    })

    it('names every asset that was stored before the dead end was noticed, and admits no more', async () => {
        // A three-file drop; the tab closes while all three are uploading. Whatever completes is
        // stored and unreferenced, and the message has to say so for each of them - not just the
        // first - because nothing else will. Files not yet started are not uploaded at all.
        const captured = fakeView()
        let started = 0
        let release: () => void = () => {}
        const held = new Promise<void>((r) => (release = r))
        const store: AssetStore = {
            async save({ name }): Promise<SavedAsset> {
                started += 1
                await held
                return { ref: `../assets/${name}`, name, stem: name, isImage: false }
            },
            async readBytes() {
                return null
            },
            async resolve() {
                return null
            },
            dispose() {},
        }

        const run = uploadAndInsert(captured.view, store, [file('a.pdf'), file('b.pdf'), file('c.pdf')], 0, {
            concurrency: 2,
        })
        await new Promise((r) => setTimeout(r, 0)) // a and b are in flight; c is queued
        markEditorTornDown(captured.view)
        release()

        await expect(run).rejects.toThrow(/"a\.pdf", "b\.pdf" are stored but not referenced/)
        expect(started).toBe(2)
        expect(captured.inserts).toEqual([])
    })

    it('fails, naming the asset, when the editor it started in was torn down with no successor', async () => {
        // The tab was closed mid-upload. The bytes are in the graph; dispatching into the dead view
        // would say nothing at all, so the Activity fails with what to do about the stored asset.
        const captured = fakeView()
        const store = heldStore()

        const run = uploadAndInsert(captured.view, store.store, [file('a.pdf')], 0)
        markEditorTornDown(captured.view)
        store.release()

        await expect(run).rejects.toThrow(/"a\.pdf" is stored but not referenced/)
        expect(captured.inserts).toEqual([])
    })
})

/** A store whose uploads finish only when the test says so - the window a remount lands in. */
function heldStore(): { store: AssetStore; release: () => void } {
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    return {
        release: () => release(),
        store: {
            async save({ name }): Promise<SavedAsset> {
                await held
                return { ref: `../assets/${name}`, name, stem: name, isImage: false }
            },
            async readBytes() {
                return null
            },
            async resolve() {
                return null
            },
            dispose() {},
        },
    }
}

describe('uploadAndInsert with an image optimiser (ADR 0080)', () => {
    /** Records what the store was asked to save, and hands back a ref built from that name. */
    function recordingStore() {
        const saved: { name: string; size: number; type: string }[] = []
        const store: AssetStore = {
            async save({ name, bytes, type }, onBytes): Promise<SavedAsset> {
                saved.push({ name, size: bytes.length, type })
                onBytes?.(bytes.length)
                const stem = name.replace(/\.[^.]+$/, '')
                // Never an image: the image branch of insertAssetMarkdown needs a real
                // EditorState, and what is under test here is what reaches the store.
                return { ref: `../assets/${name}`, name, stem, isImage: false }
            },
            async readBytes() {
                return null
            },
            async resolve() {
                return null
            },
            dispose() {},
        }
        return { store, saved }
    }

    /** Halves every PNG into a WebP of the same stem; leaves everything else exactly as given. */
    const halvingOptimizer: ImageOptimizer = async (file) => {
        if (!file.name.endsWith('.png')) return { file, optimized: false }
        const half = new File([new Uint8Array(file.size / 2)], file.name.replace(/\.png$/, '.webp'), {
            type: 'image/webp',
        })
        return { file: half, optimized: true }
    }

    it('stores what the optimiser hands back, under its name and type, and references that', async () => {
        const { view, inserts } = fakeView()
        const { store, saved } = recordingStore()
        const shot = new File([new Uint8Array(100)], 'shot.png', { type: 'image/png' })

        await uploadAndInsert(view, store, [shot, file('doc.pdf', 20)], 0, { optimize: halvingOptimizer })

        expect(saved).toEqual([
            { name: 'shot.webp', size: 50, type: 'image/webp' },
            { name: 'doc.pdf', size: 20, type: 'application/pdf' },
        ])
        expect(inserts.map((i) => i.insert)).toEqual(['[shot](../assets/shot.webp)', '[doc](../assets/doc.pdf)'])
    })

    it('counts optimised files and the batch bytes before and after', async () => {
        const { view } = fakeView()
        const { store } = recordingStore()
        const files = [
            new File([new Uint8Array(100)], 'a.png', { type: 'image/png' }),
            new File([new Uint8Array(40)], 'b.png', { type: 'image/png' }),
            file('c.pdf', 20),
        ]

        const result = await uploadAndInsert(view, store, files, 0, { optimize: halvingOptimizer })

        expect(result).toEqual({ uploaded: 3, reused: 0, cancelled: false, optimized: 2, givenBytes: 160, storedBytes: 90 })
    })

    it('shrinks the reported total by each saving as it is found, ending with done equal to total', async () => {
        const { view } = fakeView()
        const { store } = recordingStore()
        const seen: { done: number; total: number }[] = []
        const files = [new File([new Uint8Array(100)], 'a.png', { type: 'image/png' }), file('b.pdf', 250)]

        await uploadAndInsert(view, store, files, 0, {
            optimize: halvingOptimizer,
            concurrency: 1,
            onBytes: (done, total) => seen.push({ done, total }),
        })

        // 350 given; a.png halves, so the bar's denominator settles at 300 and done reaches it.
        expect(seen.at(-1)).toEqual({ done: 300, total: 300 })
        const totals = seen.map((s) => s.total)
        expect(totals).toEqual([...totals].sort((x, y) => y - x)) // only ever shrinks
        expect(Math.max(...totals)).toBeLessThanOrEqual(350)
    })

    it('leaves every file alone when no optimiser is given', async () => {
        const { view } = fakeView()
        const { store, saved } = recordingStore()
        const shot = new File([new Uint8Array(100)], 'shot.png', { type: 'image/png' })

        const result = await uploadAndInsert(view, store, [shot], 0)

        expect(saved).toEqual([{ name: 'shot.png', size: 100, type: 'image/png' }])
        expect(result.optimized).toBe(0)
    })

    it('counts a reused file in neither total: the saving describes only bytes that moved', async () => {
        // The graph already held the optimised bytes (ADR 0053): nothing was uploaded for it, so
        // a saving line built on it would claim a saving on an upload that never happened.
        const { view } = fakeView()
        const store: AssetStore = {
            async save({ name }): Promise<SavedAsset> {
                const stem = name.replace(/\.[^.]+$/, '')
                return { ref: `../assets/${name}`, name, stem, isImage: false, reused: name === 'a.webp' }
            },
            async readBytes() {
                return null
            },
            async resolve() {
                return null
            },
            dispose() {},
        }
        const files = [new File([new Uint8Array(100)], 'a.png', { type: 'image/png' }), file('b.pdf', 20)]

        const result = await uploadAndInsert(view, store, files, 0, { optimize: halvingOptimizer })

        expect(result).toEqual({ uploaded: 2, reused: 1, cancelled: false, optimized: 0, givenBytes: 20, storedBytes: 20 })
    })

    it('cancelling stops the encodes still queued: a file whose turn had not come is neither encoded nor saved', async () => {
        // Encodes queue behind one another after the pool has admitted their files, so without
        // a check at the head of the queue a cancel would let every admitted file through - each
        // one encoded, read and saved after the user said stop.
        const controller = new AbortController()
        const encoded: string[] = []
        const optimizer: ImageOptimizer = async (f) => {
            encoded.push(f.name)
            if (f.name === 'doc1.pdf') controller.abort()
            return { file: f, optimized: false }
        }
        const { view } = fakeView()
        const { store, saved } = recordingStore()
        const files = Array.from({ length: 6 }, (_, n) => file(`doc${n}.pdf`))

        const result = await uploadAndInsert(view, store, files, 0, {
            optimize: optimizer,
            concurrency: 4,
            signal: controller.signal,
        })

        expect(result.cancelled).toBe(true)
        // doc1 was mid-turn when it aborted, so it completes; doc2 onwards never start.
        expect(encoded).toEqual(['doc0.pdf', 'doc1.pdf'])
        expect(saved.map((f) => f.name)).toEqual(['doc0.pdf', 'doc1.pdf'])
        expect(result.uploaded).toBe(2)
    })

    it('encodes one file at a time even while uploads run in parallel', async () => {
        // A decoded image is width × height × 4 bytes; six 12-megapixel canvases at once is a
        // phone's whole budget. Uploads overlap; encodes do not.
        let encoding = 0
        let peak = 0
        const optimizer: ImageOptimizer = async (file) => {
            encoding += 1
            peak = Math.max(peak, encoding)
            await new Promise((r) => setTimeout(r, 2))
            encoding -= 1
            return { file, optimized: false }
        }
        const { view } = fakeView()
        const files = Array.from({ length: 6 }, (_, n) => file(`doc${n}.pdf`))

        await uploadAndInsert(view, reversingStore(6), files, 0, { optimize: optimizer, concurrency: 4 })

        expect(peak).toBe(1)
    })
})
