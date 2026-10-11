/**
 * The pictures of [[Map Block]]s the Backlinks panel shows in place of their lines (ADR 0118,
 * amended 2026-10-10). A quoted map is a picture, not a live map: a live map holds a WebGL context
 * while it is on screen, and a browser keeps only a few, which a panel of references could use up.
 * The maps extension draws each picture off screen through the renderer it contributed for
 * publishing (`MAP_PICTURE_KIND`), at the panel's size and in its theme, and lets the context go.
 *
 * Here is what the panel asks of it:
 *
 * - **One at a time.** Pictures are drawn in the order they are asked for, each after the last has
 *   finished, so the panel never holds more than one context of its own. A picture nobody waits
 *   for any more (its reference scrolled out of sight before its turn) is not drawn.
 * - **Kept.** The pictures last drawn are kept, by the map's text, size and theme, so a reference
 *   scrolled back to, or a panel showing the same document again, shows its picture at once. Never
 *   stored: the browser keeps the basemap's tiles itself, and a stored picture would go out of
 *   date with nothing to say so.
 * - **Without the basemap while it cannot be loaded.** A picture whose basemap failed (offline, a
 *   host that is down, a slow one) is drawn again on the plain background, and says so. The
 *   basemap is skipped for a minute after a failure, so a panel of maps does not wait out the same
 *   timeout once for each, and is tried again as soon as the browser is back online.
 *
 * Framework-free: `QuotedMap.svelte` shows the pictures, and only it knows the panel.
 */
import { type ContributionRegistry, tryGetActiveContributionRegistry } from '$lib/surface'

import { MAP_PICTURE_KIND, type MapPictureRenderer } from '../publish/map-picture-renderer'
import type { MapPicture } from '../publish/publish'

/** A picture's size in CSS pixels. */
export interface QuotedMapSize {
    width: number
    height: number
}

/** A drawn picture, and whether its basemap is in it or it was drawn on the plain background. */
export interface QuotedMapPicture {
    picture: MapPicture
    basemap: boolean
}

export interface QuotedMapPictures {
    /** The picture kept for this map at this size and theme, or undefined. */
    kept(source: string, size: QuotedMapSize, dark: boolean): QuotedMapPicture | undefined
    /**
     * The picture of this map at this size and theme: the one kept, or one drawn in its turn.
     * Rejects with an `AbortError` once `signal` aborts, and with the renderer's error when the map
     * cannot be drawn at all, without its basemap either.
     */
    draw(source: string, size: QuotedMapSize, dark: boolean, signal?: AbortSignal): Promise<QuotedMapPicture>
    /** The browser is back online: try the basemap again, and let go of pictures drawn without it. */
    basemapBack(): void
}

export interface QuotedMapPicturesOptions {
    /** How many pictures are kept; the one shown longest ago is let go first. */
    capacity?: number
    now?(): number
}

/** Pictures kept at once: a panel's worth of maps, a few hundred kilobytes. */
const KEPT_PICTURES = 30
/** How long the basemap is skipped after it failed, unless the browser comes back online first. */
const BASEMAP_RETRY_MS = 60_000
/** Widths are rounded up to this, so a panel resized by a few pixels draws nothing new. */
const WIDTH_STEP = 16
/** Narrower than this, a card is no place to read a map: a collapsed sidebar's sliver, most often. */
const MIN_CARD_WIDTH = 120
const MIN_HEIGHT = 160
const MAX_HEIGHT = 320

/**
 * The size of a picture for a card this many pixels wide, or null while it is too narrow to read a
 * map in: the width rounded up to {@link WIDTH_STEP}, and 16:9 of it, kept between 160 and 320
 * pixels high. The card shows the picture at its own width, at this shape.
 */
export function quotedMapSize(cardWidth: number): QuotedMapSize | null {
    if (!(cardWidth >= MIN_CARD_WIDTH)) return null
    const width = Math.ceil(cardWidth / WIDTH_STEP) * WIDTH_STEP
    return { width, height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round((width * 9) / 16))) }
}

/** A drawing asked for and not yet finished, shared by everyone waiting for it. */
interface Job {
    source: string
    size: QuotedMapSize
    dark: boolean
    waiting: number
    started: boolean
    result: Promise<QuotedMapPicture>
    settle(result: QuotedMapPicture | null, error?: unknown): void
}

function abortError(): DOMException {
    return new DOMException('The picture is no longer wanted.', 'AbortError')
}

export function createQuotedMapPictures(renderer: MapPictureRenderer, options: QuotedMapPicturesOptions = {}): QuotedMapPictures {
    const capacity = options.capacity ?? KEPT_PICTURES
    const now = options.now ?? Date.now
    /** Kept pictures, the one shown longest ago first: a Map keeps the order entries were set in. */
    const pictures = new Map<string, QuotedMapPicture>()
    const jobs = new Map<string, Job>()
    /** Each drawing starts once the one before it has finished. */
    let turn: Promise<void> = Promise.resolve()
    /** Until when the basemap is skipped, after it failed. */
    let basemapSkippedUntil = 0

    const keyOf = (source: string, size: QuotedMapSize, dark: boolean) => `${size.width}x${size.height} ${dark ? 'dark' : 'light'}\n${source}`
    const basemapSkipped = () => now() < basemapSkippedUntil

    function kept(key: string): QuotedMapPicture | undefined {
        const picture = pictures.get(key)
        if (!picture) return undefined
        // A picture drawn without its basemap is let go once the basemap may load again.
        if (!picture.basemap && !basemapSkipped()) {
            pictures.delete(key)
            return undefined
        }
        // Shown again: now the one shown most recently.
        pictures.delete(key)
        pictures.set(key, picture)
        return picture
    }

    function keep(key: string, picture: QuotedMapPicture): void {
        pictures.set(key, picture)
        for (const oldest of pictures.keys()) {
            if (pictures.size <= capacity) break
            pictures.delete(oldest)
        }
    }

    async function render(job: Job): Promise<QuotedMapPicture> {
        const request = { ...job.size, dark: job.dark }
        if (!basemapSkipped()) {
            try {
                return { picture: await renderer(job.source, { ...request, basemap: true }), basemap: true }
            } catch {
                basemapSkippedUntil = now() + BASEMAP_RETRY_MS
            }
        }
        return { picture: await renderer(job.source, { ...request, basemap: false }), basemap: false }
    }

    async function run(key: string, job: Job): Promise<void> {
        // Everyone stopped waiting before its turn came.
        if (job.waiting === 0) return
        job.started = true
        try {
            const picture = await render(job)
            keep(key, picture)
            job.settle(picture)
        } catch (error) {
            job.settle(null, error)
        } finally {
            jobs.delete(key)
        }
    }

    function enqueue(key: string, source: string, size: QuotedMapSize, dark: boolean): Job {
        let settle!: Job['settle']
        const result = new Promise<QuotedMapPicture>((resolve, reject) => {
            settle = (picture, error) => (picture ? resolve(picture) : reject(error))
        })
        // Everyone waiting may have stopped by the time it settles: its failure is theirs, not unhandled.
        result.catch(() => {})
        const job: Job = { source, size, dark, waiting: 0, started: false, result, settle }
        jobs.set(key, job)
        turn = turn.then(() => run(key, job))
        return job
    }

    return {
        kept: (source, size, dark) => kept(keyOf(source, size, dark)),

        draw(source, size, dark, signal) {
            if (signal?.aborted) return Promise.reject(abortError())
            const key = keyOf(source, size, dark)
            const picture = kept(key)
            if (picture) return Promise.resolve(picture)
            const job = jobs.get(key) ?? enqueue(key, source, size, dark)
            job.waiting++
            return new Promise<QuotedMapPicture>((resolve, reject) => {
                const stop = () => {
                    job.waiting--
                    // Not started and nobody else waits: dropped before it is drawn.
                    if (job.waiting === 0 && !job.started) jobs.delete(key)
                    reject(abortError())
                }
                signal?.addEventListener('abort', stop, { once: true })
                job.result.then(
                    (drawn) => {
                        signal?.removeEventListener('abort', stop)
                        resolve(drawn)
                    },
                    (error: unknown) => {
                        signal?.removeEventListener('abort', stop)
                        reject(error)
                    },
                )
            })
        },

        basemapBack() {
            basemapSkippedUntil = 0
            for (const [key, picture] of pictures) if (!picture.basemap) pictures.delete(key)
        },
    }
}

/** Each open graph's pictures, by its contributions: let go with the graph. */
const graphs = new WeakMap<ContributionRegistry, Map<string, { renderer: MapPictureRenderer; pictures: QuotedMapPictures }>>()

/**
 * The pictures of the fences with this info word in the graph these contributions belong to, or
 * null when nothing draws them as a picture: no maps extension, or not a `map` fence.
 */
export function quotedMapPicturesIn(registry: ContributionRegistry, info: string): QuotedMapPictures | null {
    if (!info) return null
    const renderer = registry.get(MAP_PICTURE_KIND, info) as MapPictureRenderer | undefined
    if (!renderer) return null
    let byInfo = graphs.get(registry)
    if (!byInfo) {
        byInfo = new Map()
        graphs.set(registry, byInfo)
    }
    const held = byInfo.get(info)
    // The extension switched off and on again contributes its renderer again.
    if (held?.renderer === renderer) return held.pictures
    const pictures = createQuotedMapPictures(renderer)
    byInfo.set(info, { renderer, pictures })
    return pictures
}

/** {@link quotedMapPicturesIn} the open graph, or null outside one. */
export function quotedMapPictures(info: string): QuotedMapPictures | null {
    const registry = tryGetActiveContributionRegistry()
    return registry ? quotedMapPicturesIn(registry, info) : null
}
