/**
 * The addresses [[Built-in Extension]]s declare for their View kinds (ADR 0121): `/k/<concept>`
 * for a Kanban Board, `/graph-view` for the whole graph. One route serves them all, so the Client
 * knows an address only by what a manifest says, never by an extension's name.
 *
 * A concept address carries its concept in the rest of the path, encoded per segment as a
 * Document URL is. A fixed address carries nothing, and names the kind's one View per graph by
 * the target its declaration fixes.
 */
import type { ExtensionManifest, ViewRef } from '@appsoftwareltd/etherpk-extension-api'

import { encodeConceptPath } from '$lib/navigation/concept-path'

interface Address {
    segment: string
    kind: string
    /** A concept address, or the fixed target of a one-per-graph View. */
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
    /** Every declared segment, for the route's parameter matcher. */
    segments(): readonly string[]
    /** Whether a kind's Views are about a concept, which they follow through a rename. */
    takesConcept(kind: string): boolean
}

export function createAddressBook(extensions: readonly { package: { manifest: ExtensionManifest } }[]): AddressBook {
    const bySegment = new Map<string, Address>()
    const byKind = new Map<string, Address>()
    for (const { package: extension } of extensions) {
        for (const declaration of extension.manifest.views ?? []) {
            const declared = declaration.address
            if (!declared) continue
            const address: Address = {
                segment: declared.segment,
                kind: declaration.kind,
                target: declared.target === 'concept' ? { concept: true } : { fixed: declaration.target ?? '' },
            }
            bySegment.set(address.segment, address)
            byKind.set(address.kind, address)
        }
    }
    const segments = [...bySegment.keys()]
    return {
        url(graphId, view) {
            const address = byKind.get(view.kind)
            if (!address) return null
            const base = `/g/${encodeURIComponent(graphId)}/${address.segment}`
            return 'concept' in address.target ? `${base}/${encodeConceptPath(view.target)}` : base
        },
        view(segment, rest) {
            const address = bySegment.get(segment)
            if (!address) return null
            if ('concept' in address.target) return rest === '' ? null : { kind: address.kind, target: rest }
            return rest === '' ? { kind: address.kind, target: address.target.fixed } : null
        },
        segments: () => segments,
        takesConcept: (kind) => {
            const address = byKind.get(kind)
            return address !== undefined && 'concept' in address.target
        },
    }
}
