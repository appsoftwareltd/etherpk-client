import type { LayoutLoad } from './$types'

// The workspace is built client-side (it needs the File System Access handle and
// browser APIs). The loader just forwards the graph id and the dev-only OPFS test
// flag — when `?fs=opfs` is set in dev, the workspace builds its store over an
// OPFS-rooted directory instead of the picked folder, so Playwright can drive the
// whole route headlessly (the FSA picker dialog cannot be automated).
/** A non-negative number of milliseconds, or undefined for the default. */
function indexingIconMs(raw: string | null): number | undefined {
    if (raw === null) return undefined
    const ms = Number(raw)
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined
}

export const load: LayoutLoad = ({ params, url }) => ({
    graphId: params.graphId,
    opfs: url.searchParams.get('fs') === 'opfs',
    // Dev-only autosave-window override (ms), so e2e can hold a buffer dirty long
    // enough to exercise the conflict path deterministically. Ignored in prod.
    autosaveMs: Number(url.searchParams.get('autosaveMs')) || undefined,
    // Dev-only show delay (ms) for the toolbar's indexing icon. 0 is meaningful (show at once),
    // so e2e can see the icon on a graph too small to keep the index busy for long. Ignored in prod.
    indexingIconMs: indexingIconMs(url.searchParams.get('indexingIconMs')),
    // Dev/e2e-only Server Backend gate (Phase 3): drives the E2EE sync engine headlessly
    // against a test relay, the same way ?fs=opfs bypasses the FSA picker. The real
    // create-graph/keys UX is Phase 4; here the raw graph key + relay + token are injected.
    server:
        url.searchParams.get('backend') === 'server'
            ? {
                  relay: url.searchParams.get('relay') ?? '',
                  token: url.searchParams.get('token') ?? '',
                  gkey: url.searchParams.get('gkey') ?? '',
                  root: url.searchParams.get('root') ?? '',
                  // Optional HTTP base URL for the asset API, so e2e can drive the real
                  // encrypted-asset flow (begin/complete/get + presigned chunk transfer)
                  // against a test fixture. Absent → assets stay off under the gate.
                  http: url.searchParams.get('http') ?? undefined,
              }
            : undefined,
})
