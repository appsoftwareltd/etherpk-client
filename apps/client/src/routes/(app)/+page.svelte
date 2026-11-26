<script lang="ts">
    /**
     * The root (`/`) resolver: resume work rather than land on marketing.
     * Runs entirely client-side (the registry is IndexedDB, the pointer is
     * localStorage), which is why this is a page and not a server redirect.
     * The branching itself is the pure `resolveGraphTarget`:
     *
     *   no graphs                                     → the public /home page
     *   unset-or-stale pointer among many             → the /graphs picker
     *   exactly one graph / valid pointer             → open that graph
     *
     * `rootDestination` then turns the target into an address: an installed app's launch marker
     * and icon shortcuts (`?shortcut=today`) are read here and never carried on.
     *
     * The public home stays addressable at `/home`; nothing here is a one-way door.
     *
     * Redirects replace history so Back never lands the user on this transient
     * page (which would just re-resolve and bounce forward again).
     */
    import { onMount } from 'svelte'

    import { goto } from '$app/navigation'
    import { isNativeApp } from '#lib/native/bridge.js'
    import { openedByLaunch } from '#lib/native/first-launch.js'
    import { todayISO } from '#lib/document/calendar/month-grid-core.js'
    import { chosenGraphState } from '#lib/workspace/chosen-graph.js'
    import { createIdbGraphRegistry, getLastGraphId, resolveGraphTarget, rootDestination } from '#lib/storage/index.js'

    let message = $state('')

    onMount(() => {
        let cancelled = false
        ;(async () => {
            try {
                // A Native App opened with a link, a share, a file or a folder goes there instead.
                if (await openedByLaunch()) return
                const graphs = await createIdbGraphRegistry().listGraphs()
                if (cancelled) return
                const target = resolveGraphTarget(graphs, getLastGraphId())
                // Today is read at the moment of the launch: an installed app is opened days apart.
                // The graph resumed is carried with the entry: its address may be two folders' (chosen-graph.ts).
                await goto(rootDestination(target, window.location.search, () => todayISO(), { installedApp: isNativeApp() }), {
                    replace: true,
                    state: target.kind === 'open' ? chosenGraphState(target.graph) : {},
                })
            } catch (err) {
                message = (err as Error).message
            }
        })()
        return () => {
            cancelled = true
        }
    })
</script>

<svelte:head><title>EtherPK — opening…</title></svelte:head>

{#if message}
    <div class="notice" data-testid="root-resolve-error">
        <p>Could not open your graphs: {message}</p>
        <button class="gk-button justify-self-center" onclick={() => goto('/graphs')}>Go to graphs</button>
    </div>
{:else}
    <div class="notice" data-testid="root-resolving"><p>Opening your notes…</p></div>
{/if}

<style>
    .notice {
        position: fixed;
        inset: 3.5rem 0 0 0;
        display: grid;
        place-content: center;
        gap: 0.75rem;
        text-align: center;
        color: var(--gk-text-default);
    }
</style>
