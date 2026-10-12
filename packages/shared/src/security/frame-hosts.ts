/**
 * The hosts whose pages the Client may show in a frame (ADR 0137): video players, which a document
 * shows through an extension. Kept apart from `csp.ts`, which reads files at build time, so the
 * Client's frame builder (`apps/client/src/lib/extensions/frames.ts`) reads the same list in the
 * browser, and the policy and the builder can never disagree.
 *
 * Other sites only: `cspDirectives` keeps the app's own origin in `frame-src` itself, and never
 * allows `blob:` (ADR 0055). These are cross-origin pages that inherit nothing from the app.
 */
export const PLAYER_FRAME_HOSTS: readonly string[] = ['https://www.youtube-nocookie.com', 'https://player.vimeo.com']
