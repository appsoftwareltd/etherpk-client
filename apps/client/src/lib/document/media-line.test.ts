import { describe, expect, it } from 'vitest'

import { isImageLine } from './image-line'
import { AUDIO_EXTS, VIDEO_EXTS } from '#lib/storage/fs/asset-store.js'

import { isMediaLine, mediaKindOfExtension, mediaKindOfTarget, parseMediaLine } from './media-line'

describe('mediaKindOfExtension', () => {
    it('knows the video and audio formats, whatever the case and with or without the dot', () => {
        for (const ext of VIDEO_EXTS) expect(mediaKindOfExtension(ext)).toBe('video')
        for (const ext of AUDIO_EXTS) expect(mediaKindOfExtension(ext)).toBe('audio')
        expect(mediaKindOfExtension('.MP4')).toBe('video')
        expect(mediaKindOfExtension('FLAC')).toBe('audio')
    })

    it('knows nothing else', () => {
        for (const ext of ['png', 'pdf', 'mov', 'avi', 'mkv', 'aac', '']) expect(mediaKindOfExtension(ext)).toBeNull()
    })
})

describe('mediaKindOfTarget', () => {
    it('reads the kind from an asset reference', () => {
        expect(mediaKindOfTarget('../assets/add-a-clip.a1b2c3d4.webm')).toBe('video')
        expect(mediaKindOfTarget('../assets/Garden%20walk.mp4')).toBe('video')
        expect(mediaKindOfTarget('../assets/voice-note.mp3')).toBe('audio')
        expect(mediaKindOfTarget('../assets/voice-note.opus?x=1#t=3')).toBe('audio')
    })

    it('is not a recording on another site, which the Client may not load', () => {
        expect(mediaKindOfTarget('https://example.com/clip.mp4')).toBeNull()
        expect(mediaKindOfTarget('blob:https://example.com/abc.webm')).toBeNull()
        expect(mediaKindOfTarget('//example.com/clip.mp4')).toBeNull()
    })

    it('is not a path that is no asset reference, which the Asset Store could not find', () => {
        expect(mediaKindOfTarget('clip.mp4')).toBeNull()
        expect(mediaKindOfTarget('./videos/clip.mp4')).toBeNull()
        expect(mediaKindOfTarget('../assets/nested/clip.mp4')).toBeNull()
    })

    it('is not a file of another type, or one with no extension', () => {
        expect(mediaKindOfTarget('../assets/chart.png')).toBeNull()
        expect(mediaKindOfTarget('../assets/report.pdf')).toBeNull()
        expect(mediaKindOfTarget('../assets/webm')).toBeNull()
        expect(mediaKindOfTarget('../assets/.mp4')).toBeNull()
    })
})

describe('parseMediaLine', () => {
    it('reads a standalone media line', () => {
        expect(parseMediaLine('![Adding a clip](../assets/add-a-clip.webm)')).toEqual({
            kind: 'standalone',
            alt: 'Adding a clip',
            url: '../assets/add-a-clip.webm',
            imageStart: 0,
            media: 'video',
        })
        expect(parseMediaLine('  ![note](../assets/voice-note.mp3)  ')).toMatchObject({ kind: 'standalone', media: 'audio', imageStart: 2 })
    })

    it("reads one that is a bullet's or a task's only content", () => {
        expect(parseMediaLine('- ![clip](../assets/clip.mp4)')).toMatchObject({ kind: 'bullet', media: 'video', imageStart: 2 })
        expect(parseMediaLine('  - [ ] ![note](../assets/note.wav)')).toMatchObject({ kind: 'bullet', media: 'audio', imageStart: 8 })
    })

    it('keeps a file name with brackets whole', () => {
        expect(parseMediaLine('![clip](../assets/walk_(1).mp4)')?.url).toBe('../assets/walk_(1).mp4')
    })

    it('is not a link to the file, a recording in a sentence, or two on one line', () => {
        expect(parseMediaLine('[clip](../assets/clip.mp4)')).toBeNull()
        expect(parseMediaLine('see ![clip](../assets/clip.mp4) here')).toBeNull()
        expect(parseMediaLine('![a](../assets/a.mp4) ![b](../assets/b.mp4)')).toBeNull()
        expect(parseMediaLine('- water the beans')).toBeNull()
    })

    it('is not a picture or a document written with image syntax', () => {
        expect(parseMediaLine('![chart](../assets/chart.png)')).toBeNull()
        expect(parseMediaLine('![report](../assets/report.pdf)')).toBeNull()
    })
})

describe('a media line and an image line', () => {
    it('are never the same line', () => {
        const lines = [
            '![clip](../assets/clip.webm)',
            '![clip](../assets/clip.mp4)',
            '![note](../assets/note.mp3)',
            '- ![note](../assets/note.flac)',
            '![chart](../assets/chart.png)',
            '- ![chart](../assets/chart.webp)',
            '![hosted](https://example.com/picture)',
            '![report](../assets/report.pdf)',
        ]
        for (const line of lines) expect(isMediaLine(line) && isImageLine(line), line).toBe(false)
        expect(lines.filter(isMediaLine)).toHaveLength(4)
        expect(lines.filter(isImageLine)).toHaveLength(3)
    })
})
