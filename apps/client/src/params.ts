import { defineParams } from '@sveltejs/kit/params'

// SvelteKit's build also imports this file with plain Node, before Vite has run, only to check
// that each matcher a route names exists. The declared segments come from the extensions'
// manifests through Vite (`import.meta.glob` and a virtual module), so they are loaded only where
// Vite built this file: there `import.meta.env` is defined, and under plain Node it is not.
const { DIRECTORY_SEGMENT, DECLARED_SEGMENTS } = import.meta.env
    ? { ...(await import('#lib/extensions/addresses.js')), ...(await import('#lib/extensions/declared-segments.js')) }
    : { DIRECTORY_SEGMENT: undefined, DECLARED_SEGMENTS: new Set<string>() }

export const params = defineParams({
    /**
     * The first segment of an address an extension declares for one of its View kinds (ADR 0121):
     * `k` in `/g/<graph>/k/<concept>`, `graph-view` in `/g/<graph>/graph-view`, and `x`, under which
     * every Extension Directory extension's addresses are (`/g/<graph>/x/<id>/…`, ADR 0123), whether
     * or not it is installed on this device. Any other segment does not match, so an unknown address
     * is a 404 rather than an empty workspace, and the Client's own routes (`d`, `a`, `t`) are never
     * reached here, being static.
     */
    extensionAddress: (param) => (param === DIRECTORY_SEGMENT || DECLARED_SEGMENTS.has(param) ? param : undefined),
})
