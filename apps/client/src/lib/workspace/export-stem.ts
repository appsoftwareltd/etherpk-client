/**
 * The stem a graph's export is named by: the archive's top-level folder and, with the date, its
 * file name (`<stem> <date>.zip`).
 *
 * It is the graph's name as a folder graph would name its folder. A graph with no name yet is
 * called what the Graph Sidebar's tab calls it, "Graph". An empty name must not reach
 * `portableFileStem`, which answers `_` for it: the archive would be `_ 2026-11-16.zip`.
 */
import { portableFileStem } from '#lib/document/wikilink/index.js'

import { sidebarTabTitle } from './sidebar-tab-title'

export function graphExportStem(name: string, graphId: string): string {
    return portableFileStem(sidebarTabTitle(name, graphId))
}
