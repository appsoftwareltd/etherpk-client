/**
 * The frames an extension may show (ADR 0137): video players, from the hosts the Content Security
 * Policy allows (`PLAYER_FRAME_HOSTS`), built here so every one carries what the players need and
 * nothing more. An extension asks through `context.embeds.frame` and never writes an `<iframe>`.
 *
 * - **The referrer policy.** YouTube refuses a player that sends no referrer (its Error 153), and
 *   `strict-origin-when-cross-origin` is what it asks for: the player learns the Client's origin and
 *   never a page's path, which holds the graph's id.
 * - **The sandbox.** Scripts and the player's own origin, so it can keep its settings, plus the
 *   presentation API and popups for "Watch on YouTube". Nothing reaches the Client's page: a sandboxed
 *   frame on another origin cannot script it, navigate it or open a dialog over it.
 * - **The permissions.** The list YouTube's own embed code asks for, and full screen.
 */
import { PLAYER_FRAME_HOSTS } from '@appsoftwareltd/etherpk-shared/frame-hosts'

export const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox'
export const FRAME_ALLOW = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen'
export const FRAME_REFERRER_POLICY = 'strict-origin-when-cross-origin'

/** The address a frame may show, normalised, or null when its host is not one the Client allows. */
export function allowedFrameAddress(src: string, hosts: readonly string[] = PLAYER_FRAME_HOSTS): string | null {
    let url: URL
    try {
        url = new URL(src)
    } catch {
        return null
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
    return hosts.includes(url.origin) ? url.href : null
}

/** The attributes a frame for this address and title carries. Throws for a host the Client does not allow. */
export function frameAttributes(options: { src: string; title: string }, hosts: readonly string[] = PLAYER_FRAME_HOSTS): Record<string, string> {
    const src = allowedFrameAddress(options.src, hosts)
    if (src === null) throw new Error(`The Client shows frames only from ${hosts.join(' and ')}, not from ${options.src}.`)
    const title = options.title.trim()
    if (title === '') throw new Error('A frame needs a title, which a screen reader reads out.')
    return {
        src,
        title,
        sandbox: FRAME_SANDBOX,
        allow: FRAME_ALLOW,
        referrerpolicy: FRAME_REFERRER_POLICY,
        loading: 'lazy',
        allowfullscreen: '',
    }
}

/** A frame built for `options`, to be put in the page by the extension that asked for it. */
export function buildFrame(options: { src: string; title: string }, hosts: readonly string[] = PLAYER_FRAME_HOSTS): HTMLIFrameElement {
    // Checked before anything is built, so a refused address throws before it reaches the page.
    const attributes = frameAttributes(options, hosts)
    const frame = document.createElement('iframe')
    for (const [name, value] of Object.entries(attributes)) frame.setAttribute(name, value)
    return frame
}
