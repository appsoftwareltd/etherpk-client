/**
 * View identity.
 *
 * A {@link ViewRef} names *what* a View shows — its `kind` (document, asset,
 * backlinks, …) and the `target` it references (a concept name, document id,
 * asset id, …). Identity is the heart of the singleton rule (decision #6): by
 * default opening the same thing twice resolves to one View. The derived
 * {@link viewKey} is that identity, and maps directly onto dockview's unique
 * panel `id` once the adapter lands.
 */

export interface ViewRef {
    /** The category of content. Open-ended so new View kinds need no enum change. */
    kind: 'document' | 'asset' | 'backlinks' | (string & {})
    /** The thing the View shows — concept name, document id, asset id, etc. */
    target: string
}

/** Separator between `kind` and `target` in a {@link viewKey}. */
export const KEY_SEPARATOR = ':'

/**
 * Separator between an extension id and its local kind in a namespaced View
 * kind, e.g. `"acme-diagrams.flow"`. Deliberately *not* {@link KEY_SEPARATOR},
 * so a namespaced kind never collides with the kind/target split in a
 * {@link viewKey}.
 */
export const KIND_NAMESPACE_SEPARATOR = '.'

/**
 * Namespace a View kind to the extension that contributes it, so two extensions
 * can each contribute a kind without colliding. First-party (core) kinds are
 * unprefixed (`document`, `backlinks`, …); extension kinds are
 * `"<extensionId>.<kind>"`, mirroring the `publisher.command` convention.
 */
export function namespacedViewKind(extensionId: string, kind: string): string {
    return `${extensionId}${KIND_NAMESPACE_SEPARATOR}${kind}`
}

/**
 * Whether a kind may be registered. A kind must be non-empty and must not
 * contain {@link KEY_SEPARATOR}, which would corrupt the kind/target split when
 * a Layout referencing it is persisted and restored.
 */
export function isRegisterableViewKind(kind: string): boolean {
    return kind.length > 0 && !kind.includes(KEY_SEPARATOR)
}

/**
 * The stable identity key for a View, `"${kind}:${target}"`.
 *
 * Equal refs always produce an equal key, so it doubles as a Map key and as the
 * dockview panel id for singleton Views.
 */
export function viewKey(ref: ViewRef): string {
    return `${ref.kind}${KEY_SEPARATOR}${ref.target}`
}

/**
 * Inverse of {@link viewKey}. Only the *first* separator splits kind from
 * target, so targets that themselves contain colons (scoped concepts, urls)
 * round-trip intact.
 */
export function parseViewKey(key: string): ViewRef {
    const separatorIndex = key.indexOf(KEY_SEPARATOR)
    if (separatorIndex === -1) {
        // No separator: treat the whole string as the target with an empty kind
        // rather than throwing, so a malformed persisted key degrades gracefully.
        return { kind: '', target: key }
    }
    return {
        kind: key.slice(0, separatorIndex),
        target: key.slice(separatorIndex + KEY_SEPARATOR.length),
    }
}

/** True when two refs denote the same View (identical key). */
export function sameView(a: ViewRef, b: ViewRef): boolean {
    return viewKey(a) === viewKey(b)
}
