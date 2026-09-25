<script lang="ts">
    /**
     * The [[Demo Graph]] entry point (ADR 0069): seed if needed, then open the workspace.
     *
     * Idempotent: a revisit reopens the demo that is already here. `?reset=1` asks for a
     * rebuild, and asks rather than acts, because a URL that destroys something on load is a
     * bookmark waiting to go wrong. Everything runs client-side (OPFS, IndexedDB), which is why
     * this is a page and not a server redirect, like the root resolver.
     */
    import { onMount } from "svelte";

    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import manifest from "virtual:demo-graph";
    import { tryClaimLock } from "$lib/cross-tab-lock";
    import { DEMO_GRAPH_ID, openDemoGraph } from "$lib/demo/demo-graph";
    import { fetchDemoBundle, type SeedProgress } from "$lib/demo/seed";
    import { todayISO } from "$lib/document/calendar/month-grid-core";
    import { formatBytes } from "$lib/format-bytes";
    import { createIdbGraphRegistry, createWebFsDirectoryAdapter, getOpfsRoot } from "$lib/storage";

    type Phase =
        | { kind: "confirm-reset" }
        | { kind: "working"; reset: boolean; progress: SeedProgress | null }
        | { kind: "held"; reset: boolean }
        | { kind: "error"; reset: boolean; message: string };

    let phase = $state<Phase>({ kind: "working", reset: false, progress: null });

    async function run(reset: boolean) {
        phase = { kind: "working", reset, progress: null };
        try {
            const outcome = await openDemoGraph(
                {
                    registry: createIdbGraphRegistry(),
                    opfsRoot: getOpfsRoot,
                    adapterFor: createWebFsDirectoryAdapter,
                    manifest,
                    files: (m) => fetchDemoBundle(m),
                    today: () => todayISO(),
                    now: () => Date.now(),
                    claimLock: tryClaimLock,
                },
                {
                    reset,
                    onProgress: (progress) => {
                        if (phase.kind === "working") phase = { ...phase, progress };
                    },
                },
            );
            if (outcome.kind === "held") {
                phase = { kind: "held", reset };
                return;
            }
            await goto(`/g/${DEMO_GRAPH_ID}`, { replaceState: true });
        } catch (err) {
            phase = { kind: "error", reset, message: (err as Error).message };
        }
    }

    onMount(() => {
        if (page.url.searchParams.get("reset") === "1") {
            phase = { kind: "confirm-reset" };
            return;
        }
        void run(false);
    });
</script>

<svelte:head><title>Demo · EtherPK</title></svelte:head>

<div class="notice" data-testid="demo-page">
    {#if phase.kind === "confirm-reset"}
        <h1 class="text-lg font-semibold text-gray-950 dark:text-white">Reset the demo?</h1>
        <p class="max-w-md text-sm text-gray-600 dark:text-gray-400">
            Every page goes back to how it shipped and anything you wrote or uploaded in the demo is discarded.
        </p>
        <div class="flex flex-wrap justify-center gap-2">
            <button type="button" data-testid="demo-reset-confirm" onclick={() => void run(true)} class="primary">Reset demo</button>
            <button type="button" data-testid="demo-reset-keep" onclick={() => void run(false)} class="secondary">Keep my changes</button>
        </div>
    {:else if phase.kind === "working"}
        <p data-testid="demo-working" role="status">
            {phase.reset ? "Resetting the demo…" : "Preparing the demo…"}
            {#if phase.progress}
                <span class="block text-sm text-gray-500 dark:text-gray-400" data-testid="demo-progress">
                    {formatBytes(phase.progress.loadedBytes)} of {formatBytes(phase.progress.totalBytes)}
                </span>
            {/if}
        </p>
    {:else if phase.kind === "held"}
        <h1 class="text-lg font-semibold text-gray-950 dark:text-white">The demo is open in another tab</h1>
        <p class="max-w-md text-sm text-gray-600 dark:text-gray-400" data-testid="demo-held">
            Close the demo in your other tabs first, then try again. Nothing has been changed.
        </p>
        <div class="flex flex-wrap justify-center gap-2">
            <button type="button" data-testid="demo-retry" onclick={() => void run(phase.kind === "held" && phase.reset)} class="primary">Try again</button>
            <a href="/graphs" class="secondary">Go to graphs</a>
        </div>
    {:else}
        <h1 class="text-lg font-semibold text-gray-950 dark:text-white">The demo could not be prepared</h1>
        <p class="max-w-md text-sm text-red-600" data-testid="demo-error">{phase.message}</p>
        <div class="flex flex-wrap justify-center gap-2">
            <button type="button" data-testid="demo-retry" onclick={() => void run(phase.kind === "error" && phase.reset)} class="primary">Try again</button>
            <a href="/graphs" class="secondary">Go to graphs</a>
        </div>
    {/if}
</div>

<style>
    .notice {
        position: fixed;
        inset: 3.5rem 0 0 0;
        display: grid;
        place-content: center;
        justify-items: center;
        gap: 0.75rem;
        padding: 1rem;
        text-align: center;
        color: var(--gk-text-default);
    }
    .primary,
    .secondary {
        border-radius: 0.5rem;
        padding: 0.4rem 0.9rem;
        font: inherit;
        font-size: 0.875rem;
        font-weight: 500;
        cursor: pointer;
    }
    .primary {
        border: 1px solid transparent;
        background: var(--gk-text-default);
        color: var(--gk-surface-1);
    }
    .secondary {
        border: 1px solid var(--gk-border-soft);
        background: var(--gk-surface-1);
        color: inherit;
        text-decoration: none;
    }
</style>
