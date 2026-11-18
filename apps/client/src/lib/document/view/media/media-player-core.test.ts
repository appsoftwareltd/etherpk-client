import { describe, expect, it } from 'vitest'

import { PLAYBACK_SPEEDS, formatMediaTime, keyAction, mediaTypeLabel, nextSpeed, seekTarget, steppedVolume } from './media-player-core'

describe('formatMediaTime', () => {
    it('writes minutes and seconds, and hours once there are any', () => {
        expect(formatMediaTime(0)).toBe('0:00')
        expect(formatMediaTime(9.9)).toBe('0:09')
        expect(formatMediaTime(75)).toBe('1:15')
        expect(formatMediaTime(3600)).toBe('1:00:00')
        expect(formatMediaTime(3725)).toBe('1:02:05')
    })

    it('writes a time it does not know as dashes, never NaN', () => {
        expect(formatMediaTime(Number.NaN)).toBe('-:--')
        expect(formatMediaTime(Number.POSITIVE_INFINITY)).toBe('-:--')
        expect(formatMediaTime(-1)).toBe('0:00')
    })
})

describe('keyAction', () => {
    it('plays and pauses on Space, seeks with Left and Right, changes the volume with Up and Down', () => {
        expect(keyAction({ key: ' ' })).toEqual({ kind: 'toggle' })
        expect(keyAction({ key: 'ArrowRight' })).toEqual({ kind: 'seek', by: 5 })
        expect(keyAction({ key: 'ArrowLeft' })).toEqual({ kind: 'seek', by: -5 })
        expect(keyAction({ key: 'ArrowUp' })).toEqual({ kind: 'volume', by: 0.1 })
        expect(keyAction({ key: 'ArrowDown' })).toEqual({ kind: 'volume', by: -0.1 })
        expect(keyAction({ key: 'm' })).toEqual({ kind: 'mute' })
    })

    it('leaves a key with a modifier, and every other key, to the page', () => {
        expect(keyAction({ key: ' ', ctrlKey: true })).toBeNull()
        expect(keyAction({ key: 'ArrowRight', altKey: true })).toBeNull()
        expect(keyAction({ key: 'ArrowRight', metaKey: true })).toBeNull()
        expect(keyAction({ key: 'a' })).toBeNull()
        expect(keyAction({ key: 'Tab' })).toBeNull()
    })
})

describe('seekTarget', () => {
    it('stays inside the recording', () => {
        expect(seekTarget(10, 5, 60)).toBe(15)
        expect(seekTarget(2, -5, 60)).toBe(0)
        expect(seekTarget(58, 5, 60)).toBe(60)
    })

    it('does not move while the length is unknown', () => {
        expect(seekTarget(10, 5, Number.NaN)).toBe(10)
    })
})

describe('steppedVolume', () => {
    it('stays between silent and full, without drifting off a tenth', () => {
        expect(steppedVolume(0.5, 0.1)).toBe(0.6)
        expect(steppedVolume(0.95, 0.1)).toBe(1)
        expect(steppedVolume(0.05, -0.1)).toBe(0)
        expect(steppedVolume(0.1 + 0.2, 0.1)).toBe(0.4)
    })
})

describe('nextSpeed', () => {
    it('goes round the speeds in order', () => {
        expect(PLAYBACK_SPEEDS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2])
        expect(nextSpeed(1)).toBe(1.25)
        expect(nextSpeed(2)).toBe(0.5)
    })

    it('starts again from normal speed for a speed it does not offer', () => {
        expect(nextSpeed(3)).toBe(1)
    })
})

describe('mediaTypeLabel', () => {
    it('names the format and the kind', () => {
        expect(mediaTypeLabel('clip.webm', 'video')).toBe('WebM video')
        expect(mediaTypeLabel('clip.MP4', 'video')).toBe('MP4 video')
        expect(mediaTypeLabel('note.mp3', 'audio')).toBe('MP3 audio')
        expect(mediaTypeLabel('note.m4a', 'audio')).toBe('M4A audio')
        expect(mediaTypeLabel('note.opus', 'audio')).toBe('Opus audio')
        expect(mediaTypeLabel('note', 'audio')).toBe('Audio')
    })
})
