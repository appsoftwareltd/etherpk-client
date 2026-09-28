/**
 * Rewriting arbitrary keys of a document's [[Frontmatter]] block, the way `withFrontmatterIdentity`
 * rewrites identity: other keys keep their values, order and comments, the same string comes back
 * when nothing would change, and a block whose YAML does not parse is left alone rather than
 * destroyed. `null` removes a key. A block emptied of every key is removed with it. Identity keys
 * are not this function's business: pass them through `withFrontmatterIdentity` so the registry
 * rules (ADR 0061) apply.
 */

import { editFrontmatter } from './frontmatter-yaml'

export type FrontmatterPatch = Readonly<Record<string, unknown>>

export function withFrontmatterPatch(text: string, patch: FrontmatterPatch, options: { addBlock?: boolean } = {}): string {
    return editFrontmatter(
        text,
        (block) => {
            for (const [key, value] of Object.entries(patch)) {
                if (value === null || value === undefined) block.delete(key)
                else block.set(key, value)
            }
        },
        options,
    )
}
