/**
 * The addresses extensions declare for their View kinds (ADR 0121): `/k/<concept>` for a Kanban
 * Board, `/graph-view` for the whole graph. One route serves them all, so the Client knows an
 * address only by what a manifest says, never by an extension's name.
 *
 * A Built-in Extension's address is its segment, bare. An extension from the Extension Directory
 * declares one the same way, and it is put under `/x/<extension id>/` (ADR 0123, amended
 * 2026-10-12), so it can never take the Client's own addresses, a built-in's or another's.
 *
 * A concept address carries its concept in the rest of the path, encoded per segment as a
 * Document URL is. A fixed address carries nothing, and names the kind's one View per graph by
 * the target its declaration fixes.
 */
import type { ExtensionManifest, ViewRef } from '@appsoftwareltd/etherpk-extension-api'

import { encodeConceptPath } from '$lib/navigation/concept-path'

/** The segment every Extension Directory extension's addresses start with. */
export const DIRECTORY_SEGMENT = 'x'

/**
 * The Client's View kind for an address under `/x/` whose extension is not installed on this
 * device. Its target is the address after `/x/`: the extension's id, its segment and the rest.
 */
export const EXTENSION_ADDRESS_KIND = 'extension-address'

/** What the address book reads of an extension: its id, whether it came from the directory, its manifest. */
export interface AddressedExtension {
    id: string
    /** Set for an extension installed from the Extension Directory. */
    installed?: unknown
    package: { manifest: ExtensionManifest }
}

interface Address {
    /** The extension's id, for one from the Extension Directory, whose address is under it. */
    directoryId: string | null
    segment: string
    kind: string
    target: { concept: true } | { fixed: string }
}

export interface AddressBook {
    /** The URL naming an extension's View, or null when its kind declares no address. */
    url(graphId: string, view: ViewRef): string | null
    /**
     * The View an address names: its first segment and the rest of the path, already decoded
     * ('' when there is none). Null when no extension declares the segment, or the rest does not
     * fit it. A concept is returned as written: the caller resolves it to its canonical name.
     */
    view(segment: string, rest: string): ViewRef | null
    /**
     * The id of the Extension Directory extension an address belongs to, when no extension here
     * has that id: it is not installed on this device. Null for any other address.
     */
    missing(segment: string, rest: string): string | null
    /** Every bare segment the built-ins declare, for the route's parameter matcher. */
    segments(): readonly string[]
    /** Whether a kind's Views are about a concept, which they follow through a rename. */
    takesConcept(kind: string): boolean
}

const EXTENSION_ID = /^[a-z][a-z0-9-]*$/

function addressesOf(extensions: readonly AddressedExtension[]): Address[] {
    return extensions.flatMap((extension) =>
        (extension.package.manifest.views ?? []).flatMap((declaration) => {
            const declared = declaration.address
            if (!declared) return []
            return [
                {
                    directoryId: extension.installed === undefined ? null : extension.id,
                    segment: declared.segment,
                    kind: declaration.kind,
                    target: declared.target === 'concept' ? { concept: true as const } : { fixed: declaration.target ?? '' },
                },
            ]
        }),
    )
}

/** The View `address` names with `rest` after its segment, or null when `rest` does not fit it. */
function fitting(address: Address, rest: string): ViewRef | null {
    if ('concept' in address.target) return rest === '' ? null : { kind: address.kind, target: rest }
    return rest === '' ? { kind: address.kind, target: address.target.fixed } : null
}

/** `rest` after `/x/`: the extension's id, its address's segment, and what follows them. */
function directoryPath(rest: string): { id: string; segment: string; rest: string } | null {
    const [id = '', segment = '', ...more] = rest.split('/')
    return EXTENSION_ID.test(id) && segment !== '' ? { id, segment, rest: more.join('/') } : null
}

/**
 * An address book over `extensions`: an array, or a function giving the extensions now, so the book
 * follows extensions installed and removed while the Client runs.
 */
export function createAddressBook(extensions: readonly AddressedExtension[] | (() => readonly AddressedExtension[])): AddressBook {
    const current = typeof extensions === 'function' ? extensions : () => extensions
    const addresses = () => addressesOf(current())
    return {
        url(graphId, view) {
            const address = addresses().find((candidate) => candidate.kind === view.kind)
            if (!address) return null
            const prefix = address.directoryId === null ? '' : `${DIRECTORY_SEGMENT}/${address.directoryId}/`
            const base = `/g/${encodeURIComponent(graphId)}/${prefix}${address.segment}`
            return 'concept' in address.target ? `${base}/${encodeConceptPath(view.target)}` : base
        },
        view(segment, rest) {
            if (segment !== DIRECTORY_SEGMENT) {
                const address = addresses().find((candidate) => candidate.directoryId === null && candidate.segment === segment)
                return address ? fitting(address, rest) : null
            }
            const path = directoryPath(rest)
            if (!path) return null
            const address = addresses().find((candidate) => candidate.directoryId === path.id && candidate.segment === path.segment)
            return address ? fitting(address, path.rest) : null
        },
        missing(segment, rest) {
            if (segment !== DIRECTORY_SEGMENT) return null
            const path = directoryPath(rest)
            if (!path) return null
            return current().some((extension) => extension.id === path.id) ? null : path.id
        },
        segments: () => addresses().flatMap((address) => (address.directoryId === null ? [address.segment] : [])),
        takesConcept: (kind) => addresses().some((address) => address.kind === kind && 'concept' in address.target),
    }
}
