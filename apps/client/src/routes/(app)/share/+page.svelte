<script lang="ts">
    /**
     * The [[Share Target]]'s one page (CONTEXT.md; ADR 0087, amended 2026-09-21): what arrived
     * from the share sheet, shown exactly as it will be captured, and the graph to put it in.
     *
     * Choosing a synced graph writes the [[Quick Note]] from here when this device can do so
     * without asking anything (share-landing.ts): the vault is unlocked here and the keyring is
     * held, so a short engine session appends the note and the page says how far it got -
     * saved on this device, then synced once the relay acknowledges it. Nothing else opens, so
     * on a phone the user is back in the app they shared from in a moment. Otherwise - a folder
     * graph, a locked vault, no sync configured, any failure before the note is saved - the
     * text is stashed and the page navigates to `/g/<id>`, replacing this entry so Back leaves
     * the app rather than re-running the share; the workspace adds the note once the graph is
     * open, with its unlock prompt, folder permission button and every open notice reused.
     *
     * With one graph there is nothing to pick and it goes straight in. With none, the text stays
     * on screen with Copy and a link to the Graphs page: a share is never dropped on the floor.
     * Reached with no query and a share still waiting (a graph that would not open sent the user
     * back here), the picker is shown over that share again.
     */
    import { onMount } from "svelte";

    import { afterNavigate, goto } from "$app/navigation";
    import { isDemoGraph } from "$lib/demo/demo-graph";
    import { MAX_QUICK_NOTE_LENGTH } from "$lib/document/quick-notes";
    import { landShareDirectly } from "$lib/document/share-landing";
    import {
        composeSharedNote,
        orderShareTargets,
        peekPendingShare,
        stashPendingShare,
    } from "$lib/document/share-target";
    import { createIdbGraphRegistry, getLastGraphId, type GraphRecord } from "$lib/storage";

    import type { PageData } from "./$types";

    let { data }: { data: PageData } = $props();

    interface Share {
        text: string;
        truncated: boolean;
        /** The instant it was shared: taken on arrival, kept however long it waits. */
        createdAt: number;
    }

    /**
     * What is on the URL, composed from the first render, so the server-rendered page already
     * shows the share rather than a flash of "nothing" before hydration.
     */
    function arrivedShare(): Share | null {
        const arrived = composeSharedNote(data);
        return arrived ? { ...arrived, createdAt: Date.now() } : null;
    }

    let share = $state<Share | null>(arrivedShare());
    /**
     * The browser has looked for a waiting share (sessionStorage, which the server cannot see).
     * "Nothing was shared" is said only after that, or a share sent back here by a graph that
     * would not open would flash as nothing before hydration found it.
     */
    let settled = $state(false);
    /** Null until the registry has been read, so "no graphs" is never said too early. */
    let graphs = $state.raw<GraphRecord[] | null>(null);
    let registryError = $state("");
    let choosing = $state<string | null>(null);
    /**
     * The direct write's progress for the chosen synced graph. `adding` until the engine has
     * the note in its durable outbox, `saved` from then until the relay acknowledges it,
     * `synced` after, or `unsynced` when the relay could not be reached or went quiet: the
     * note is on this device either way and ships the next time the graph opens here.
     */
    let landing = $state<{ graph: GraphRecord; state: "adding" | "saved" | "synced" | "unsynced" } | null>(null);
    /** Ends the direct write's wait for the relay early, when the user opens the graph instead. */
    let cancelSyncWait: AbortController | null = null;
    /** The direct write in flight, awaited by Open graph so its engine is disposed before the workspace's is built. */
    let landingDone: Promise<void> = Promise.resolve();
    /** The graph a hand-off is opening, while this page is still on screen. */
    const opening = $derived(landing ? null : (graphs?.find((g) => g.id === choosing) ?? null));
    /**
     * The page's title follows the state: while nothing is known it names the action, and once
     * the direct write has the note it says so, because a page still headed "Add to Quick notes"
     * over a note that was already added read as if something was still to do.
     */
    const heading = $derived.by(() => {
        if (graphs !== null && graphs.length === 0) return "No graphs on this device";
        if (!landing) return "Add to Quick notes";
        return landing.state === "adding" ? "Adding to Quick notes" : "Quick note added";
    });
    /** A copied clipboard is invisible, so Copy confirms itself in words beside the button. */
    let copied = $state(false);
    let copyError = $state("");

    const backendTag = (graph: GraphRecord) =>
        isDemoGraph(graph.id) ? "Demo" : graph.backend === "server" ? "Synced" : "Local";

    /**
     * A share arriving on the URL replaces whatever this page was showing; with nothing on the
     * URL, a share still waiting from an earlier choice is shown again. `afterNavigate` rather
     * than mount because a second share can arrive while the picker is up: the same route with
     * new params, and the component stays mounted.
     */
    afterNavigate(() => {
        const arrived = arrivedShare();
        if (arrived) {
            share = arrived;
        } else {
            const waiting = peekPendingShare();
            share = waiting ? { text: waiting.text, truncated: waiting.truncated, createdAt: waiting.createdAt } : null;
        }
        settled = true;
        straightIn();
    });

    onMount(() => {
        let cancelled = false;
        (async () => {
            try {
                const listed = await createIdbGraphRegistry().listGraphs();
                if (cancelled) return;
                graphs = orderShareTargets(listed, { lastGraphId: getLastGraphId(), isDemo: isDemoGraph });
                straightIn();
            } catch (err) {
                if (cancelled) return;
                // Read failed is not "none": the copy must not send someone to make a new graph
                // when theirs are all still there.
                registryError = `Your graphs could not be read from this browser's storage. Nothing has been deleted. (${(err as Error).message})`;
            }
        })();
        return () => {
            cancelled = true;
        };
    });

    /**
     * One graph: nothing to pick. The share and the registry arrive in either order, so both
     * arrivals ask; the first to find the other goes.
     */
    function straightIn() {
        if (share && graphs?.length === 1) choose(graphs[0]);
    }

    function choose(graph: GraphRecord) {
        if (!share || choosing !== null) return;
        choosing = graph.id;
        void land(graph, share);
    }

    /**
     * Try the direct write; hand over to the workspace when it declines. The note's id is
     * minted here, so a retry after a failure cannot add it twice through the same session.
     */
    function land(graph: GraphRecord, chosen: Share) {
        landingDone = landNow(graph, chosen);
        return landingDone;
    }

    async function landNow(graph: GraphRecord, chosen: Share) {
        const note = { id: crypto.randomUUID(), text: chosen.text, createdAt: chosen.createdAt };
        landing = { graph, state: "adding" };
        cancelSyncWait = new AbortController();
        const outcome = await landShareDirectly(graph, note, undefined, {
            signal: cancelSyncWait.signal,
            onSaved: () => {
                if (landing?.graph.id === graph.id) landing = { graph, state: "saved" };
            },
        });
        cancelSyncWait = null;
        if (outcome.kind === "added") {
            landing = { graph, state: outcome.synced ? "synced" : "unsynced" };
            return;
        }
        if (outcome.reason === "failed") console.warn("[share] direct write declined; opening the graph instead", outcome.error);
        landing = null;
        stashPendingShare({ graphId: graph.id, text: chosen.text, createdAt: chosen.createdAt, truncated: chosen.truncated });
        void goto(`/g/${graph.id}`, { replaceState: true });
    }

    async function copy() {
        if (!share) return;
        copyError = "";
        copied = false;
        try {
            await navigator.clipboard.writeText(share.text);
            copied = true;
        } catch {
            copyError = "Could not copy: the browser refused clipboard access. Select the text above and copy it by hand.";
        }
    }

    /**
     * Open the graph the note went to. The direct write's session is ended first - the wait for
     * the relay is cancelled and its engine disposed - so the workspace never builds a second
     * engine over the same cache while the first is still up. A note already saved is in the
     * outbox either way, and the workspace's engine ships it.
     */
    async function openGraph(graph: GraphRecord) {
        cancelSyncWait?.abort();
        await landingDone;
        await goto(`/g/${graph.id}`);
    }

    /** The last-opened graph is listed first; the caret lands on it so Enter is enough. */
    function focusFirst(node: HTMLElement) {
        node.focus();
    }
</script>

<svelte:head><title>{heading} - EtherPK</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-6 px-4 py-8" data-testid="share-target">
    {#if !share}
        {#if settled}
            <header>
                <h1 class="text-2xl font-semibold text-gray-950 dark:text-white">Nothing was shared</h1>
                <p class="mt-2 text-sm text-gray-500 dark:text-gray-400" data-testid="share-nothing">
                    Share text or a link to EtherPK from another app and it lands here, ready to go
                    into a graph's quick notes. There is nothing waiting at the moment.
                </p>
            </header>
            <a
                href="/graphs"
                class="inline-block rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-white/5"
                >Go to graphs</a
            >
        {/if}
    {:else}
        <header>
            <h1 class="text-2xl font-semibold text-gray-950 dark:text-white">{heading}</h1>
            <!-- One line under the title that says what is true now. A live region once a write
                 is under way, so the three states are announced as they arrive. -->
            <p
                class="mt-2 text-sm text-gray-500 dark:text-gray-400"
                data-testid="share-landing-status"
                role={landing ? "status" : undefined}
            >
                {#if graphs !== null && graphs.length === 0}
                    Quick notes live with a graph, and this device has none yet. Copy the text for now,
                    or open a graph from the Graphs page and share again.
                {:else if landing?.state === "adding"}
                    Saving what you shared to {landing.graph.name} on this device…
                {:else if landing?.state === "saved"}
                    Saved to {landing.graph.name} on this device. Syncing…
                {:else if landing?.state === "synced"}
                    Saved to {landing.graph.name} and synced: it is in the graph's Quick notes on every
                    device.
                {:else if landing?.state === "unsynced"}
                    Saved to {landing.graph.name} on this device. The sync server could not be reached,
                    so it will sync the next time this graph opens here.
                {:else if opening}
                    This is what will be captured. Opening {opening.name}, where it goes into Quick
                    notes; you can move it into your journal from there later.
                {:else if graphs === null}
                    This is what will be captured.
                {:else}
                    This is what will be captured. Choose the graph whose quick notes it goes to; you
                    can move it into your journal from there later.
                {/if}
            </p>
        </header>

        <section class="space-y-2">
            {#if share.truncated}
                <p class="text-sm text-amber-700 dark:text-amber-400" data-testid="share-truncated" role="status">
                    Cut to the first {MAX_QUICK_NOTE_LENGTH.toLocaleString()} characters.
                </p>
            {/if}
            <!-- Verbatim, wrapped, scrolling past a screenful: a share of an article stays readable
                 without pushing the graph list off the bottom. -->
            <pre
                data-testid="share-preview"
                class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-900 dark:border-white/10 dark:bg-white/5 dark:text-gray-100"
                style:font-family="var(--gk-sans, 'Inter', system-ui, sans-serif)">{share.text}</pre>
        </section>

        {#if landing}
            <!-- The title and status line above say how far the write got; this is the one
                 thing to do next. A button rather than a link: it ends the write's session
                 before the workspace opens over the same cache. -->
            <div data-testid="share-landing" data-state={landing.state}>
                <button
                    type="button"
                    data-testid="share-open-graph"
                    onclick={() => void openGraph(landing!.graph)}
                    class="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-white/5"
                    >Open graph</button
                >
            </div>
        {:else if registryError}
            <p role="alert" class="text-sm text-red-600" data-testid="share-registry-error">{registryError}</p>
        {:else if graphs === null}
            <!-- The registry is IndexedDB, read in a moment; nothing said until it is, so a list
                 cannot flash in over an empty state. -->
        {:else if graphs.length === 0}
            <div class="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    data-testid="share-copy"
                    onclick={copy}
                    class="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
                    >Copy text</button
                >
                <a
                    href="/graphs"
                    data-testid="share-graphs-link"
                    class="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-white/5"
                    >Go to graphs</a
                >
                {#if copied}
                    <span role="status" data-testid="share-copied" class="text-sm text-gray-500 dark:text-gray-400">Copied</span>
                {/if}
                {#if copyError}
                    <p role="alert" class="w-full text-sm text-red-600">{copyError}</p>
                {/if}
            </div>
        {:else if graphs.length > 1}
            <section class="space-y-3" aria-labelledby="share-choose">
                <h2 id="share-choose" class="text-lg font-semibold text-gray-950 dark:text-white">Choose a graph</h2>
                <ul
                    data-testid="share-graphs"
                    class="divide-y divide-gray-200 overflow-hidden rounded-xl border border-gray-200 dark:divide-white/10 dark:border-white/10"
                >
                    {#each graphs as graph, index (graph.id)}
                        <li>
                            <button
                                type="button"
                                data-testid="share-graph"
                                data-graph-id={graph.id}
                                {@attach index === 0 && focusFirst}
                                onclick={() => choose(graph)}
                                disabled={choosing !== null}
                                aria-busy={choosing === graph.id}
                                class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-gray-950 disabled:cursor-progress disabled:opacity-70 dark:hover:bg-white/5 dark:focus-visible:bg-white/5 dark:focus-visible:ring-white"
                            >
                                <span class="min-w-0 flex-1 truncate text-sm font-medium text-gray-950 dark:text-white"
                                    >{graph.name}</span
                                >
                                <span
                                    class="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-sm text-gray-600 dark:bg-white/10 dark:text-gray-400"
                                    data-testid="share-graph-tag">{backendTag(graph)}</span
                                >
                            </button>
                        </li>
                    {/each}
                </ul>
            </section>
        {:else}
            <!-- One graph: `choose` is already on its way, and the header takes over the moment
                 the direct write starts; this line covers the hand-off's navigation. -->
            <p class="text-sm text-gray-500 dark:text-gray-400" role="status" data-testid="share-opening">
                Opening {graphs[0].name}…
            </p>
        {/if}
    {/if}
</div>
