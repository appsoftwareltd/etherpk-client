/**
 * The editor's **plain profile**: what editing a file of a [[Plain Folder]] asks of the workspace
 * around it, in place of what a graph gives.
 *
 * One editor serves graphs and Plain Folders alike. In a Plain Folder its graph features are off
 * (wikilinks, backlinks, the frontmatter's identity, everything that reads the graph index), and
 * the two things a graph resolved by name are resolved by path instead: where a markdown link
 * leads, and which file a picture or recording line shows. A workspace that publishes this
 * service is what turns the profile on (`WorkspaceServices.plain`).
 */
import type { RemoteImagePolicy } from '../document/view/augmentations/image-embed'
import type { AssetStore, ResolvedAsset } from '../storage/fs/asset-store'

import type { PathSuggestion } from './path-complete-core'

/** Where a followed link opens: in a tab of the same Pane, or beside the file that holds it. */
export type LinkPlacement = 'tab' | 'right' | 'below'

export interface PlainProfile {
    /** Follow a markdown link held by the file at `from`. `href` is the destination as written. */
    openLink(from: string, href: string, placement: LinkPlacement): void
    /**
     * The picture, recording or other file a relative reference in the file at `from` names, as
     * something the browser can show. Null when nothing is there, or the reference leaves the folder.
     */
    resolveMedia(from: string, ref: string): Promise<ResolvedAsset | null>
    /**
     * Whether the file at `path` is open read-only: it is not UTF-8, or is over the editing limit.
     * Asked as the editor mounts, so the View is mounted again when the answer changes.
     */
    readOnly(path: string): boolean
    /**
     * Where a file pasted or dropped into the file at `from` is kept, and how it is linked: near
     * the document, under its own name, by a relative link (plain-assets.ts).
     */
    assets(from: string): AssetStore
    /** The files to offer while a link's destination is typed in the file at `from`. */
    suggestPaths(from: string, query: string): PathSuggestion[]
    /**
     * Whether the file at `path` is in the Text Editor: it is text that is not markdown (a `.txt`, a
     * script), or a markdown file the person opens as text (file-editors.ts). The editor then leaves
     * out its outliner and everything that reads markdown. Asked as the editor mounts, and again
     * when the person switches the file's editor (`DocumentView.reopen`).
     */
    textOnly(path: string): boolean
    /** Whether pictures from the network load in this folder: they wait for the person's word (ADR 0197). */
    remoteImages: RemoteImagePolicy
}
