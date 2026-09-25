/**
 * What the Publish tab of the Settings modal needs (ADR 0082, [[Publish]], [[Publication]]).
 *
 * A module rather than a type inside the component, for the same reason as `mirror-tab.ts`: the
 * Settings modal and the workspace that fills it both name the shape, and a Svelte instance
 * script cannot export a type. Every callback is the workspace's, over the open graph.
 */
import type { PublishReport } from '$lib/document/publish/publish'
import type { GraphTheme } from '$lib/document/publish/theme/graph-theme'
import type { Publication, PublishIssue } from '$lib/document/publish/types'
import type { NewPublicationInput, PublicationChanges, PublishDocumentSummary } from '$lib/workspace/publish-service'

export interface GraphPublishingState {
    publications: Publication[]
    issues: PublishIssue[]
    /** Public documents no publication takes. */
    publicInNoPublication: string[]
    /** Every document, with what decides whether a publish takes it: what the field warnings read. */
    documents: PublishDocumentSummary[]
    /** Documents whose text is not confirmed on this device yet, and so cannot be published from it. */
    unsettled: string[]
}

export interface PublicationFolderState {
    folder: string
    publishedAt?: string
}

export type PublishTarget = 'folder' | 'zip'

export interface PublishOutcome {
    report: PublishReport
    /** Where it went. */
    target: PublishTarget
    written?: { written: number; unchanged: number; deleted: string[] }
}

export interface PublishTabProps {
    /** Whether this browser can write a folder (the File System Access API). A zip is always offered. */
    folderSupported: boolean
    /** Read the graph for its publications. Slow on a large graph; called when the tab opens and after a change. */
    load(): Promise<GraphPublishingState>
    /** The remembered folder for a publication on this device, or null. */
    folderOf(publicationId: string): Promise<PublicationFolderState | null>
    /** Pick a folder for a publication (a native dialog; needs the click) and remember it. Null when cancelled. */
    onchoosefolder(publicationId: string): Promise<PublicationFolderState | null>
    onforgetfolder(publicationId: string): Promise<void>
    /** Publish to the remembered folder or as a zip download. Progress is reported through the Activity rail. */
    onpublish(publication: Publication, target: PublishTarget): Promise<PublishOutcome>
    /**
     * The last outcome of each publication this session, by id: the workspace keeps them, so
     * the report a finished publish's toast points at is still here when the tab opens later.
     */
    outcomes: Readonly<Record<string, PublishOutcome>>
    /** A publication whose report to show expanded when the tab opens (the toast's "Show report"). */
    showReport?: string
    /** Open a document in the editor (the modal closes first). */
    onopenpage(concept: string): void
    /** Create a publication page and open it. */
    oncreatepublication(input: NewPublicationInput): Promise<void>
    /** Save a card's edits to the publication page's mapping, fields and includes in one write. */
    onupdatepublication(publication: Publication, changes: PublicationChanges): Promise<void>
    /** The graph's themes, live. */
    subscribeThemes(listener: (themes: GraphTheme[]) => void): () => void
    /** The themes that ship with the app: the identifier a publication writes, and the title a person reads. */
    bundledThemes: { name: string; title: string }[]
    /** Copy the publication's current theme into the graph under a new id, point the publication at it and open the editor. */
    oncustomisetheme(publication: Publication): Promise<void>
    /** Open the Theme editor View for a graph theme (the modal closes first). */
    onopentheme(id: string): void
    /** Add a theme to the graph from a bundled name or a url. */
    onaddtheme(input: { ref: string; id: string; name: string }): Promise<void>
    ondeletetheme(id: string): Promise<void>
    /** The include slots a theme declares, for the include pickers. Null while unknown. */
    includeSlotsOf(themeRef: string): Promise<{ name: string; description: string; kind?: 'html' | 'css' }[] | null>
}
