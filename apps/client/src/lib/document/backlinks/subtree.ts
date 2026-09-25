/**
 * A block reference's subtree as a tree. The index lists it flat, in document order with each
 * node's depth below the matched block (`RefSubtreeNode`), which is all a reader of the text needs;
 * the Backlinks panel nests it again so each parent can hang its outline guide thread beside its
 * own descendants, as the editor draws it.
 */

export interface SubtreeBranch<T> {
    node: T
    children: SubtreeBranch<T>[]
}

/** Nest nodes listed in document order by depth: each is the child of the nearest shallower one above it. */
export function nestSubtree<T extends { depth: number }>(nodes: readonly T[]): SubtreeBranch<T>[] {
    const roots: SubtreeBranch<T>[] = []
    const open: SubtreeBranch<T>[] = []
    for (const node of nodes) {
        const branch: SubtreeBranch<T> = { node, children: [] }
        while (open.length > 0 && open[open.length - 1].node.depth >= node.depth) open.pop()
        const parent = open[open.length - 1]
        if (parent) parent.children.push(branch)
        else roots.push(branch)
        open.push(branch)
    }
    return roots
}
