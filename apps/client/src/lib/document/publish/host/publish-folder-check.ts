/**
 * Whether a folder chosen as a [[Publish Folder]] overlaps a [[Graph Folder]] this device knows.
 *
 * A publish deletes, from the folder it writes into, the files under `assets/`, `theme/`, `maps/`
 * and `pictures/` and the top-level pages it did not produce (`isOwnedPath` in `site-writer.ts`). Published into a
 * graph's own folder it would delete the graph's attachments, published inside one it mixes the
 * site's files (a `README.md`, an `AGENTS.md`) into the graph, and published into a folder that
 * holds one it can reach the graph's files below. So all three are refused, compared by handle
 * and never by name, as the Local Mirror's own check does (`mirror-takeover.ts`). The Headless
 * Client applies the same rule to paths (`apps/mcp/src/publish-folders.ts`).
 *
 * Framework-free: handles are anything with `isSameEntry` and `resolve`, so the rule is unit
 * tested with stand-ins and the browser glue only gathers the known folders.
 */
import type { ComparableHandle, FolderGraph, KnownFolder } from '$lib/storage/server/mirror-takeover'

/** Whose graph folder a chosen folder overlaps, and how. */
export type PublishFolderOverlap = FolderGraph & { relation: 'same' | 'inside' | 'contains' }

/** A comparison that throws - a remembered handle to a folder that has since gone - is no match. */
async function attempt<T>(compare: () => Promise<T>): Promise<T | null> {
    try {
        return await compare()
    } catch {
        return null
    }
}

/**
 * The graph folder `handle` overlaps among `known`, or null. The same folder wins over one it is
 * inside, which wins over one it holds, so the message names the closest relation.
 */
export async function findPublishFolderOverlap(handle: ComparableHandle, known: readonly KnownFolder[]): Promise<PublishFolderOverlap | null> {
    for (const entry of known) {
        if (await attempt(() => handle.isSameEntry(entry.handle as never))) return { ...entry.owner, relation: 'same' }
    }
    for (const entry of known) {
        const graph = entry.handle as Partial<ComparableHandle> | null
        if (typeof graph?.resolve !== 'function') continue
        const down = await attempt(() => graph.resolve!(handle as never))
        if (down && down.length > 0) return { ...entry.owner, relation: 'inside' }
    }
    for (const entry of known) {
        const up = await attempt(() => handle.resolve(entry.handle as never))
        if (up && up.length > 0) return { ...entry.owner, relation: 'contains' }
    }
    return null
}

/**
 * The refusal shown at the publication's row: what the folder is, why that is refused, what next.
 * Worded as the Local Mirror's refusals are, so the two read alike.
 */
export function publishFolderOverlapMessage(folder: string, overlap: PublishFolderOverlap): string {
    const name = `“${overlap.name}”`
    const what =
        overlap.kind === 'mirror'
            ? {
                  same: `is where ${name} is mirrored on this device`,
                  inside: `is inside the folder where ${name} is mirrored on this device`,
                  contains: `holds the folder where ${name} is mirrored on this device`,
              }[overlap.relation]
            : {
                  same: `is the folder of your local graph ${name}`,
                  inside: `is inside the folder of your local graph ${name}`,
                  contains: `holds the folder of your local graph ${name}`,
              }[overlap.relation]
    return (
        `“${folder}” ${what}. ` +
        'A publish deletes the files it did not write from the folder it publishes into, so a site needs a folder of its own, outside any graph. ' +
        'Choose another folder.'
    )
}
