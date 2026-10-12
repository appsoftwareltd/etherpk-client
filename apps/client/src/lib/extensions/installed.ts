/**
 * The releases of Extension Directory extensions on this device (ADR 0123). Which extensions a
 * person has follows them in their settings (installed-sync.ts). Which release of each this device
 * runs is kept here, each with its package.json, so the Client knows its extensions, their names
 * and their View kinds as it starts, before it has fetched anything, as it knows its Built-in
 * Extensions.
 *
 * A newer release found while the Client runs waits beside the one running (`next`) and takes its
 * place as the Client next starts (`promoteStaged`), so nothing an extension is drawing is torn down.
 */

/** The localStorage key holding the installed releases, as a JSON list. */
export const INSTALLED_EXTENSIONS_KEY = 'etherpk:extensions-installed'

/** One release of an extension: which, and its package.json as the Client's server served it. */
export interface ReleaseRecord {
    version: string
    /** The npm integrity hash the directory listed, which names the release's address. */
    integrity: string
    packageJson: unknown
}

export interface InstalledRelease extends ReleaseRecord {
    id: string
    /** When this release took the place of an earlier one on this device, in ms since 1970. */
    updatedAt?: number
    /** A newer release, checked and fetched, that runs from the Client's next start. */
    next?: ReleaseRecord
}

export interface InstalledExtensions {
    list(): InstalledRelease[]
    /** Keep a release, in place of any earlier one of the same extension. */
    put(release: InstalledRelease): void
    remove(id: string): void
    /** Keep a newer release of an installed extension, to run from the next start. */
    stage(id: string, next: ReleaseRecord): void
    /** Put each staged release in place of the one it updates, as the Client starts. Returns their ids. */
    promoteStaged(now: number): string[]
    /** Called after each change. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void
}

function isReleaseRecord(value: unknown): value is ReleaseRecord {
    if (typeof value !== 'object' || value === null) return false
    const release = value as Record<string, unknown>
    return typeof release.version === 'string' && typeof release.integrity === 'string' && 'packageJson' in release
}

function isRelease(value: unknown): value is InstalledRelease {
    if (!isReleaseRecord(value)) return false
    const release = value as unknown as Record<string, unknown>
    return typeof release.id === 'string' && (release.next === undefined || isReleaseRecord(release.next))
}

export function createInstalledExtensions(storage: Storage | undefined = safeLocalStorage()): InstalledExtensions {
    let releases = read(storage)
    const listeners = new Set<() => void>()
    const write = () => {
        try {
            storage?.setItem(INSTALLED_EXTENSIONS_KEY, JSON.stringify(releases))
        } catch {
            // A browser refusing storage keeps the extension for this session only.
        }
        for (const listener of listeners) listener()
    }
    return {
        list: () => [...releases],
        put(release) {
            releases = [...releases.filter((existing) => existing.id !== release.id), release]
            write()
        },
        remove(id) {
            if (!releases.some((release) => release.id === id)) return
            releases = releases.filter((release) => release.id !== id)
            write()
        },
        stage(id, next) {
            if (!releases.some((release) => release.id === id)) return
            releases = releases.map((release) => (release.id === id ? { ...release, next } : release))
            write()
        },
        promoteStaged(now) {
            const promoted = releases.filter((release) => release.next).map((release) => release.id)
            if (promoted.length === 0) return []
            releases = releases.map(({ next, ...release }) => (next ? { id: release.id, ...next, updatedAt: now } : release))
            write()
            return promoted
        },
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
}

function read(storage: Storage | undefined): InstalledRelease[] {
    try {
        const parsed: unknown = JSON.parse(storage?.getItem(INSTALLED_EXTENSIONS_KEY) ?? '[]')
        return Array.isArray(parsed) ? parsed.filter(isRelease) : []
    } catch {
        return []
    }
}

/** The browser's localStorage, or none where reading it throws (a sandboxed frame, Node). */
function safeLocalStorage(): Storage | undefined {
    try {
        return typeof localStorage === 'undefined' ? undefined : localStorage
    } catch {
        return undefined
    }
}
