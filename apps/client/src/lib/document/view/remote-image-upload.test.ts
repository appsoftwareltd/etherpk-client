/**
 * The upload half of a Rich Paste in Node (ADR 0090): naming, the fetch, finding the paste's own
 * references and rewriting every one of them, the uploading notice's state, and the Activity end to
 * end over a fake view, store and fetch.
 */

import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'

import type { AssetStore, SavedAsset } from '$lib/storage/fs/asset-store'

import { RICH_PASTE_USER_EVENT } from './editor-history'
import {
    addPastedRange,
    fetchImageFile,
    imageFileName,
    imageReferenceSpans,
    pastedRange,
    pastedRangesField,
    referencePresent,
    rewriteImageReferences,
    startRemoteImageUpload,
} from './remote-image-upload'
import { editorFixture, type HeadlessEditor } from './testing/editor-state-fixture'
import { isImageUploading, setImageUploading, uploadingImagesField } from './uploading-images'

const NOW = new Date(2026, 8, 22, 10, 30, 5)
const PNG = new Uint8Array([137, 80, 78, 71]).buffer

/** A fetch that answers per url: an image, a non-image page, or a CORS refusal (a rejected promise). */
function fakeFetch(answers: Record<string, { type: string; bytes?: ArrayBuffer } | 'refused' | 'missing'>): typeof fetch {
    return vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const answer = answers[url]
        if (answer === undefined || answer === 'refused') throw new TypeError('Failed to fetch')
        if (answer === 'missing') return new Response('', { status: 404 })
        return new Response(new Blob([answer.bytes ?? PNG]), { status: 200, headers: { 'content-type': answer.type } })
    }) as unknown as typeof fetch
}

/**
 * An editor over the fixture stack plus the paste's fields, with `text` pasted at the caret as the
 * Rich Paste augmentation pastes it (opening the joinable step and recording the range as paste 1).
 */
function pasted(before: string, text: string): HeadlessEditor {
    const editor = editorFixture(before, { extensions: [uploadingImagesField, pastedRangesField] })
    const tr = editor.state.update(editor.state.replaceSelection(text), { userEvent: RICH_PASTE_USER_EVENT })
    let from = Number.POSITIVE_INFINITY
    let to = 0
    tr.changes.iterChangedRanges((_a, _b, fromB, toB) => {
        from = Math.min(from, fromB)
        to = Math.max(to, toB)
    })
    editor.dispatch(tr)
    editor.dispatch(editor.state.update({ effects: addPastedRange.of({ id: 1, from, to }) }))
    return editor
}

describe('imageFileName', () => {
    it('is the address’s last path segment when it carries an image extension, the query dropped', () => {
        expect(imageFileName('https://x.test/img/Holiday%20Photo.JPG?w=800', 'image/jpeg', NOW)).toBe('Holiday Photo.JPG')
    })

    it('is the clipboard timestamp name otherwise, with the extension the type gives', () => {
        expect(imageFileName('https://x.test/image?id=3', 'image/png', NOW)).toBe('image-2026-09-22-10-30-05.png')
        expect(imageFileName('data:image/webp;base64,AAAA', 'image/webp', NOW)).toBe('image-2026-09-22-10-30-05.webp')
    })
})

describe('fetchImageFile', () => {
    it('reads an image the host allows, typed and named', async () => {
        const file = await fetchImageFile('https://x.test/a.png', fakeFetch({ 'https://x.test/a.png': { type: 'image/png' } }), NOW)
        expect(file).toMatchObject({ name: 'a.png', type: 'image/png', size: 4 })
    })

    it('reads a data: source through fetch as well', async () => {
        const file = await fetchImageFile('data:image/png;base64,iVBORw0KGgo=', undefined, NOW)
        expect(file).toMatchObject({ name: 'image-2026-09-22-10-30-05.png', type: 'image/png' })
    })

    it('is null for a host that refuses, a missing image, or a response that is not an image', async () => {
        const f = fakeFetch({ 'https://x.test/page': { type: 'text/html' }, 'https://x.test/gone.png': 'missing', 'https://cors.test/a.png': 'refused' })
        expect(await fetchImageFile('https://cors.test/a.png', f)).toBeNull()
        expect(await fetchImageFile('https://x.test/gone.png', f)).toBeNull()
        expect(await fetchImageFile('https://x.test/page', f)).toBeNull()
    })
})

describe('the paste’s references', () => {
    it('are its image lines with the source, every one of them, never a line in a fence or one outside the paste', () => {
        const editor = pasted('- ```\n  ![A](https://x.test/a.png)\n  ```\n- ![A](https://x.test/a.png)\n- |', '\n- ![A|300](https://x.test/a.png)\n  ![A again](https://x.test/a.png)\n- see https://x.test/a.png')
        const range = pastedRange(editor.state, 1)!
        const spans = imageReferenceSpans(editor.state, range, 'https://x.test/a.png')
        expect(spans.map((s) => editor.state.doc.lineAt(s.from).number)).toEqual([6, 7])
        expect(referencePresent(editor.state, 1, 'https://x.test/a.png')).toBe(true)
        expect(referencePresent(editor.state, 1, 'https://x.test/other.png')).toBe(false)
    })

    it('the range follows the text through edits and is gone once the paste is undone', () => {
        const editor = pasted('- a|', '\n- ![P](https://x.test/p.png)')
        editor.dispatch(editor.state.update({ changes: { from: 0, insert: '- before\n' } }))
        expect(referencePresent(editor.state, 1, 'https://x.test/p.png')).toBe(true)
        editor.key('Mod-z')
        editor.key('Mod-z')
        expect(editor.text()).toBe('- a')
        expect(pastedRange(editor.state, 1)).toBeNull()
        expect(referencePresent(editor.state, 1, 'https://x.test/p.png')).toBe(false)
    })
})

describe('rewriteImageReferences', () => {
    it('swaps the source of every reference in the paste for the asset’s, keeping each alt and size hint, and leaves the rest of the page alone', () => {
        const editor = pasted('- ![A](https://x.test/e.png)\n- |', '\n- ![Layer|300](https://x.test/e.png)\n  ![Twice](https://x.test/e.png)\n- ![Other](https://x.test/o.png)')
        const spec = rewriteImageReferences(editor.state, 1, 'https://x.test/e.png', '../assets/e.a1b2c3d4.webp')!
        editor.dispatch(editor.state.update(spec))
        expect(editor.text()).toBe('- ![A](https://x.test/e.png)\n- \n  - ![Layer|300](../assets/e.a1b2c3d4.webp)\n    ![Twice](../assets/e.a1b2c3d4.webp)\n  - ![Other](https://x.test/o.png)')
    })

    it('is null when the paste is gone or holds no such reference', () => {
        const state = EditorState.create({ doc: '- ![A](https://x.test/e.png)', extensions: [pastedRangesField] })
        expect(rewriteImageReferences(state, 1, 'https://x.test/e.png', '../assets/e.png')).toBeNull()
    })
})

describe('uploadingImagesField', () => {
    it('marks and clears sources, a fresh set on every change', () => {
        let state = EditorState.create({ doc: '', extensions: [uploadingImagesField] })
        const before = state.field(uploadingImagesField)
        state = state.update({ effects: setImageUploading.of({ src: 'https://x.test/a.png', uploading: true }) }).state
        expect(isImageUploading(state, 'https://x.test/a.png')).toBe(true)
        expect(state.field(uploadingImagesField)).not.toBe(before)
        state = state.update({ effects: setImageUploading.of({ src: 'https://x.test/a.png', uploading: false }) }).state
        expect(isImageUploading(state, 'https://x.test/a.png')).toBe(false)
        expect(isImageUploading(EditorState.create({ doc: '' }), 'https://x.test/a.png')).toBe(false)
    })
})

/** A view over a pasted fixture, applying every dispatch so the state stays current. */
function fakeView(before: string, text: string) {
    const fixture = pasted(before, text)
    const effects: { src: string; uploading: boolean }[] = []
    const view = {
        get state() {
            return fixture.state
        },
        dispatch(spec: Parameters<EditorState['update']>[0]) {
            const tr = fixture.state.update(spec)
            for (const e of tr.effects) if (e.is(setImageUploading)) effects.push(e.value)
            fixture.dispatch(tr)
        },
    } as unknown as EditorView
    return { view, effects, fixture, text: () => fixture.text(), uploading: (src: string) => isImageUploading(fixture.state, src) }
}

function fakeStore() {
    const saved: string[] = []
    const store: AssetStore = {
        async save({ name }): Promise<SavedAsset> {
            saved.push(name)
            return { ref: `../assets/${name.replace(/(\.[^.]+)$/, '.deadbeef$1')}`, name, stem: name.replace(/\.[^.]+$/, ''), isImage: true }
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

const passthrough = async (file: File) => ({ file, optimized: false })

describe('startRemoteImageUpload', () => {
    it('stores the readable images and rewrites every reference of each; the unreadable stay remote; every notice clears; one undo removes it all', async () => {
        const { view, effects, fixture, text, uploading } = fakeView('- x|', '\n- ![A](https://x.test/a.png)\n  ![B](https://cors.test/b.png)\n- ![A again](https://x.test/a.png)')
        const { store, saved } = fakeStore()
        const activity = await startRemoteImageUpload(
            view,
            store,
            [
                { src: 'https://x.test/a.png', alt: 'A' },
                { src: 'https://cors.test/b.png', alt: 'B' },
                { src: 'https://x.test/a.png', alt: 'A again' },
            ],
            { pasteId: 1, fetch: fakeFetch({ 'https://x.test/a.png': { type: 'image/png' }, 'https://cors.test/b.png': 'refused' }), optimizer: passthrough, now: () => NOW },
        )
        expect(activity.state).toBe('done')
        expect(activity.detail).toBe('1 asset uploaded; 1 stays on the web')
        expect(saved).toEqual(['a.png'])
        expect(text()).toBe('- x\n  - ![A](../assets/a.deadbeef.png)\n    ![B](https://cors.test/b.png)\n  - ![A again](../assets/a.deadbeef.png)')
        expect(effects.filter((e) => e.uploading).map((e) => e.src)).toEqual(['https://x.test/a.png', 'https://cors.test/b.png'])
        expect(uploading('https://x.test/a.png')).toBe(false)
        expect(uploading('https://cors.test/b.png')).toBe(false)
        expect(pastedRange(fixture.state, 1)).toBeNull()
        fixture.key('Mod-z')
        expect(fixture.text()).toBe('- x')
    })

    it('uploads nothing into a paste that was undone, and says so when nothing could be read', async () => {
        const undone = fakeView('- a|', '\n- ![A](https://x.test/a.png)')
        undone.fixture.key('Mod-z')
        const { store, saved } = fakeStore()
        const activity = await startRemoteImageUpload(undone.view, store, [{ src: 'https://x.test/a.png', alt: 'A' }], { pasteId: 1, fetch: fakeFetch({ 'https://x.test/a.png': { type: 'image/png' } }), optimizer: passthrough })
        expect(saved).toEqual([])
        expect(activity.detail).toBe('Nothing to upload')
        expect(undone.text()).toBe('- a')
        const remote = fakeView('- a|', '\n- ![A](https://cors.test/a.png)')
        const second = await startRemoteImageUpload(remote.view, store, [{ src: 'https://cors.test/a.png', alt: 'A' }], { pasteId: 1, fetch: fakeFetch({}), optimizer: passthrough })
        expect(second.detail).toBe('1 stays on the web')
        expect(remote.uploading('https://cors.test/a.png')).toBe(false)
    })
})
