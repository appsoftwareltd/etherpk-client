/**
 * What the [[Demo Graph]] bundle must look like before it ships (ADR 0069).
 *
 * The bundle is a committed directory in the canonical on-disk layout under the Client's
 * static folder, plus one sidecar, `demo.json`, declaring the graph's name and the anchor day
 * its dates were written against. A browser cannot list a static directory, so the build
 * derives this manifest from the files and embeds it (see demo-graph-plugin.ts); nothing
 * generated is committed, and the list can never disagree with the files.
 *
 * The same pass is where authoring mistakes are caught, at build time rather than in a
 * visitor's browser: an image reference to a file that is not there, an asset whose name does
 * not carry its own content hash (so a visitor's re-upload of the same bytes would not
 * de-duplicate), a journal that is not named by a day, and a bundle over budget. Every visitor
 * downloads the whole thing, so the budget is deliberately small.
 *
 * Pure: bytes in, manifest or a list of problems out. The Node side supplies the hash.
 */
// Relative, not $lib: this file is also loaded by the Vite config process (demo-graph-plugin.ts).
import { assetHashFromName } from '../storage/fs/asset-names'
import { SUBDIRS, type Subdir } from '../storage/fs/directory-adapter'

import { daysBetween } from './date-shift'

export const DEMO_BUNDLE_SIDECAR = 'demo.json'
export const DEMO_BUNDLE_BUDGET_BYTES = 4 * 1024 * 1024
export const DEMO_DEFAULT_WINDOW_DAYS = 60

export interface BundleSource {
    /** Bundle-relative, `/`-separated: `pages/Plant.md`, `assets/monstera.1a2b3c4d.png`. */
    path: string
    bytes: Uint8Array
}

export interface DemoBundleFile {
    path: string
    size: number
}

export interface DemoBundleManifest {
    /** The graph's display name in the picker. */
    name: string
    /** The day the bundle's dates were written for. */
    anchor: string
    windowDays: number
    files: DemoBundleFile[]
    totalBytes: number
}

export class DemoBundleError extends Error {
    constructor(readonly problems: string[]) {
        super(`The demo graph bundle is not valid:\n- ${problems.join('\n- ')}`)
        this.name = 'DemoBundleError'
    }
}

const ASSET_REFERENCE = /\]\(\.\.\/assets\/([^)\s]+)\)/g

function isSubdir(value: string): value is Subdir {
    return (SUBDIRS as readonly string[]).includes(value)
}

function decode(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes)
}

interface Sidecar {
    name: string
    anchor: string
    windowDays: number
}

function parseSidecar(bytes: Uint8Array | undefined, problems: string[]): Sidecar | null {
    if (!bytes) {
        problems.push(`${DEMO_BUNDLE_SIDECAR} is missing`)
        return null
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(decode(bytes))
    } catch {
        problems.push(`${DEMO_BUNDLE_SIDECAR} is not JSON`)
        return null
    }
    const record = (parsed ?? {}) as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!name) problems.push(`${DEMO_BUNDLE_SIDECAR} needs a non-empty "name"`)
    const anchor = typeof record.anchor === 'string' ? record.anchor : ''
    if (daysBetween(anchor, anchor) === null) problems.push(`${DEMO_BUNDLE_SIDECAR} needs an "anchor" day as YYYY-MM-DD`)
    let windowDays = DEMO_DEFAULT_WINDOW_DAYS
    if (record.windowDays !== undefined) {
        if (typeof record.windowDays === 'number' && Number.isInteger(record.windowDays) && record.windowDays >= 0) {
            windowDays = record.windowDays
        } else {
            problems.push(`${DEMO_BUNDLE_SIDECAR} "windowDays" must be a whole number of days`)
        }
    }
    return { name, anchor, windowDays }
}

export function buildDemoBundleManifest(
    sources: BundleSource[],
    hashAsset: (bytes: Uint8Array) => string,
): DemoBundleManifest {
    const problems: string[] = []
    const byPath = new Map(sources.map((source) => [source.path, source]))
    const sidecar = parseSidecar(byPath.get(DEMO_BUNDLE_SIDECAR)?.bytes, problems)

    const files: DemoBundleFile[] = []
    let totalBytes = 0
    const assetNames = new Set<string>()

    for (const source of sources) {
        if (source.path === DEMO_BUNDLE_SIDECAR) continue
        const segments = source.path.split('/')
        const [subdir, name, ...rest] = segments
        if (!subdir || !name || rest.length > 0 || !isSubdir(subdir)) {
            problems.push(`${source.path}: files live directly under journals/, pages/, assets/ or etherpk/`)
            continue
        }
        if (subdir === 'journals' && !/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) {
            problems.push(`${source.path}: a journal entry is named by its day, YYYY-MM-DD.md`)
        }
        if (subdir === 'pages' && !/\.md$/i.test(name)) {
            problems.push(`${source.path}: a page is a .md file`)
        }
        if (subdir === 'assets') {
            const parsed = assetHashFromName(name)
            if (!parsed) {
                problems.push(`${source.path}: an asset is named <kebab-stem>.<8-hex-content-hash>.<ext>`)
            } else if (parsed.hash !== hashAsset(source.bytes)) {
                problems.push(`${source.path}: the name's hash does not match the file's content (${hashAsset(source.bytes)})`)
            }
            assetNames.add(name)
        }
        files.push({ path: source.path, size: source.bytes.byteLength })
        totalBytes += source.bytes.byteLength
    }

    for (const source of sources) {
        if (!/\.md$/i.test(source.path)) continue
        const text = decode(source.bytes)
        for (const match of text.matchAll(ASSET_REFERENCE)) {
            const referenced = decodeURIComponent(match[1])
            if (!assetNames.has(referenced)) {
                problems.push(`${source.path}: references ../assets/${referenced}, which is not in the bundle`)
            }
        }
    }

    if (totalBytes > DEMO_BUNDLE_BUDGET_BYTES) {
        problems.push(`the bundle is ${totalBytes} bytes; the budget is ${DEMO_BUNDLE_BUDGET_BYTES}`)
    }

    if (problems.length > 0 || !sidecar) throw new DemoBundleError(problems)

    files.sort((a, b) => a.path.localeCompare(b.path))
    return { name: sidecar.name, anchor: sidecar.anchor, windowDays: sidecar.windowDays, files, totalBytes }
}
