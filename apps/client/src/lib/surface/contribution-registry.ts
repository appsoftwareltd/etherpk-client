/**
 * The generic, kind-parameterised **Contribution registry** (Extension Architecture.md
 * → *The one surface*; CONTEXT.md → **Contribution Point**). A single registry holding
 * declarative contributions grouped by **point kind** — a View kind, a menu item, an
 * Augmentation renderer, … — filled by first-party features and (later) Extensions alike.
 *
 * Generalised from the Layout's `ViewRegistry` (the original, specialised instance of
 * this pattern), earned by its **second kind: the menu-item** that feeds the Command Menu
 * (the `/` slash menu) — see docs/adr/0017-contribution-registry-generalised-early-for-the-command-menu.md.
 * The View kind is hosted here too (`createViewRegistry` is now a typed facade over the
 * `'view'` point), so this is genuinely one registry, two kinds.
 *
 * Stringly-typed with an untyped value (the honest runtime shape — extension kinds and
 * ids are dynamic), mirroring the Command registry. First-party callers use typed facades
 * over it (e.g. `createViewRegistry`, the `command-menu` helpers).
 */

const ID_SEPARATOR = ':' // reserved for viewKey; kinds/ids use `.`

/** One stored contribution: its id within a point kind, and its (untyped) value. */
export interface ContributionEntry {
    id: string
    value: unknown
}

export interface ContributionRegistry {
    /**
     * Register `value` under (`kind`, `id`). Throws on collision or a non-registerable
     * kind/id (empty, or containing `:`). Returns an unregister fn that withdraws exactly
     * this contribution (a no-op if it was already replaced).
     */
    register(kind: string, id: string, value: unknown): () => void
    /** Withdraw the contribution at (`kind`, `id`); a no-op when absent. */
    unregister(kind: string, id: string): void
    get(kind: string, id: string): unknown
    has(kind: string, id: string): boolean
    /** Every contribution registered under `kind`, in registration order. */
    list(kind: string): ContributionEntry[]
}

/** Registerable kinds and ids are non-empty and contain no `:` (the viewKey separator). */
export function isRegisterableContributionId(value: string): boolean {
    return value.length > 0 && !value.includes(ID_SEPARATOR)
}

export function createContributionRegistry(): ContributionRegistry {
    // kind → (id → value), insertion-ordered by Map semantics.
    const byKind = new Map<string, Map<string, unknown>>()

    function bucket(kind: string): Map<string, unknown> {
        let m = byKind.get(kind)
        if (!m) {
            m = new Map()
            byKind.set(kind, m)
        }
        return m
    }

    return {
        register(kind, id, value) {
            if (!isRegisterableContributionId(kind)) {
                throw new Error(`Contribution kind ${JSON.stringify(kind)} is not registerable (non-empty, no ':').`)
            }
            if (!isRegisterableContributionId(id)) {
                throw new Error(`Contribution id ${JSON.stringify(id)} is not registerable (non-empty, no ':').`)
            }
            const m = bucket(kind)
            if (m.has(id)) {
                throw new Error(`Contribution "${kind}/${id}" is already registered.`)
            }
            m.set(id, value)
            return () => {
                if (m.get(id) === value) m.delete(id)
            }
        },
        unregister(kind, id) {
            byKind.get(kind)?.delete(id)
        },
        get(kind, id) {
            return byKind.get(kind)?.get(id)
        },
        has(kind, id) {
            return byKind.get(kind)?.has(id) ?? false
        },
        list(kind) {
            const m = byKind.get(kind)
            if (!m) return []
            return [...m.entries()].map(([id, value]) => ({ id, value }))
        },
    }
}
