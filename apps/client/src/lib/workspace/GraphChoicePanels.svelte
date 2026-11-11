<script lang="ts">
    /**
     * The Graphs page for a browser that holds no graph of its own: one sentence saying what a
     * graph is, a panel for each kind of graph, and a line beneath for people who came with notes
     * or only to look. What each panel says and does is decided in `graph-choice-panels.ts`; this
     * component draws that answer and hands a pressed button's action back to the page.
     *
     * While the page cannot yet tell a first visit from a returning one (`panels` is null) it draws
     * the same boxes empty, so nothing moves when the answer arrives.
     */
    import { PUBLIC_DOCS_URL } from "@appsoftwareltd/etherpk-shared";
    import {
        ALL_GRAPHS_GET,
        type ChoiceButton,
        type GraphChoiceAction,
        type GraphChoicePanels,
    } from "./graph-choice-panels.js";

    let {
        panels,
        demoAvailable,
        creating = false,
        onaction,
        onimport,
    }: {
        /** Null while the page is still finding out what this browser and its accounts hold. */
        panels: GraphChoicePanels | null;
        /** The demo is not in this browser yet, so the line beneath offers it. */
        demoAvailable: boolean;
        /** A press on the synced panel's button is waiting on the account checks. */
        creating?: boolean;
        onaction: (action: GraphChoiceAction) => void;
        onimport: () => void;
    } = $props();

    /**
     * Side by side, the two panels share five rows (heading, sub-line, points, help line, buttons)
     * through a subgrid, so each row starts at the same height in both whatever the other rows
     * hold: the help lines line up, and so do the buttons. Stacked on a narrow screen a panel is
     * a plain column.
     */
    const PANEL =
        "flex flex-col rounded-xl border p-5 md:row-span-5 md:grid md:grid-rows-subgrid md:gap-y-0";
    const FOCUS =
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--gk-accent)";
    const PRIMARY = `inline-flex min-h-9 items-center justify-center rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 pointer-coarse:min-h-11 aria-busy:cursor-progress dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200 ${FOCUS}`;
    const SECONDARY = `inline-flex min-h-9 items-center justify-center rounded-lg border border-neutral-300 px-4 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 pointer-coarse:min-h-11 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-white/5 ${FOCUS}`;
    /**
     * A link in a sentence. On a touch screen it becomes a row of its own beneath the words that
     * lead to it, tall enough to press; the punctuation that joined it to the sentence is hidden
     * there (`JOIN`).
     */
    const TEXT_LINK = `text-left font-medium text-neutral-800 underline underline-offset-2 hover:text-neutral-950 pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:items-center dark:text-neutral-100 dark:hover:text-white ${FOCUS}`;
    const JOIN = "pointer-coarse:hidden";
    const CHECK_ICON = "M4.5 12.75l6 6 9-13.5";
</script>

{#snippet choiceButton(button: ChoiceButton, style: string, testid: string, busy: boolean)}
    {#if button.action.kind === "link"}
        <!-- The account site is another origin. -->
        <a href={button.action.href} data-testid={testid} data-sveltekit-reload class={style}
            >{button.label}</a
        >
    {:else}
        <button
            type="button"
            data-testid={testid}
            aria-busy={busy}
            onclick={() => onaction(button.action)}
            class={style}>{button.label}</button
        >
    {/if}
{/snippet}

{#snippet bulletList(bullets: readonly string[], muted: boolean)}
    <ul
        class="mt-3 space-y-2 text-sm {muted
            ? 'text-neutral-600 dark:text-neutral-400'
            : 'text-neutral-700 dark:text-neutral-300'}"
    >
        {#each bullets as bullet (bullet)}
            <li class="flex gap-2">
                <svg
                    class="mt-0.5 h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    aria-hidden="true"
                >
                    <path stroke-linecap="round" stroke-linejoin="round" d={CHECK_ICON} />
                </svg>
                <span>{bullet}</span>
            </li>
        {/each}
    </ul>
{/snippet}

{#snippet localPanel(local: GraphChoicePanels["local"])}
    <!-- Where the browser cannot open a folder the panel stays, so the choice is known to exist,
         but it offers nothing to press: its reason is text, in full contrast. -->
    <section
        data-testid="graph-choice-local"
        data-available={local.available}
        aria-labelledby="graph-choice-local-heading"
        class="{PANEL} {local.available
            ? 'border-neutral-200 bg-white dark:border-white/10 dark:bg-white/5'
            : 'border-dashed border-neutral-300 bg-neutral-50 dark:border-white/15 dark:bg-transparent'}"
    >
        <h2
            id="graph-choice-local-heading"
            class="text-lg font-semibold {local.available
                ? 'text-neutral-950 dark:text-white'
                : 'text-neutral-600 dark:text-neutral-400'}"
        >
            Create a Local Graph
        </h2>
        <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            A folder on this device.
        </p>
        {@render bulletList(local.bullets, !local.available)}
        <div data-testid="graph-choice-local-help" class="mt-5">
            {#if local.available}
                <p
                    data-testid="graph-choice-local-hint"
                    class="text-sm text-neutral-700 dark:text-neutral-300"
                >
                    {local.help}
                </p>
            {:else}
                <p
                    data-testid="graph-choice-local-unavailable"
                    class="text-sm font-medium text-neutral-800 dark:text-neutral-200"
                >
                    {local.help}
                </p>
            {/if}
        </div>
        <!-- With no button the row still holds its place beside the Synced panel's buttons; stacked
             on a narrow screen it takes no room. -->
        <div data-testid="graph-choice-local-actions" class={local.button ? "mt-3" : "md:mt-3"}>
            {#if local.button}
                {@render choiceButton(local.button, PRIMARY, "graphs-open-folder", false)}
            {/if}
        </div>
    </section>
{/snippet}

{#snippet syncedPanel(synced: GraphChoicePanels["synced"])}
    <section
        data-testid="graph-choice-synced"
        aria-labelledby="graph-choice-synced-heading"
        class="{PANEL} border-neutral-200 bg-white dark:border-white/10 dark:bg-white/5"
    >
        <h2
            id="graph-choice-synced-heading"
            class="text-lg font-semibold text-neutral-950 dark:text-white"
        >
            Create a Synced Graph
        </h2>
        <p
            data-testid="graph-choice-synced-stored"
            class="mt-1 text-sm text-neutral-600 dark:text-neutral-400"
        >
            {synced.storedBy}
        </p>
        {@render bulletList(synced.bullets, false)}
        <!-- The plan, or why the button cannot open the naming dialog now. Empty when neither
             applies; the row keeps its place beside the Local panel's line. -->
        <div data-testid="graph-choice-synced-help" class="mt-5">
            {#if synced.plan}
                <p
                    data-testid="graph-choice-synced-plan"
                    class="text-sm text-neutral-700 dark:text-neutral-300"
                >
                    {synced.plan.text}
                    {#if synced.plan.pricingUrl}
                        <a
                            href={synced.plan.pricingUrl}
                            data-testid="graph-choice-pricing"
                            data-sveltekit-reload
                            class={TEXT_LINK}>See Sync+ pricing</a
                        >
                    {/if}
                </p>
            {:else if synced.reason}
                <p
                    data-testid="graph-choice-synced-reason"
                    class="text-sm text-neutral-700 dark:text-neutral-300"
                >
                    {synced.reason}
                </p>
            {/if}
        </div>
        <div data-testid="graph-choice-synced-actions" class="mt-3 flex flex-wrap content-start gap-2">
            {@render choiceButton(synced.primary, PRIMARY, "graphs-create-server", creating)}
            {#if synced.secondary}
                {@render choiceButton(synced.secondary, SECONDARY, "graph-choice-sign-in", false)}
            {/if}
        </div>
    </section>
{/snippet}

{#if panels}
    <div data-testid="graphs-first-run" class="space-y-4">
        <p data-testid="first-run-summary" class="text-sm text-neutral-700 dark:text-neutral-300">
            A graph is a collection of notes that link to each other.
        </p>
        <div data-testid="graph-choice-panels" class="grid gap-4 md:grid-cols-2 md:gap-y-0">
            {#each panels.order as kind (kind)}
                {#if kind === "local"}
                    {@render localPanel(panels.local)}
                {:else}
                    {@render syncedPanel(panels.synced)}
                {/if}
            {/each}
        </div>
        <div class="space-y-1 text-sm text-neutral-600 dark:text-neutral-400">
            <p data-testid="first-run-other-ways">
                <span class="pointer-coarse:block">
                    Already have notes?
                    <button
                        type="button"
                        data-testid="graphs-import"
                        onclick={onimport}
                        class={TEXT_LINK}>Import from Logseq, Obsidian or AS Notes</button
                    ><span class={JOIN}>.</span>
                </span>
                {#if demoAvailable}
                    <span class="pointer-coarse:block">
                        Just looking?
                        <a href="/demo" data-testid="graphs-try-demo" class={TEXT_LINK}>Try the demo</a
                        ><span class={JOIN}>.</span>
                    </span>
                {/if}
            </p>
            <p data-testid="first-run-docs">
                Not sure which to choose?
                <span class={JOIN}>Read</span>
                <a
                    href="{PUBLIC_DOCS_URL}/choosing-where-to-store-your-notes"
                    target="_blank"
                    rel="noopener noreferrer"
                    class={TEXT_LINK}>Choosing Where To Store Your Notes</a
                >
                <span class={JOIN}>or</span>
                <a
                    href="{PUBLIC_DOCS_URL}/your-first-graph"
                    target="_blank"
                    rel="noopener noreferrer"
                    class={TEXT_LINK}>Your First Graph</a
                ><span class={JOIN}>.</span>
            </p>
        </div>
        <!-- What both kinds share, kept quiet: the panels are the choice, this is the footnote. -->
        <section
            data-testid="all-graphs-get"
            aria-labelledby="all-graphs-get-heading"
            class="pt-2 text-sm text-neutral-600 dark:text-neutral-400"
        >
            <h2 id="all-graphs-get-heading" class="font-medium">All graphs get</h2>
            <ul class="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {#each ALL_GRAPHS_GET as feature (feature)}
                    <li class="flex gap-2">
                        <svg
                            class="mt-0.5 h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.5"
                            aria-hidden="true"
                        >
                            <path stroke-linecap="round" stroke-linejoin="round" d={CHECK_ICON} />
                        </svg>
                        <span>{feature}</span>
                    </li>
                {/each}
            </ul>
        </section>
    </div>
{:else}
    <!-- The same boxes, empty, with the same text lines above and below. -->
    <div data-testid="graphs-loading" class="space-y-4" role="status">
        <span class="sr-only">Loading your graphs…</span>
        <div aria-hidden="true" class="space-y-4">
            <div
                class="h-5 w-80 max-w-full rounded bg-neutral-200 motion-safe:animate-pulse dark:bg-white/10"
            ></div>
            <div class="grid gap-4 md:grid-cols-2">
                {#each [0, 1] as panel (panel)}
                    <div
                        class="flex min-h-96 flex-col rounded-xl border border-neutral-200 bg-white p-5 dark:border-white/10 dark:bg-white/5"
                    >
                        <div
                            class="h-7 w-48 max-w-full rounded-md bg-neutral-200 motion-safe:animate-pulse dark:bg-white/10"
                        ></div>
                        <div class="mt-4 space-y-3">
                            {#each [0, 1, 2, 3, 4, 5] as line (line)}
                                <div
                                    class="h-4 w-full rounded bg-neutral-100 motion-safe:animate-pulse dark:bg-white/5"
                                ></div>
                            {/each}
                        </div>
                        <div
                            class="mt-auto h-9 w-36 rounded-lg bg-neutral-200 motion-safe:animate-pulse dark:bg-white/10"
                        ></div>
                    </div>
                {/each}
            </div>
            <div
                class="h-5 w-96 max-w-full rounded bg-neutral-100 motion-safe:animate-pulse dark:bg-white/5"
            ></div>
        </div>
    </div>
{/if}
