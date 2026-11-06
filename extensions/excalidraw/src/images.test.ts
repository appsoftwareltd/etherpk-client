import { describe, expect, it } from 'vitest'

import type { ElementRecord } from './format'
import { dataUrlBytes, fileDigest, imageFile, MISSING_IMAGE, nameOfImage, readPictureFiles } from './images'

const image = (id: string, fileId: string, asset: string | null): ElementRecord => ({
    id,
    type: 'image',
    version: 1,
    versionNonce: 1,
    fileId,
    ...(asset ? { customData: { asset } } : {}),
})

describe('the name of an image kept as an Asset', () => {
    it("is the file's own, where it has one", () => {
        expect(nameOfImage('garden-plan.png')).toBe('garden-plan.png')
        expect(nameOfImage('Raised Beds.JPG')).toBe('Raised Beds.JPG')
    })

    it('says where it came from when the browser only made a name up for a paste', () => {
        for (const name of ['', 'image.png', 'IMAGE.PNG', 'image', 'blob']) expect(nameOfImage(name)).toBe('drawing-image')
    })
})

describe('an image as a data URL', () => {
    it('gives its bytes and type back, base64 or not', () => {
        expect(dataUrlBytes('data:image/png;base64,AQID')).toEqual({ type: 'image/png', bytes: new Uint8Array([1, 2, 3]) })
        const svg = dataUrlBytes(`data:image/svg+xml,${encodeURIComponent('<svg/>')}`)
        expect(svg.type).toBe('image/svg+xml')
        expect(new TextDecoder().decode(svg.bytes)).toBe('<svg/>')
    })

    it('is refused when it is not one', () => {
        expect(() => dataUrlBytes('https://example.com/plan.png')).toThrow()
    })

    it('becomes a file Excalidraw can draw, of the type it says', () => {
        expect(imageFile('f1', 'data:image/webp;base64,AQID', 5)).toEqual({ id: 'f1', mimeType: 'image/webp', dataURL: 'data:image/webp;base64,AQID', created: 5 })
    })
})

describe('the id of a new image', () => {
    it("is the digest of its bytes, as Excalidraw's own is, so one image in two places is one file", async () => {
        const bytes = new Blob([new Uint8Array([1, 2, 3])])
        expect(await fileDigest(bytes)).toBe('7037807198c22a7d2b0807371d763779a84fdfcf')
    })
})

describe("the files of a drawing's picture", () => {
    const shed = '../assets/shed.png'
    const beds = '../assets/beds.png'

    it('reads each image once, by the reference its elements name', async () => {
        const asked: string[] = []
        const { files, missing } = await readPictureFiles([image('i1', 'f1', shed), image('i2', 'f1', shed), image('i3', 'f2', beds)], async (ref) => {
            asked.push(ref)
            return `data:image/png;base64,${ref === shed ? 'AQ==' : 'Ag=='}`
        })
        expect(asked).toEqual([shed, beds])
        expect(Object.keys(files)).toEqual(['f1', 'f2'])
        expect(files.f2.dataURL).toBe('data:image/png;base64,Ag==')
        expect(missing).toEqual([])
    })

    it('holds a grey box in place of an image that cannot be read, and says which', async () => {
        const { files, missing } = await readPictureFiles([image('i1', 'f1', shed), image('i2', 'f2', beds)], async (ref) => {
            if (ref === beds) throw new Error('offline')
            return null
        })
        expect(files.f1.dataURL).toBe(MISSING_IMAGE)
        expect(files.f2.dataURL).toBe(MISSING_IMAGE)
        expect(missing).toEqual([shed, beds])
    })

    it('holds a grey box for an image with no Asset at all, which nothing could ever read', async () => {
        const { files, missing } = await readPictureFiles([image('i1', 'f1', null)], async () => 'data:image/png;base64,AQ==')
        expect(files.f1.dataURL).toBe(MISSING_IMAGE)
        expect(missing).toEqual(['f1'])
    })

    it('asks for nothing in a drawing with no images', async () => {
        const rectangle: ElementRecord = { id: 'r1', type: 'rectangle', version: 1, versionNonce: 1 }
        expect(await readPictureFiles([rectangle], async () => null)).toEqual({ files: {}, missing: [] })
    })
})
