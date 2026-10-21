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

/** A [[Publish Repository]] as the tab shows it (ADR 0152). */
export interface PublicationRepositoryState {
    owner: string
    name: string
    branch: string
    /** When the token last proved it can write there. */
    checkedAt?: string
    publishedAt?: string
    /** The last publish's commit. */
    commitUrl?: string
}

/** Where a publication publishes on this device: one folder or one repository, never both. */
export type PublicationDestinationState = ({ kind: 'folder' } & PublicationFolderState) | ({ kind: 'repository' } & PublicationRepositoryState)

export type PublishTarget = 'folder' | 'zip' | 'repository'

export interface PublishOutcome {
    report: PublishReport
    /** Where it went. */
    target: PublishTarget
    written?: { written: number; unchanged: number; deleted: string[] }
    /** For a repository: the branch, and the commit made, or null when nothing had changed. */
    repository?: { owner: string; name: string; branch: string }
    commit?: { sha: string; url: string } | null
}

/**
 * What pressing Publish came to. A first publish to a repository branch that does not say it
 * holds this site stops before replacing files there, and the tab asks (ADR 0152).
 */
export type PublishAttempt = { state: 'published'; outcome: PublishOutcome } | { state: 'needs-confirmation'; replaced: string[] }

/** What the repository check found, or `unchecked` when no GitHub token is set to check with. */
export type RepositoryCheckState = 'ready' | 'empty' | 'branch-missing' | 'unchecked'

/** The person's GitHub token, as far as the tab may know it: whether there is one, never its value. */
export interface GitHubTokenState {
    set: boolean
    /** True when the person's settings sync to their account, so the token follows them to other devices. */
    follows: boolean
}

export interface PublishTabProps {
    /** Whether this browser can write a folder (the File System Access API). A zip is always offered. */
    folderSupported: boolean
    /** Read the graph for its publications. Slow on a large graph; called when the tab opens and after a change. */
    load(): Promise<GraphPublishingState>
    /** Where a publication publishes on this device, or null. */
    destinationOf(publicationId: string): Promise<PublicationDestinationState | null>
    /** Pick a folder for a publication (a native dialog; needs the click) and remember it in place of any repository. Null when cancelled. */
    onchoosefolder(publicationId: string): Promise<PublicationFolderState | null>
    /** Forget where the publication publishes on this device. */
    onforgetdestination(publicationId: string): Promise<void>
    /**
     * Remember a repository for the publication in place of any folder, then check it with the
     * person's GitHub token. A refusal throws a `GitHubError` worded for the person; the
     * repository is remembered either way.
     */
    onsaverepository(publicationId: string, repository: { owner: string; name: string; branch: string }): Promise<RepositoryCheckState>
    /** Start the remembered repository's branch holding the publication's README (the person asked: a publish never does). */
    oncreatebranch(publication: Publication): Promise<RepositoryCheckState>
    /** The person's GitHub token, live: whether one is set. */
    githubToken: {
        read(): GitHubTokenState
        save(token: string): void
        forget(): void
        subscribe(listener: () => void): () => void
    }
    /**
     * Publish to the remembered folder or repository, or as a zip download. Progress is reported
     * through the Activity rail. `confirmed` is the person's go-ahead to replace files a first
     * publish to a repository listed.
     */
    onpublish(publication: Publication, target: PublishTarget, options?: { confirmed?: boolean }): Promise<PublishAttempt>
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
