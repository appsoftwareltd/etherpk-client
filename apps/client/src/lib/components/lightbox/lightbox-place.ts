/**
 * Where the [[Lightbox]] is among the images it was given: the one it shows, counted from one, and
 * the ones Previous and Next step to. Stepping follows the order the images were given in and stops
 * at either end rather than wrapping, so "3 of 3" with Next disabled says plainly there is no more.
 */

export interface LightboxPlace {
    /** The image's position among the images, counted from one. */
    position: number
    count: number
    /** The index Previous steps to, or null at the first image. */
    previous: number | null
    /** The index Next steps to, or null at the last image. */
    next: number | null
}

/** The place of the image at `index` among `count` images (at least one), held inside them. */
export function lightboxPlace(count: number, index: number): LightboxPlace {
    const at = Number.isFinite(index) ? Math.min(Math.max(0, Math.trunc(index)), count - 1) : 0
    return {
        position: at + 1,
        count,
        previous: at > 0 ? at - 1 : null,
        next: at < count - 1 ? at + 1 : null,
    }
}
