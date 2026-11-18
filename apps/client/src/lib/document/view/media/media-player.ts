/**
 * The audio and video player: one design for both, drawn by EtherPK so it looks and behaves the
 * same in every browser ([[2026-11-18 Audio And Video Players]]). The media element is the
 * browser's own, without its controls.
 *
 * - **Nothing is read until play is pressed.** A synced graph's asset is downloaded whole and
 *   decrypted before it can play, and a recording can be hundreds of megabytes, so a document
 *   with ten clips reads none of them to be shown. `source` is asked on the first play. An
 *   [[Asset]] open in its own tab is already read, and passes `source` as a value.
 * - **Nothing plays by itself.** No autoplay, no loop.
 * - **A file the browser cannot play says so.** The asset's own link beside it still downloads it.
 * - **A read that fails offers Retry**, and a retry after playing started keeps the position.
 *
 * Built with DOM calls and no HTML strings (Trusted Types, ADR 0130), so the editor's embed
 * (`augmentations/media-embed.ts`) and the asset viewer (`viewers/MediaAssetViewer.svelte`) mount
 * the same thing. The rules with no DOM in them are in `media-player-core.ts`.
 */
import './media-player.css'

import { formatMediaTime, keyAction, mediaTypeLabel, nextSpeed, seekTarget, steppedVolume, type MediaKind } from './media-player-core'

export interface MediaSource {
    /** An address the media element can play: an object URL for an asset's bytes. */
    url: string
    /** MIME type, or `''` when it is not known. */
    type: string
}

export interface MediaPlayerOptions {
    kind: MediaKind
    /** The file's name, shown on the player and read to a screen reader. */
    name: string
    /** The file, already read, or how to read it when play is first pressed. Null from the reader: it is gone. */
    source: MediaSource | (() => Promise<MediaSource | null>)
    /** Called when the player's height may have changed, for a host that measures it (CodeMirror). */
    onResize?: () => void
    /** Escape was pressed on the player: where the keyboard goes next is the host's (the editor takes it back). */
    onLeave?: () => void
}

export interface MediaPlayer {
    readonly element: HTMLElement
    /** Stop playback and let go of the media element. The object URL belongs to whoever made it. */
    destroy(): void
}

type State = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'failed' | 'unplayable'

/** The states in which a video shows the press in the middle of its picture. */
const RESTING: ReadonlySet<State> = new Set(['idle', 'ready', 'paused', 'ended'])

const SVG = 'http://www.w3.org/2000/svg'

/** A 16-unit line icon from path data, drawn in the text colour. */
function icon(paths: readonly string[], filled = false): SVGSVGElement {
    const svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '18')
    svg.setAttribute('height', '18')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('fill', filled ? 'currentColor' : 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.4')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    for (const d of paths) {
        const path = document.createElementNS(SVG, 'path')
        path.setAttribute('d', d)
        svg.appendChild(path)
    }
    return svg
}

const ICONS = {
    play: () => icon(['M5 3.2v9.6L12.5 8z'], true),
    pause: () => icon(['M5 3.5v9M11 3.5v9']),
    volume: () => icon(['M2.5 6.2v3.6h2.3L8 12.5v-9L4.800 6.2z', 'M10.500 5.800a3 3 0 0 1 0 4.400', 'M12 4a5.500 5.500 0 0 1 0 8']),
    muted: () => icon(['M2.5 6.2v3.6h2.3L8 12.5v-9L4.800 6.2z', 'M10.500 6.200l3.300 3.600M13.800 6.200l-3.300 3.600']),
    fullscreen: () => icon(['M2.5 6V2.5H6M10 2.5h3.500V6M13.500 10v3.500H10M6 13.500H2.500V10']),
    exitFullscreen: () => icon(['M6 2.5V6H2.5M10 2.5V6h3.500M13.500 10H10v3.500M6 13.500V10H2.500']),
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
}

function button(className: string, label: string, glyph: SVGSVGElement | string): HTMLButtonElement {
    const node = el('button', `gk-media__button ${className}`)
    node.type = 'button'
    node.setAttribute('aria-label', label)
    node.title = label
    if (typeof glyph === 'string') node.textContent = glyph
    else node.appendChild(glyph)
    return node
}

function range(className: string, label: string, max: number, step: number): HTMLInputElement {
    const node = el('input', `gk-media__range ${className}`)
    node.type = 'range'
    node.min = '0'
    node.max = String(max)
    node.step = String(step)
    node.value = '0'
    node.setAttribute('aria-label', label)
    return node
}

/** A key its own control answers: Space on a button, an arrow on a slider. The player leaves those alone. */
function ownedByControl(event: KeyboardEvent): boolean {
    const target = event.target
    if (target instanceof HTMLButtonElement) return event.key === ' '
    return target instanceof HTMLInputElement && event.key.startsWith('Arrow')
}

export function createMediaPlayer(options: MediaPlayerOptions): MediaPlayer {
    const { kind, name } = options
    const root = el('div', `gk-media gk-media--${kind}`)
    root.tabIndex = 0
    root.setAttribute('role', 'group')
    root.setAttribute('aria-label', `${kind === 'video' ? 'Video' : 'Audio'}: ${name}`)
    root.dataset.testid = 'media-player'
    root.dataset.mediaKind = kind

    const media = document.createElement(kind)
    media.className = 'gk-media__element'
    media.preload = 'metadata'
    if (media instanceof HTMLVideoElement) media.playsInline = true

    // The stage: a video's picture, with the first press of play in its middle. Audio has none.
    const stage = el('div', 'gk-media__stage')
    const bigPlay = button('gk-media__big-play', `Play ${name}`, ICONS.play())
    bigPlay.dataset.testid = 'media-big-play'
    if (kind === 'video') stage.append(media, bigPlay)

    const title = el('div', 'gk-media__title')
    const nameEl = el('span', 'gk-media__name', name)
    const typeEl = el('span', 'gk-media__type', mediaTypeLabel(name, kind))
    title.append(nameEl, typeEl)

    // What the player says in place of playing: reading, a failed read, a file it cannot play.
    const notice = el('div', 'gk-media__notice')
    notice.setAttribute('role', 'status')
    notice.dataset.testid = 'media-notice'
    const noticeText = el('span', 'gk-media__notice-text')
    const retry = el('button', 'gk-media__retry', 'Try again')
    retry.type = 'button'
    retry.dataset.testid = 'media-retry'
    notice.append(noticeText, retry)

    const bar = el('div', 'gk-media__bar')
    const toggle = button('gk-media__toggle', 'Play', ICONS.play())
    toggle.dataset.testid = 'media-toggle'
    const elapsed = el('span', 'gk-media__time', '0:00')
    elapsed.dataset.testid = 'media-elapsed'
    const scrub = range('gk-media__scrub', 'Seek', 0, 0.1)
    scrub.dataset.testid = 'media-scrub'
    const total = el('span', 'gk-media__time', '-:--')
    total.dataset.testid = 'media-duration'
    const mute = button('gk-media__mute', 'Mute', ICONS.volume())
    mute.dataset.testid = 'media-mute'
    const volume = range('gk-media__volume', 'Volume', 1, 0.05)
    volume.value = '1'
    volume.dataset.testid = 'media-volume'
    const speed = button('gk-media__speed', 'Playback speed, 1×', '1×')
    speed.dataset.testid = 'media-speed'
    const fullscreen = button('gk-media__fullscreen', 'Full screen', ICONS.fullscreen())
    fullscreen.dataset.testid = 'media-fullscreen'
    bar.append(toggle, elapsed, scrub, total, mute, volume, speed)
    if (kind === 'video') bar.append(fullscreen)

    if (kind === 'video') root.append(stage, title, notice, bar)
    else root.append(media, title, notice, bar)

    let state: State = 'idle'
    let destroyed = false
    /** Where to carry on from after a retry, in seconds. */
    let resumeAt = 0
    /** The person is dragging the scrub bar: the bar follows the hand, not the playback. */
    let scrubbing = false
    let loaded = false

    /** The play button's icon and name for a state. */
    function showToggle(next: State): void {
        const playing = next === 'playing'
        toggle.replaceChildren(playing ? ICONS.pause() : ICONS.play())
        const label = playing ? 'Pause' : next === 'ended' ? 'Play again' : 'Play'
        toggle.setAttribute('aria-label', label)
        toggle.title = label
    }

    function setState(next: State, message = ''): void {
        if (destroyed) return
        const changed = state !== next || noticeText.textContent !== message
        state = next
        root.dataset.state = next
        noticeText.textContent = message
        retry.hidden = next !== 'failed'
        notice.hidden = message === ''
        showToggle(next)
        // Before the file is read there is nothing to seek in.
        scrub.disabled = !loaded || next === 'unplayable'
        // The press in the middle of the picture, whenever the recording is not playing or being read.
        bigPlay.hidden = !RESTING.has(next)
        if (changed) options.onResize?.()
    }

    function showTimes(): void {
        const duration = media.duration
        if (Number.isFinite(duration)) {
            scrub.max = String(duration)
            total.textContent = formatMediaTime(duration)
        }
        if (!scrubbing) scrub.value = String(media.currentTime)
        const now = scrubbing ? Number(scrub.value) : media.currentTime
        elapsed.textContent = formatMediaTime(now)
        scrub.setAttribute('aria-valuetext', `${formatMediaTime(now)} of ${formatMediaTime(duration)}`)
        // The filled part of the track, in the accent colour.
        const part = Number.isFinite(duration) && duration > 0 ? (now / duration) * 100 : 0
        scrub.style.setProperty('--gk-media-progress', `${part}%`)
    }

    function showVolume(): void {
        const silent = media.muted || media.volume === 0
        mute.replaceChildren(silent ? ICONS.muted() : ICONS.volume())
        const label = silent ? 'Unmute' : 'Mute'
        mute.setAttribute('aria-label', label)
        mute.title = label
        volume.value = String(media.muted ? 0 : media.volume)
        volume.style.setProperty('--gk-media-progress', `${Number(volume.value) * 100}%`)
        volume.setAttribute('aria-valuetext', `${Math.round(Number(volume.value) * 100)}%`)
    }

    function showSpeed(): void {
        const rate = media.playbackRate
        speed.textContent = `${rate}×`
        const label = `Playback speed, ${rate}×`
        speed.setAttribute('aria-label', label)
        speed.title = label
    }

    /** Read the file if it has not been read, and say why when it cannot be. True when the element has it. */
    async function load(): Promise<boolean> {
        if (loaded) return true
        setState('loading', `Reading ${name}…`)
        let source: MediaSource | null
        try {
            source = typeof options.source === 'function' ? await options.source() : options.source
        } catch (error) {
            console.warn('[media-player] the file could not be read', error)
            setState('failed', `${name} could not be read. Check your connection and try again.`)
            return false
        }
        if (destroyed) return false
        if (!source) {
            setState('unplayable', `${name} is not in this graph's files.`)
            return false
        }
        // Asked before the bytes are handed over: a type the browser has no decoder for never plays.
        if (source.type && media.canPlayType(source.type) === '') {
            setState('unplayable', `This browser cannot play ${name}.`)
            return false
        }
        media.src = source.url
        loaded = true
        await knowDuration()
        if (destroyed) return false
        if (resumeAt > 0) media.currentTime = resumeAt
        return true
    }

    /** Resolves at the first of `events` on the media element, or after `ms`. */
    function next(events: readonly string[], ms: number): Promise<void> {
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer)
                for (const event of events) media.removeEventListener(event, done)
                resolve()
            }
            const timer = setTimeout(done, ms)
            for (const event of events) media.addEventListener(event, done)
        })
    }

    /**
     * Wait for the recording's length. A recording a browser made itself (a screen recording, a
     * clip from `MediaRecorder`) often carries no length, and the element reports `Infinity` until
     * it has been played to the end. Seeking far past the end makes the browser find the real
     * length at once, and the place is then put back. Without it such a clip has no bar to move.
     */
    async function knowDuration(): Promise<void> {
        if (media.readyState < HTMLMediaElement.HAVE_METADATA) await next(['loadedmetadata', 'error'], 10_000)
        if (media.error || media.duration !== Number.POSITIVE_INFINITY) return
        media.currentTime = Number.MAX_SAFE_INTEGER
        await next(['durationchange', 'error'], 3_000)
        media.currentTime = 0
        showTimes()
    }

    async function play(): Promise<void> {
        if (state === 'loading' || state === 'unplayable') return
        if (!(await load())) return
        try {
            if (state === 'ended') media.currentTime = 0
            await media.play()
        } catch (error) {
            // A pause that lands before play() settles rejects it, and that is not a failure.
            if ((error as DOMException | null)?.name === 'AbortError') return
            if (media.error) return // the error event says it
            console.warn('[media-player] playback did not start', error)
            setState('failed', `${name} did not start playing. Try again.`)
        }
    }

    function togglePlay(): void {
        if (state === 'playing') media.pause()
        else void play()
    }

    function seekBy(by: number): void {
        if (!loaded) return
        media.currentTime = seekTarget(media.currentTime, by, media.duration)
        showTimes()
    }

    function toggleMute(): void {
        media.muted = !(media.muted || media.volume === 0)
        if (!media.muted && media.volume === 0) media.volume = 0.5
    }

    const inFullscreen = () => document.fullscreenElement === root

    function toggleFullscreen(): void {
        if (inFullscreen()) void document.exitFullscreen()
        else void root.requestFullscreen?.().catch((error: unknown) => console.warn('[media-player] full screen was refused', error))
    }

    function onFullscreenChange(): void {
        const on = inFullscreen()
        root.classList.toggle('gk-media--fullscreen', on)
        fullscreen.replaceChildren(on ? ICONS.exitFullscreen() : ICONS.fullscreen())
        const label = on ? 'Leave full screen' : 'Full screen'
        fullscreen.setAttribute('aria-label', label)
        fullscreen.title = label
        // In full screen the player is out of the page's flow, so its room there changes.
        options.onResize?.()
    }

    media.addEventListener('loadedmetadata', () => {
        showTimes()
        options.onResize?.()
    })
    media.addEventListener('durationchange', showTimes)
    media.addEventListener('timeupdate', showTimes)
    media.addEventListener('play', () => setState('playing'))
    media.addEventListener('pause', () => {
        // A recording that broke pauses too, after its error: what the error said stays.
        if (!media.ended && !media.error) setState('paused')
    })
    media.addEventListener('ended', () => setState('ended'))
    media.addEventListener('volumechange', showVolume)
    media.addEventListener('ratechange', showSpeed)
    media.addEventListener('error', () => {
        const code = media.error?.code
        // 4: the browser has no decoder for it. Anything else broke part way: the bytes, the decode.
        if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
            setState('unplayable', `This browser cannot play ${name}.`)
            return
        }
        resumeAt = media.currentTime
        loaded = false
        setState('failed', `${name} stopped playing. Try again.`)
    })

    toggle.addEventListener('click', togglePlay)
    bigPlay.addEventListener('click', togglePlay)
    retry.addEventListener('click', () => void play())
    mute.addEventListener('click', toggleMute)
    speed.addEventListener('click', () => {
        media.playbackRate = nextSpeed(media.playbackRate)
    })
    fullscreen.addEventListener('click', toggleFullscreen)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    // A video's picture plays and pauses on a click, as every player's does.
    if (kind === 'video') media.addEventListener('click', togglePlay)

    scrub.addEventListener('input', () => {
        scrubbing = true
        showTimes()
    })
    scrub.addEventListener('change', () => {
        media.currentTime = Number(scrub.value)
        scrubbing = false
        showTimes()
    })
    volume.addEventListener('input', () => {
        media.volume = Number(volume.value)
        media.muted = media.volume === 0
    })

    root.addEventListener('keydown', (event) => {
        if (ownedByControl(event)) return
        // Escape leaves the player. In full screen it is the browser's, and only leaves that.
        if (event.key === 'Escape' && options.onLeave && !inFullscreen()) {
            event.preventDefault()
            event.stopPropagation()
            options.onLeave()
            return
        }
        const action = keyAction(event)
        if (!action) return
        event.preventDefault()
        event.stopPropagation()
        if (action.kind === 'toggle') togglePlay()
        else if (action.kind === 'seek') seekBy(action.by)
        else if (action.kind === 'mute') toggleMute()
        else {
            media.muted = false
            media.volume = steppedVolume(media.volume, action.by)
        }
    })

    setState('idle')
    showVolume()
    showSpeed()

    return {
        element: root,
        destroy() {
            destroyed = true
            document.removeEventListener('fullscreenchange', onFullscreenChange)
            media.pause()
            // Lets the browser drop what it buffered; the object URL is the asset store's to revoke.
            media.removeAttribute('src')
            media.load()
        },
    }
}
