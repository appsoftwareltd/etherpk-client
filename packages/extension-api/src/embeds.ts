/**
 * Content from another site shown inside the Client (ADR 0137). The Client allows frames from a short
 * list of hosts only, and builds every frame itself, with the referrer policy, sandbox and
 * permissions those hosts need, so an extension never writes an `<iframe>`.
 */

/**
 * A frame to build.
 *
 * @public
 */
export interface FrameOptions {
    /**
     * The address to show: an `https` address on a host the Client allows, which today are
     * `https://www.youtube-nocookie.com` and `https://player.vimeo.com`.
     */
    src: string
    /** What the frame shows, read out to anyone using a screen reader. Plain text, never markup. */
    title: string
}

/**
 * Frames.
 *
 * @public
 */
export interface ExtensionEmbeds {
    /** The hosts a frame may show, as origins such as `https://player.vimeo.com`. */
    readonly frameHosts: readonly string[]
    /**
     * A frame the Client built for `src`, to put in the extension's own element. It loads once it is
     * in the page. Throws for an address on a host the Client does not allow.
     */
    frame(options: FrameOptions): HTMLIFrameElement
}
