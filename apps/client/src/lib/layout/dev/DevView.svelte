<script lang="ts">
    /**
     * The dev harness's universal fake View. The real app registers one
     * component per kind (DocumentView, BacklinksView, …); the harness registers
     * every kind to this single DevView so the whole Layout can be exercised with
     * no real documents or data.
     *
     * It renders its {@link ViewRef} key, the mount ordinal (the singleton test
     * oracle), and a text input whose value proves per-View state survives splits
     * and drags but is destroyed on close.
     */
    import { onDestroy, onMount } from 'svelte'

    import type { ViewRef } from '$lib/layout'

    import { registerDevViewDispose, registerDevViewMount } from './dev-view-state.svelte'

    let { view }: { view: ViewRef } = $props()

    let mountIndex = $state(0)
    let text = $state('')

    const key = $derived(`${view.kind}:${view.target}`)

    onMount(() => {
        mountIndex = registerDevViewMount()
    })
    onDestroy(() => {
        registerDevViewDispose()
    })
</script>

<div class="dev-view" data-testid="devview" data-view-key={key}>
    <div class="dev-view__key" data-testid="devview-key">{key}</div>
    <div class="dev-view__mounts" data-testid="devview-mount-index">mounts: {mountIndex}</div>
    <input
        class="dev-view__input"
        data-testid="devview-input"
        bind:value={text}
        placeholder="type to test state"
    />
</div>

<style>
    .dev-view {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.75rem;
        height: 100%;
        font:
            13px/1.4 system-ui,
            sans-serif;
        color: var(--gk-text-default, #111);
    }
    .dev-view__key {
        font-weight: 600;
    }
    .dev-view__mounts {
        opacity: 0.7;
        font-variant-numeric: tabular-nums;
    }
    .dev-view__input {
        border: 1px solid var(--gk-border-soft, #ccc);
        border-radius: 4px;
        padding: 0.25rem 0.5rem;
        background: transparent;
        color: inherit;
    }
</style>
