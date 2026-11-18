import type { GraphAddress, GraphWhere } from '#lib/navigation/graph-address.js'

import type { LayoutLoad } from './$types'

// The workspace is built client-side (it needs the File System Access handle and
// browser APIs). The loader just forwards the Graph Address (ADR 0192) and the dev flags.
// In dev, `/graph/browser/<id>` for a graph the registry does not hold builds its store over
// a private-storage folder, so Playwright can drive the whole route headlessly (the FSA
// picker dialog cannot be automated).
/** A non-negative number of milliseconds, or undefined for the default. */
function indexingIconMs(raw: string | null): number | undefined {
    if (raw === null) return undefined
    const ms = Number(raw)
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined
}

export const load: LayoutLoad = ({ params, url }) => ({
    // The matcher (src/params.ts) lets only the three places through.
    address: { where: params.where as GraphWhere, name: params.name } satisfies GraphAddress,
    // Dev-only autosave-window override (ms), so e2e can hold a buffer dirty long
    // enough to exercise the conflict path deterministically. Ignored in prod.
    autosaveMs: Number(url.searchParams.get('autosaveMs')) || undefined,
    // Dev-only show delay (ms) for the toolbar's indexing icon. 0 is meaningful (show at once),
    // so e2e can see the icon on a graph too small to keep the index busy for long. Ignored in prod.
    indexingIconMs: indexingIconMs(url.searchParams.get('indexingIconMs')),
    // Dev/e2e-only Server Backend gate (Phase 3): drives the E2EE sync engine headlessly
    // against a test relay, the same way `/graph/browser/` bypasses the FSA picker. The real
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
                  // How long a document goes without an edit before an idle Document Version
                  // (ADR 0184): 30 s in the app, shortened so e2e need not wait it out.
                  versionIdleMs: Number(url.searchParams.get('versionIdleMs')) || undefined,
              }
            : undefined,
})
