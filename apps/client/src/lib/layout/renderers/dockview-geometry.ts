/**
 * The geometry the dockview adapter saves into {@link SerializedLayout.renderer}, and the
 * conversion of a Layout saved before the Sidebars became dockview edge groups (ADR 0156).
 *
 * Kept apart from the adapter, which imports dockview's runtime, so the conversion is a plain
 * function over JSON that a unit test can give a saved Layout to.
 */

import type { SerializedDockview } from 'dockview-core'

import type { Region } from '../types'

/** The geometry the adapter contributes to {@link SerializedLayout.renderer}. */
export interface DockviewGeometry {
    dockview: SerializedDockview
    /** Region → dockview group id (group ids are preserved across toJSON/fromJSON). */
    regions: Partial<Record<Region, string>>
}

export type SidebarRegion = 'left-sidebar' | 'right-sidebar'

/** The window edge each Sidebar's edge group sits on. */
export const SIDEBAR_EDGE: Record<SidebarRegion, 'left' | 'right'> = {
    'left-sidebar': 'left',
    'right-sidebar': 'right',
}

/** Each Sidebar's edge group id: fixed, so a saved Layout always names the same group. */
export const SIDEBAR_EDGE_GROUP_ID: Record<SidebarRegion, string> = {
    'left-sidebar': 'left-sidebar',
    'right-sidebar': 'right-sidebar',
}

type GridNode = SerializedDockview['grid']['root']
/** A group's saved state: its id, its tabs and the one in front (dockview does not export the type). */
type GroupPanelViewState = { id: string; views: string[]; activeView?: string }
type Orientation = 'HORIZONTAL' | 'VERTICAL'

const across = (orientation: Orientation): Orientation => (orientation === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL')

/**
 * Take the leaf holding group `id` out of the tree under `branch`, whose children are laid out
 * along `orientation`. Returns the leaf, the orientation its own size is measured along, and how
 * deep it was: 0 for a child of the root.
 */
function takeLeaf(
    branch: GridNode,
    id: string,
    orientation: Orientation,
    depth = 0,
): { leaf: GridNode; along: Orientation; depth: number } | undefined {
    if (branch.type !== 'branch') return undefined
    const children = branch.data as GridNode[]
    for (let at = 0; at < children.length; at++) {
        const child = children[at]
        if (child.type === 'leaf' && (child.data as GroupPanelViewState).id === id) {
            children.splice(at, 1)
            return { leaf: child, along: orientation, depth }
        }
        const found = takeLeaf(child, id, across(orientation), depth + 1)
        if (found) return found
    }
    return undefined
}

/** Whether any group is left in the tree under `node`. */
function holdsAGroup(node: GridNode): boolean {
    return node.type === 'leaf' || (node.data as GridNode[]).some(holdsAGroup)
}

/**
 * A Layout saved while each Sidebar was a column of dockview's grid, rewritten with each Sidebar
 * as an edge group (ADR 0156): its tabs and the width it had come along, and the editor area is
 * left alone in the grid. A Sidebar that is already an edge group, or was never in the grid, is
 * left as it is, so this is safe to apply to every saved Layout.
 *
 * A Sidebar's width is the size of its leaf when the leaf sat in a row. One split into a column of
 * its own, or one that filled a Layout with no editor area beside it, comes back at
 * `defaultWidth`: the size it had there is not a width it was given.
 */
export function sidebarsAsEdgeGroups(geometry: DockviewGeometry, defaultWidth: number): DockviewGeometry {
    const { dockview } = geometry
    const grid = dockview.grid
    const taken: { region: SidebarRegion; leaf: GridNode; width: number | undefined }[] = []
    for (const region of Object.keys(SIDEBAR_EDGE) as SidebarRegion[]) {
        const id = geometry.regions[region]
        if (!id || dockview.edgeGroups?.[SIDEBAR_EDGE[region]]) continue
        const found = takeLeaf(grid.root, id, grid.orientation as Orientation)
        if (!found) continue
        const width = found.along === 'HORIZONTAL' ? found.leaf.size : undefined
        // Out of the grid's top row, its width is no longer part of the grid's.
        if (width !== undefined && found.depth === 0) grid.width = Math.max(0, grid.width - width)
        taken.push({ region, leaf: found.leaf, width })
    }
    if (taken.length === 0) return geometry

    const editorArea = holdsAGroup(grid.root)
    const edgeGroups = { ...dockview.edgeGroups }
    const regions = { ...geometry.regions }
    let activeGroup = dockview.activeGroup
    for (const { region, leaf, width } of taken) {
        const state = leaf.data as GroupPanelViewState
        const id = SIDEBAR_EDGE_GROUP_ID[region]
        edgeGroups[SIDEBAR_EDGE[region]] = {
            size: editorArea && width !== undefined ? width : defaultWidth,
            visible: true,
            group: { ...state, id },
        }
        if (activeGroup === state.id) activeGroup = id
        regions[region] = id
    }
    return {
        dockview: { ...dockview, edgeGroups, ...(activeGroup !== undefined ? { activeGroup } : {}) },
        regions,
    }
}
