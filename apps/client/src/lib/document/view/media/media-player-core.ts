/**
 * The parts of the audio and video player that need no DOM: how a time is written, what a key
 * does, and where a seek or a volume step lands. `media-player.ts` draws the player and calls
 * these, so the rules are tested in Node.
 */

export type { MediaKind } from '../../media-line'
import type { MediaKind } from '../../media-line'

/** A time in seconds as `m:ss`, or `h:mm:ss` from an hour. `-:--` while it is not known. */
export function formatMediaTime(seconds: number): string {
    if (!Number.isFinite(seconds)) return '-:--'
    const whole = Math.max(0, Math.floor(seconds))
    const h = Math.floor(whole / 3600)
    const m = Math.floor((whole % 3600) / 60)
    const s = String(whole % 60).padStart(2, '0')
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** How far Left and Right seek, in seconds. */
export const SEEK_STEP = 5
/** How far Up and Down change the volume, of a full volume of 1. */
export const VOLUME_STEP = 0.1

export type MediaKeyAction = { kind: 'toggle' } | { kind: 'seek'; by: number } | { kind: 'volume'; by: number } | { kind: 'mute' }

/**
 * What a key pressed on the player does, or null to leave the key alone. A key with Ctrl, Alt or
 * Meta is the browser's or the app's. The player handles these only while it has the keyboard, so
 * Space in the document still types a space.
 */
export function keyAction(event: { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): MediaKeyAction | null {
    if (event.ctrlKey || event.altKey || event.metaKey) return null
    return KEY_ACTIONS[event.key] ?? null
}

const KEY_ACTIONS: Readonly<Record<string, MediaKeyAction>> = {
    ' ': { kind: 'toggle' },
    k: { kind: 'toggle' },
    ArrowRight: { kind: 'seek', by: SEEK_STEP },
    ArrowLeft: { kind: 'seek', by: -SEEK_STEP },
    ArrowUp: { kind: 'volume', by: VOLUME_STEP },
    ArrowDown: { kind: 'volume', by: -VOLUME_STEP },
    m: { kind: 'mute' },
}

/** Where a seek of `by` seconds from `current` lands in a recording `duration` seconds long. */
export function seekTarget(current: number, by: number, duration: number): number {
    if (!Number.isFinite(duration)) return current
    return Math.min(duration, Math.max(0, current + by))
}

/** The volume after a step, between 0 and 1, rounded so ten steps reach the end exactly. */
export function steppedVolume(current: number, by: number): number {
    return Math.min(1, Math.max(0, Math.round((current + by) * 100) / 100))
}

/** The playback speeds offered, slowest first. */
export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

/** The speed after `current`, going round. A speed that is not offered starts again at normal. */
export function nextSpeed(current: number): number {
    const at = (PLAYBACK_SPEEDS as readonly number[]).indexOf(current)
    return at === -1 ? 1 : PLAYBACK_SPEEDS[(at + 1) % PLAYBACK_SPEEDS.length]
}

const FORMAT_NAMES: Record<string, string> = {
    webm: 'WebM',
    mp4: 'MP4',
    mp3: 'MP3',
    m4a: 'M4A',
    wav: 'WAV',
    ogg: 'Ogg',
    opus: 'Opus',
    flac: 'FLAC',
}

/** What a file is, for the line under its name: "WebM video", "MP3 audio". */
export function mediaTypeLabel(name: string, kind: MediaKind): string {
    const dot = name.lastIndexOf('.')
    const format = dot <= 0 ? undefined : FORMAT_NAMES[name.slice(dot + 1).toLowerCase()]
    return format ? `${format} ${kind}` : kind === 'audio' ? 'Audio' : 'Video'
}
