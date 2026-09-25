import { describe, expect, it } from 'vitest'
import { getActiveDocumentStore, setActiveDocumentStore } from '$lib/document/active-store'
import { getActiveGraphSettings, setActiveGraphSettings } from '$lib/document/active-graph-settings'
import type { DocumentStore } from '$lib/document/types'
import {
    clearWorkspaceServices,
    currentWorkspaceServices,
    publishWorkspaceServices,
    updateWorkspaceServices,
} from './workspace-services'

const health = {
    report: () => {},
    clear: () => {},
    snapshot: () => [],
    subscribe: () => () => {},
}

describe('workspace service bridge', () => {
    it('keeps no-workspace graph settings referentially stable', () => {
        expect(getActiveGraphSettings()).toBe(getActiveGraphSettings())
    })

    it('does not let an old generation clear a newer graph', () => {
        const first = publishWorkspaceServices({
            graphId: 'graph-a',
            health,
        })
        const secondServices = {
            graphId: 'graph-b',
            health,
        }
        const second = publishWorkspaceServices(secondServices)

        clearWorkspaceServices(first)

        expect(currentWorkspaceServices('graph-b')).toBe(secondServices)
        clearWorkspaceServices(second)
        expect(currentWorkspaceServices()).toBeNull()
    })

    it('keeps the service object and narrow compatibility accessors on one source of truth', () => {
        const firstStore = {} as DocumentStore
        const secondStore = {} as DocumentStore
        const generation = publishWorkspaceServices({
            graphId: 'graph-a',
            health,
            store: firstStore,
            settings: { recentDocumentCount: 2 },
        })

        expect(getActiveDocumentStore()).toBe(firstStore)
        expect(getActiveGraphSettings()).toEqual({ recentDocumentCount: 2 })

        setActiveDocumentStore(secondStore)
        setActiveGraphSettings({ recentDocumentCount: 4 })

        expect(currentWorkspaceServices()?.store).toBe(secondStore)
        expect(currentWorkspaceServices()?.settings).toEqual({ recentDocumentCount: 4 })

        updateWorkspaceServices(generation, {
            store: firstStore,
            settings: { recentDocumentCount: 8 },
        })

        expect(getActiveDocumentStore()).toBe(firstStore)
        expect(getActiveGraphSettings()).toEqual({ recentDocumentCount: 8 })

        clearWorkspaceServices(generation)
    })
})
