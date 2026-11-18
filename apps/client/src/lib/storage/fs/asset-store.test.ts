import { describe, expect, it } from 'vitest'

import { assetFileName, assetHashFromName, assetNameFromRef, buildAssetMarkdown, createAssetStore, displayAssetName, isBareAssetId, isImageExt, mimeTypeForExt, splitNameExt, AUDIO_EXTS, VIDEO_EXTS, mediaKindOfExt } from './asset-store'
import type { DirectoryAdapter } from './directory-adapter'
import { createMemoryDirectoryAdapter } from './memory-adapter'

const clock = () => {
    let t = 1000
    return () => (t += 1)
}

const bytes = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)))

/**
 * A memory adapter whose folder calls each take a turn of the event loop, as OPFS and the File
 * System Access API do. The plain memory adapter answers within the same turn, so saves running at
 * once never overlap inside it and a race between them cannot show.
 */
function slowAdapter(adapter: DirectoryAdapter): DirectoryAdapter {
    const later = <T>(value: Promise<T>) => new Promise<T>((resolve, reject) => setTimeout(() => value.then(resolve, reject), 1))
    return {
        ...adapter,
        list: (subdir) => later(adapter.list(subdir)),
        exists: (subdir, name) => later(adapter.exists(subdir, name)),
        writeBinary: (subdir, name, data) => later(adapter.writeBinary(subdir, name, data)),
    }
}

describe('splitNameExt', () => {
    it('splits stem and lower-cased extension', () => {
        expect(splitNameExt('Diagram.PNG')).toEqual({ stem: 'Diagram', ext: 'png' })
        expect(splitNameExt('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: 'gz' })
    })

    it('treats a name with no extension (or a leading dot) as having none', () => {
        expect(splitNameExt('README')).toEqual({ stem: 'README', ext: '' })
        expect(splitNameExt('.gitignore')).toEqual({ stem: '.gitignore', ext: '' })
    })
})

describe('assetFileName', () => {
    it('kebab-cases the stem and inserts the content hash before the extension', () => {
        expect(assetFileName('My Diagram (final).png', 'a1b2c3d4')).toBe('my-diagram-final.a1b2c3d4.png')
    })

    it('falls back to "asset" when the stem slugs to nothing', () => {
        expect(assetFileName('***.png', 'deadbeef')).toBe('asset.deadbeef.png')
    })
})

describe('isImageExt', () => {
    it('recognises image formats with or without a leading dot', () => {
        expect(isImageExt('png')).toBe(true)
        expect(isImageExt('.JPG')).toBe(true)
        expect(isImageExt('pdf')).toBe(false)
    })
})

describe('assetNameFromRef', () => {
    it('extracts the on-disk name from a doc-relative asset ref', () => {
        expect(assetNameFromRef('../assets/diagram.a1b2c3d4.png')).toBe('diagram.a1b2c3d4.png')
        expect(assetNameFromRef('assets/photo.9f8e.jpg')).toBe('photo.9f8e.jpg')
    })

    it('decodes percent-encoding and strips a query/hash', () => {
        expect(assetNameFromRef('../assets/my%20file.aa.pdf?v=1')).toBe('my file.aa.pdf')
    })

    it('returns null for non-asset references', () => {
        expect(assetNameFromRef('https://example.com/x.png')).toBeNull()
        expect(assetNameFromRef('../pages/Note.md')).toBeNull()
    })

    it('returns null for a name that is not one file inside assets/, however it is encoded', () => {
        // A document can carry any reference; the name it decodes to must not leave assets/.
        expect(assetNameFromRef('../assets/..%2Fpages%2FSecret.md')).toBeNull()
        expect(assetNameFromRef('assets/..%5C..%5Cx')).toBeNull()
        expect(assetNameFromRef('../assets/%2e%2e')).toBeNull()
        expect(assetNameFromRef('../assets/a%00b.png')).toBeNull()
        expect(assetNameFromRef('../assets/sub/dir.png')).toBeNull()
    })

    it('returns null rather than throwing for malformed percent-encoding', () => {
        expect(assetNameFromRef('../assets/broken%E0%A4%A.png')).toBeNull()
    })
})

describe('buildAssetMarkdown', () => {
    it('emits an inline image for images and a plain link otherwise', () => {
        expect(buildAssetMarkdown({ ref: '../assets/x.aa.png', stem: 'x', isImage: true })).toBe(
            '![x](../assets/x.aa.png)',
        )
        expect(buildAssetMarkdown({ ref: '../assets/r.aa.pdf', stem: 'r', isImage: false })).toBe(
            '[r](../assets/r.aa.pdf)',
        )
    })

    it('adds a size hint to an image when one is given, and ignores it for non-images', () => {
        expect(buildAssetMarkdown({ ref: '../assets/x.aa.png', stem: 'x', isImage: true }, '300')).toBe(
            '![x|300](../assets/x.aa.png)',
        )
        expect(buildAssetMarkdown({ ref: '../assets/r.aa.pdf', stem: 'r', isImage: false }, '300')).toBe(
            '[r](../assets/r.aa.pdf)',
        )
    })
})

describe('createAssetStore.save', () => {
    it('writes the asset under assets/ and returns an image reference', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const store = createAssetStore(adapter)

        const saved = await store.save({ name: 'Photo.png', bytes: bytes('hello'), type: 'image/png' })

        expect(saved.isImage).toBe(true)
        expect(saved.stem).toBe('photo')
        expect(saved.ref).toMatch(/^\.\.\/assets\/photo\.[0-9a-f]{8}\.png$/)
        expect(saved.ref).toBe(`../assets/${saved.name}`)
        const listed = (await adapter.list('assets')).map((e) => e.name)
        expect(listed).toEqual([saved.name])
    })

    it('de-duplicates identical content to one file (content hash)', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const store = createAssetStore(adapter)

        const a = await store.save({ name: 'one.png', bytes: bytes('same'), type: 'image/png' })
        const b = await store.save({ name: 'one.png', bytes: bytes('same'), type: 'image/png' })
        const c = await store.save({ name: 'one.png', bytes: bytes('different'), type: 'image/png' })

        expect(b.name).toBe(a.name)
        expect(c.name).not.toBe(a.name)
        expect((await adapter.list('assets')).length).toBe(2)
    })

    it('returns a download-link reference for non-image files', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const store = createAssetStore(adapter)

        const saved = await store.save({ name: 'Q3 Report.pdf', bytes: bytes('%PDF'), type: 'application/pdf' })

        expect(saved.isImage).toBe(false)
        expect(saved.ref).toMatch(/^\.\.\/assets\/q3-report\.[0-9a-f]{8}\.pdf$/)
        expect(buildAssetMarkdown(saved)).toBe(`[q3-report](${saved.ref})`)
    })
})

describe('assetHashFromName', () => {
    it('reads the content hash and extension out of a name this store wrote', () => {
        expect(assetHashFromName('my-diagram.a1b2c3d4.png')).toEqual({ hash: 'a1b2c3d4', ext: 'png' })
        expect(assetHashFromName('readme.deadbeef')).toEqual({ hash: 'deadbeef', ext: '' })
    })

    it('returns null for a name that is not one of ours', () => {
        expect(assetHashFromName('holiday.png')).toBeNull() // no hash segment
        expect(assetHashFromName('x.nothex12.png')).toBeNull() // not hex
        expect(assetHashFromName('a1b2c3d4.png')).toBeNull() // hash-shaped, but no stem before it
    })
})

describe('createAssetStore.save content-only de-duplication', () => {
    it('reuses the existing file when the same bytes arrive under a different name', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const store = createAssetStore(adapter)

        const first = await store.save({ name: 'Q3 Report.pdf', bytes: bytes('%PDF'), type: 'application/pdf' })
        const second = await store.save({ name: 'Report Q3.pdf', bytes: bytes('%PDF'), type: 'application/pdf' })

        expect(second.name).toBe(first.name)
        expect(second.reused).toBe(true)
        expect((await adapter.list('assets')).length).toBe(1)
    })

    it('keeps the new name as the markdown label while pointing at the stored file', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const store = createAssetStore(adapter)

        await store.save({ name: 'Q3 Report.pdf', bytes: bytes('%PDF'), type: 'application/pdf' })
        const second = await store.save({ name: 'Report Q3.pdf', bytes: bytes('%PDF'), type: 'application/pdf' })

        expect(second.stem).toBe('report-q3')
        expect(buildAssetMarkdown(second)).toBe(`[report-q3](../assets/q3-report.${assetHashFromName(second.name)?.hash}.pdf)`)
    })

    it('reports reuse when the very same file is added twice', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const store = createAssetStore(adapter)

        const first = await store.save({ name: 'one.png', bytes: bytes('same'), type: 'image/png' })
        const second = await store.save({ name: 'one.png', bytes: bytes('same'), type: 'image/png' })

        expect(first.reused).toBeUndefined()
        expect(second.reused).toBe(true)
    })

    it('remembers every file of a batch saved at once, so adding the batch again reuses all of it', async () => {
        // An upload saves up to six files at once. Each save used to build its own index of the
        // folder, the last one built won, and the files the others recorded were forgotten: the
        // second upload of the same three files then reported only one as reused.
        const adapter = slowAdapter(createMemoryDirectoryAdapter({ now: clock() }))
        const store = createAssetStore(adapter)
        const files = ['Seed Order.pdf', 'Bed Layout.pdf', 'Watering Rota.pdf'].map((name) => ({ name, bytes: bytes(name), type: 'application/pdf' }))

        await Promise.all(files.map((file) => store.save(file)))
        const again = await Promise.all(files.map((file) => store.save(file)))

        expect(again.map((saved) => saved.reused)).toEqual([true, true, true])
        expect((await adapter.list('assets')).length).toBe(3)
    })

    it('references a file under the name it was renamed to', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const store = createAssetStore(adapter)
        const first = await store.save({ name: 'Chart.png', bytes: bytes('pixels'), type: 'image/png' })
        const hash = assetHashFromName(first.name)!.hash
        await adapter.writeBinary('assets', `garden-chart.${hash}.png`, bytes('pixels'))
        await adapter.remove('assets', first.name)
        store.renamed?.(first.name, `garden-chart.${hash}.png`)

        const again = await store.save({ name: 'Chart.png', bytes: bytes('pixels'), type: 'image/png' })

        expect(again).toMatchObject({ name: `garden-chart.${hash}.png`, reused: true })
    })

    it('stores the same bytes once when they arrive twice in one batch', async () => {
        const adapter = slowAdapter(createMemoryDirectoryAdapter({ now: clock() }))
        const store = createAssetStore(adapter)

        const [first, second] = await Promise.all([
            store.save({ name: 'Beans.png', bytes: bytes('pixels'), type: 'image/png' }),
            store.save({ name: 'Beans copy.png', bytes: bytes('pixels'), type: 'image/png' }),
        ])

        expect(second.name).toBe(first.name)
        expect([first.reused, second.reused]).toEqual([undefined, true])
        expect((await adapter.list('assets')).length).toBe(1)
    })

    it('treats the extension as part of identity, so the same bytes as .png and .bin are two files', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const store = createAssetStore(adapter)

        const png = await store.save({ name: 'a.png', bytes: bytes('same'), type: 'image/png' })
        const bin = await store.save({ name: 'a.bin', bytes: bytes('same'), type: '' })

        expect(bin.name).not.toBe(png.name)
        expect((await adapter.list('assets')).length).toBe(2)
    })

    it('stores the bytes again when the file was deleted from the folder since it was saved', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const store = createAssetStore(adapter)
        const first = await store.save({ name: 'Chart.png', bytes: bytes('pixels'), type: 'image/png' })
        await adapter.remove('assets', first.name)

        const again = await store.save({ name: 'Chart.png', bytes: bytes('pixels'), type: 'image/png' })

        expect(again.reused).toBeUndefined()
        expect((await adapter.list('assets')).map((entry) => entry.name)).toEqual([again.name])
    })

    it('finds assets already on disk from an earlier session', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const seed = createAssetStore(adapter)
        const first = await seed.save({ name: 'Chart.png', bytes: bytes('pixels'), type: 'image/png' })

        const store = createAssetStore(adapter)
        const again = await store.save({ name: 'Graph.png', bytes: bytes('pixels'), type: 'image/png' })

        expect(again.name).toBe(first.name)
        expect(again.reused).toBe(true)
        expect((await adapter.list('assets')).length).toBe(1)
    })

    it('reports every save through onBytes, reused or not', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const store = createAssetStore(adapter)
        const seen: number[] = []

        await store.save({ name: 'a.png', bytes: bytes('same'), type: 'image/png' }, (n) => seen.push(n))
        await store.save({ name: 'b.png', bytes: bytes('same'), type: 'image/png' }, (n) => seen.push(n))

        expect(seen).toEqual([4, 4])
    })
})

describe('isBareAssetId', () => {
    it('knows a synced graph\'s id from a file\'s name', () => {
        expect(isBareAssetId('2f370a53-60fb-4a4e-87f2-67e637f1795d.pdf')).toBe(true)
        expect(isBareAssetId('2f370a53-60fb-4a4e-87f2-67e637f1795d')).toBe(true)
        expect(isBareAssetId('garden-guide.a1b2c3d4.pdf')).toBe(false)
        expect(isBareAssetId('Garden Guide.pdf')).toBe(false)
    })
})

describe('displayAssetName', () => {
    it('strips the content hash so a download is named the way a person wrote it', () => {
        expect(displayAssetName('q3-report.a1b2c3d4.pdf')).toBe('q3-report.pdf')
        expect(displayAssetName('readme.deadbeef')).toBe('readme')
    })

    it('leaves a name it did not write alone', () => {
        expect(displayAssetName('holiday.png')).toBe('holiday.png')
        expect(displayAssetName('notes.txt')).toBe('notes.txt')
    })
})

describe('mimeTypeForExt', () => {
    it('names the types the app renders itself', () => {
        expect(mimeTypeForExt('png')).toBe('image/png')
        expect(mimeTypeForExt('.JPG')).toBe('image/jpeg')
        expect(mimeTypeForExt('pdf')).toBe('application/pdf')
        expect(mimeTypeForExt('svg')).toBe('image/svg+xml')
    })

    it('is empty for anything it cannot name, rather than guessing', () => {
        expect(mimeTypeForExt('xyz')).toBe('')
        expect(mimeTypeForExt('')).toBe('')
    })
})

describe('createAssetStore.resolve', () => {
    it('returns the object URL, a hash-free name and a MIME type from the extension', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const store = createAssetStore(adapter)
        const saved = await store.save({ name: 'Q3 Report.pdf', bytes: bytes('%PDF'), type: 'application/pdf' })

        const resolved = await store.resolve(saved.ref)

        expect(resolved?.name).toBe('q3-report.pdf')
        expect(resolved?.type).toBe('application/pdf')
        expect(resolved?.url).toMatch(/^blob:/)
        store.dispose()
    })

    it('hands out one object URL per asset', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const store = createAssetStore(adapter)
        const saved = await store.save({ name: 'a.png', bytes: bytes('pixels'), type: 'image/png' })

        const first = await store.resolve(saved.ref)
        const second = await store.resolve(saved.ref)

        expect(second?.url).toBe(first?.url)
        store.dispose()
    })

    it('returns null for a missing asset and for a reference that is not an asset', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const store = createAssetStore(adapter)

        expect(await store.resolve('../assets/gone.a1b2c3d4.png')).toBeNull()
        expect(await store.resolve('https://example.com/x.png')).toBeNull()
        store.dispose()
    })

    it('gives the blob the MIME type it derived, so nothing downstream has to sniff', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: clock() })
        const store = createAssetStore(adapter)
        const saved = await store.save({ name: 'a.png', bytes: bytes('pixels'), type: 'image/png' })

        const resolved = await store.resolve(saved.ref)
        const blob = await fetch(resolved!.url).then((r) => r.blob())

        expect(blob.type).toBe('image/png')
        store.dispose()
    })
})

describe('audio and video assets', () => {
    it('knows which files are played, whatever the case and with or without the dot', () => {
        for (const ext of ['webm', 'mp4', '.MP4']) expect(mediaKindOfExt(ext)).toBe('video')
        for (const ext of ['mp3', 'm4a', 'wav', 'ogg', 'opus', 'flac', '.FLAC']) expect(mediaKindOfExt(ext)).toBe('audio')
        for (const ext of ['png', 'pdf', 'mov', 'aac', '']) expect(mediaKindOfExt(ext)).toBeNull()
    })

    it('names the MIME type of each, so a folder graph can hand the browser one', () => {
        expect(mimeTypeForExt('webm')).toBe('video/webm')
        expect(mimeTypeForExt('mp4')).toBe('video/mp4')
        expect(mimeTypeForExt('mp3')).toBe('audio/mpeg')
        expect(mimeTypeForExt('m4a')).toBe('audio/mp4')
        expect(mimeTypeForExt('wav')).toBe('audio/wav')
        expect(mimeTypeForExt('ogg')).toBe('audio/ogg')
        expect(mimeTypeForExt('opus')).toBe('audio/ogg')
        expect(mimeTypeForExt('flac')).toBe('audio/flac')
        for (const ext of [...VIDEO_EXTS, ...AUDIO_EXTS]) expect(mimeTypeForExt(ext), ext).not.toBe('')
    })

    it('writes a saved recording in the image form, which draws a player, and never with a size hint', () => {
        expect(buildAssetMarkdown({ ref: '../assets/planting.9c8d7e6f.webm', stem: 'planting', isImage: false })).toBe('![planting](../assets/planting.9c8d7e6f.webm)')
        expect(buildAssetMarkdown({ ref: '../assets/voice-note.1a2b3c4d.mp3', stem: 'voice-note', isImage: false }, '800')).toBe('![voice-note](../assets/voice-note.1a2b3c4d.mp3)')
        expect(buildAssetMarkdown({ ref: '../assets/seed-list.5e6f7a8b.pdf', stem: 'seed-list', isImage: false })).toBe('[seed-list](../assets/seed-list.5e6f7a8b.pdf)')
    })
})
