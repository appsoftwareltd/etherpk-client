<script lang="ts">
    /**
     * dockview validation probe (the step-3 gate).
     *
     * Validates the one unverified assumption before the real adapter is built:
     *  1. three persistent named regions (main + two sidebars) as drop targets,
     *  2. mounting/disposing real Svelte 5 components inside dockview panels,
     *  3. a toJSON()/fromJSON() round-trip that re-mounts components.
     *
     * It uses dockview directly (not the adapter) and exposes an imperative
     * `window.__probe` API that the Playwright test drives and asserts on. The
     * region map mirrors the adapter's recreate-on-demand strategy so the gate
     * validates the exact approach the adapter will take.
     */
    import { onMount, mount as svelteMount, unmount as svelteUnmount } from 'svelte'

    import 'dockview-core/dist/styles/dockview.css'

    import ProbeView from './ProbeView.svelte'
    import { probeCounter } from './probe-counter'

    import type {
        DockviewApi,
        GroupPanelPartInitParameters,
        IContentRenderer,
    } from 'dockview-core'

    type Region = 'main' | 'left-sidebar' | 'right-sidebar'

    let container: HTMLDivElement
    let status = $state('initialising…')

    onMount(() => {
        let api: DockviewApi
        let disposed = false

        ;(async () => {
            const { createDockview } = await import('dockview-core')
            if (disposed) return

            // Region → current dockview group id. Recreated on demand if a region
            // is emptied, so the region is always an addressable, stable target.
            const regionGroupId: Record<Region, string | null> = {
                main: null,
                'left-sidebar': null,
                'right-sidebar': null,
            }

            api = createDockview(container, {
                createComponent: (options): IContentRenderer => {
                    const element = document.createElement('div')
                    element.style.height = '100%'
                    let instance: Record<string, unknown> | null = null
                    return {
                        element,
                        init(params: GroupPanelPartInitParameters) {
                            const label = String(params.params?.label ?? options.id)
                            instance = svelteMount(ProbeView, { target: element, props: { label } })
                        },
                        dispose() {
                            if (instance) svelteUnmount(instance)
                            instance = null
                        },
                    }
                },
            })

            const edgeFor: Record<Region, 'left' | 'right' | undefined> = {
                main: undefined,
                'left-sidebar': 'left',
                'right-sidebar': 'right',
            }

            function ensureRegionGroup(region: Region): string {
                const existingId = regionGroupId[region]
                if (existingId && api.getGroup(existingId)) return existingId
                const direction = edgeFor[region]
                const group = direction ? api.addGroup({ direction }) : api.addGroup()
                regionGroupId[region] = group.id
                return group.id
            }

            function addToRegion(region: Region, id: string): void {
                const groupId = ensureRegionGroup(region)
                api.addPanel({
                    id,
                    component: 'probe',
                    params: { label: `${region}:${id}` },
                    position: { referenceGroup: groupId },
                })
            }

            function regionGroupExists(region: Region): boolean {
                const id = regionGroupId[region]
                return id !== null && api.getGroup(id) !== undefined
            }

            function closeRegion(region: Region): void {
                const id = regionGroupId[region]
                const group = id ? api.getGroup(id) : undefined
                if (!group) return
                for (const panel of [...group.panels]) api.removePanel(panel)
            }

            // Seed the three regions, one panel each.
            addToRegion('main', 'doc-A')
            addToRegion('left-sidebar', 'tree')
            addToRegion('right-sidebar', 'backlinks')

            // Imperative probe surface for Playwright.
            ;(window as unknown as { __probe: unknown }).__probe = {
                groupCount: () => api.groups.length,
                panelCount: () => api.panels.length,
                regionGroupExists,
                mounts: () => probeCounter.mounts,
                disposes: () => probeCounter.disposes,
                addToRegion,
                closeRegion,
                toJSON: () => api.toJSON(),
                fromJSON: (data: Parameters<DockviewApi['fromJSON']>[0]) => api.fromJSON(data),
                clear: () => api.clear(),
            }

            status = 'ready'
            container.setAttribute('data-probe-ready', 'true')
        })()

        return () => {
            disposed = true
            api?.dispose()
        }
    })
</script>

<svelte:head><title>dockview probe</title></svelte:head>

<h1 data-testid="probe-status">{status}</h1>
<div bind:this={container} data-testid="probe-container" style="position:absolute; inset:3rem 0 0 0;"></div>
