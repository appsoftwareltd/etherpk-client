/**
 * Generation-tagged bridge for the one open graph's services.
 *
 * Dockview mounts child Svelte roots, so those roots cannot inherit ordinary Svelte
 * context. The bridge publishes the graph-scoped service set as one generation. Older
 * narrow accessors delegate to this object so they remain compatible without creating
 * another mutable source of truth.
 */
import type { PublishEnvironment } from '$lib/document/publish/publish'
import type { PublishSource } from '$lib/document/publish/types'
import type { ReadingPositionStore } from '$lib/navigation/reading-positions'
import type { LockStatus } from '$lib/document/protection/lock-machine'
import type { LayoutController } from '$lib/layout/types'
import type { RemoteGraphIndex } from '$lib/document/index-worker/client'
import type { DocumentStore } from '$lib/document/types'
import type { AssetStore } from '$lib/storage/fs/asset-store'
import type { GraphSettings } from '$lib/storage/fs/graph-settings'
import type { CommandRegistry } from '$lib/surface/command-registry'
import type { ContributionRegistry } from '$lib/surface/contribution-registry'
import type { EventBus } from '$lib/surface/types'
import type { RecentsStore } from '$lib/navigation/recents'
import type { TaskFilterStore } from '$lib/document/task-filter-store'
import type { BacklinksPreferencesStore } from '$lib/document/backlinks-preferences'
import type { Backend, ProposalStep } from '$lib/document/frontmatter/proposal'
import type { DocumentIdentity } from './frontmatter-controller'

export type WorkspaceHealthCode =
    | 'cache-unavailable'
    | 'document-open-failed'
    /** A [[Draft]]'s page could not be created on its first keystroke (ADR 0050). */
    | 'draft-promotion-failed'
    | 'document-seed-failed'
    | 'index-fallback'
    | 'index-refresh-failed'
    | 'mirror-resume-failed'
    | 'sync-degraded'

export interface WorkspaceHealthIssue {
    code: WorkspaceHealthCode
    message: string
    document?: string
}

export interface WorkspaceHealth {
    report(issue: WorkspaceHealthIssue): void
    clear(code: WorkspaceHealthCode, document?: string): void
    snapshot(): readonly WorkspaceHealthIssue[]
    subscribe(listener: (issues: readonly WorkspaceHealthIssue[]) => void): () => void
}

export function createWorkspaceHealth(): WorkspaceHealth {
    const issues = new Map<string, WorkspaceHealthIssue>()
    const listeners = new Set<(issues: readonly WorkspaceHealthIssue[]) => void>()
    const keyFor = (code: WorkspaceHealthCode, document?: string) =>
        `${code}:${document ?? ''}`
    const emit = () => {
        const snapshot = [...issues.values()]
        for (const listener of listeners) listener(snapshot)
    }
    return {
        report(issue) {
            issues.set(keyFor(issue.code, issue.document), issue)
            emit()
        },
        clear(code, document) {
            if (issues.delete(keyFor(code, document))) emit()
        },
        snapshot: () => [...issues.values()],
        subscribe(listener) {
            listeners.add(listener)
            listener([...issues.values()])
            return () => listeners.delete(listener)
        },
    }
}

/**
 * What a surface outside the workspace needs to show and drive the graph's lock: the sidebar's
 * Protected notes control. The two readable fields are runes underneath, so a template that reads
 * them re-renders on a lock transition. Actions only — no key, no record, nothing to leak.
 */
export interface ProtectionControls {
    /** Whether the graph has a Protection Key at all. Reactive. */
    readonly isConfigured: boolean
    /** The lock state. Reactive. */
    readonly status: LockStatus
    /** Discard the key now. Graph-wide: the key is the unit (ADR 0058). */
    lockNow(): void
    /** Open the unlock prompt. */
    requestUnlock(): void
}

/**
 * What the editor needs to treat [[Frontmatter]] as a proposal (ADR 0061): the registry's
 * identity for a document, what its block proposes against it, and the two things an editor
 * reports - an editing episode in the block ended, and the mismatch mark's "Restore".
 */
export interface FrontmatterService {
    readonly backend: Backend
    identityOf(target: string): DocumentIdentity | null
    /** What `blockText` (the block alone) proposes for `target`; empty when it agrees or has none. */
    proposalFor(target: string, blockText: string): ProposalStep[]
    episodeEnded(target: string): void
    restore(target: string): void
}

/**
 * What the editor reports when an editing episode inside a wikilink changed its concept
 * (ADR 0065). The workspace works out whether the old concept still exists elsewhere and,
 * if so, proposes the rename.
 */
export interface WikilinkRenameService {
    edited(target: string, before: string, after: string | null): void
}

/**
 * What a View needs to publish or preview the open graph (ADR 0082): the graph read the way the
 * publisher reads it, and the browser's environment (Mermaid, KaTeX assets, fetch).
 */
export interface PublishingService {
    readSource(): Promise<{ source: PublishSource; unsettled: string[] }>
    environment(): PublishEnvironment
}

export interface WorkspaceServices {
    graphId: string
    health: WorkspaceHealth
    store?: DocumentStore
    assets?: AssetStore
    index?: RemoteGraphIndex
    settings?: GraphSettings
    layout?: LayoutController
    events?: EventBus
    commands?: CommandRegistry
    contributions?: ContributionRegistry
    readingPositions?: ReadingPositionStore
    recents?: RecentsStore
    taskFilter?: TaskFilterStore
    /** The Backlinks View's highlight toggle (remembered) and pin (session only). */
    backlinksPreferences?: BacklinksPreferencesStore
    /**
     * Retitle one open panel. Published by the workspace over whichever presenter is live, so a
     * View never holds a renderer - which is swapped out from under it at the breakpoint.
     */
    retitleView?: (panelId: string, title: string) => void
    /** The graph's lock, for the sidebar. Absent on a graph with no Protection Key. */
    protection?: ProtectionControls
    frontmatter?: FrontmatterService
    wikilinkRename?: WikilinkRenameService
    /** Which backend this graph stores documents on. */
    backend?: Backend
    /** Publishing over the open graph, for the Theme editor's preview. */
    publishing?: PublishingService
}

export type WorkspaceGeneration = number

let nextGeneration = 0
let current: { generation: WorkspaceGeneration; services: WorkspaceServices } | null = null

type OptionalWorkspaceServiceKey = Exclude<keyof WorkspaceServices, 'graphId' | 'health'>

/**
 * Compatibility seam for the established narrow `setActive*` accessors and development
 * harnesses. All setters mutate this one service object; none owns separate module state.
 * Production workspace construction should continue to use generation-checked publish/update.
 */
export function setWorkspaceService<K extends OptionalWorkspaceServiceKey>(
    key: K,
    value: WorkspaceServices[K],
): void {
    if (!current) {
        current = {
            generation: ++nextGeneration,
            services: {
                graphId: 'development-harness',
                health: createWorkspaceHealth(),
            },
        }
    }
    if (value === undefined) {
        delete current.services[key]
        return
    }
    current.services[key] = value
}

/** Read one optional service from the current generation. */
export function workspaceService<K extends OptionalWorkspaceServiceKey>(
    key: K,
): WorkspaceServices[K] {
    return current?.services[key]
}

export function publishWorkspaceServices(
    services: WorkspaceServices,
): WorkspaceGeneration {
    const generation = ++nextGeneration
    current = { generation, services }
    return generation
}

export function updateWorkspaceServices(
    generation: WorkspaceGeneration,
    update: Partial<WorkspaceServices>,
): boolean {
    if (!current || current.generation !== generation) return false
    Object.assign(current.services, update)
    return true
}

export function clearWorkspaceServices(generation: WorkspaceGeneration): void {
    if (!current || current.generation !== generation) return
    current = null
}

export function currentWorkspaceServices(
    expectedGraphId?: string,
): WorkspaceServices | null {
    if (!current) return null
    if (expectedGraphId && current.services.graphId !== expectedGraphId) return null
    return current.services
}
