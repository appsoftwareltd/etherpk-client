<script lang="ts">
    // A trivial View used only by the dockview validation probe. It increments a
    // module-level counter on mount and destroy so the probe can verify that
    // Svelte 5 components mount and dispose cleanly inside dockview panels.
    import { onDestroy, onMount } from 'svelte'

    import { probeCounter } from './probe-counter'

    let { label }: { label: string } = $props()

    onMount(() => {
        probeCounter.mounts += 1
    })
    onDestroy(() => {
        probeCounter.disposes += 1
    })
</script>

<div data-testid="probe-view" class="probe-view">{label}</div>

<style>
    .probe-view {
        padding: 0.5rem;
        font:
            13px/1.4 system-ui,
            sans-serif;
    }
</style>
