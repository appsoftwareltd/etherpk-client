<script lang="ts" module>
    /**
     * The label the tab's title opens with, ahead of the document it shows. Registered as the
     * kind's `titlePrefix` too, so the tab's width cap grows by it and the document's name keeps
     * a document tab's room.
     */
    export const BACKLINKS_TITLE_PREFIX = "Backlinks: ";
</script>

<script lang="ts">
    /**
     * The `backlinks` View: **Backlinks** (Logseq's Linked References) for the document the
     * user is currently in. Follows the active document (active-document.ts) rather
     * than its own ViewRef target, and recomputes when the graph index updates.
     * Each reference shows its source block drawn as the editor draws it (`QuotedText`), a block
     * reference's subtree nested under the editor's guide threads. Clicking a source opens it;
     * clicking a reference's BODY opens the source at the line the reference is written on, the
     * landing a Tasks View row makes. A document scoped by this one - its title names this concept,
     * `[[Dev Doc]] file name` under Dev Doc - is a reference too (ADR 0083): its quoted line is the
     * title, captioned "Title" where a body reference shows its outline chain, and its body opens
     * the source at the top. Mounted through the dockview adapter, so it reads the active
     * store/controller/index via their module accessors (not Svelte context).
     *
     * Two controls in the header, both per graph (`backlinks-preferences.ts`):
     *
     * - **Highlight reference** dims everything in a quoted line except the link to this
     *   document. Off by default, because a reference reads best in the document's own colours;
     *   on, it is the quickest way to spot the link in a long block. Remembered.
     * - **Pin** holds the panel on the document it is showing now, so the editor can move on —
     *   to the documents this one is referenced from, typically — while the references stay put.
     *   Held for the graph session and survives the mobile drawer unmounting this View; a fresh
     *   session follows the editor again. A pinned document that is renamed stays pinned under
     *   its old name until it is unpinned, which is the honest thing to show rather than a guess.
     *
     * **Show backlinks** on a wikilink or a tab (`commands/document-commands.ts`, ADR 0088) changes
     * what the panel shows and leaves the pin as it is: pinned, the pin moves; following, the
     * concept asked for stands in for the editor's document until the editor moves on, captioned
     * "Showing X" meanwhile. The store holds that policy and is subscribed to rather than read
     * once at mount, because it changes from outside this View.
     */
    import { onDestroy, onMount } from "svelte";

    import { viewKey, type ViewRef } from "$lib/layout";
    import { tryGetActiveEventBus } from "$lib/surface";
    import { iconSvg } from "$lib/surface/icons";
    import { workspaceService } from "$lib/workspace/workspace-services";

    import { getActiveDocument } from "../active-document";
    import {
        conceptKey,
        type DbBacklinkGroup,
        type DbBacklinkRef,
        getActiveGraphIndex,
        nestSubtree,
        type RefSubtreeNode,
        type SubtreeBranch,
    } from "../backlinks";
    import { openConcept, openConceptAtLine } from "../open-concept";
    import type { BacklinksPreferences, ShownConcept } from "../backlinks-preferences";
    import { lineText } from "../quote-segments";
    import { GUIDE_WIDTH_PX } from "./augmentations/outline-guides-core";
    import InlineMarkdown from "./InlineMarkdown.svelte";
    import QuotedText from "./QuotedText.svelte";

    // The ViewRef's target is ignored — the panel follows the active document, not a fixed
    // one. `panelId` is supplied by the dockview presenter; the mobile presenter has no tabs to
    // retitle and passes none, so the view key stands in and the retitle is a no-op there.
    let { view, panelId }: { view: ViewRef; panelId?: string } = $props();

    // Absent outside a graph workspace (the /dev harnesses), where both controls simply default.
    const preferences = workspaceService("backlinksPreferences");

    // The document in front of the main region. The bus has no replay, so it is read now (this
    // View may be created after the front tab was named), followed from onMount on, and read
    // again there (see onMount for the gap between the two).
    let active = $state<string | null>(getActiveDocument());
    /** The document the panel is held on, or null while it follows the editor. */
    let pinned = $state<string | null>(preferences?.get().pinned ?? null);
    /** What Show backlinks asked for while following; stands in for `active` until the editor moves on. */
    let shown = $state<ShownConcept | null>(preferences?.get().shown ?? null);
    /** Whose references are shown. */
    const concept = $derived(pinned ?? shown?.concept ?? active);
    let highlight = $state(preferences?.get().highlight ?? false);
    /**
     * The last answer, and whose it is. An answer is shown only under its own concept's name: while
     * another document's are on their way the panel says it is loading rather than showing the
     * previous document's references as this one's. A refresh of the same concept (an index update)
     * keeps the answer it has on screen until the new one lands, so a save never blanks the panel.
     */
    let answer = $state.raw<{ concept: string; groups: DbBacklinkGroup[] } | null>(null);
    /** The concept whose last fetch failed, while it has no answer to show instead. */
    let failedFor = $state<string | null>(null);
    const answered = $derived(concept !== null && answer?.concept === concept);
    const groups = $derived(answered ? answer!.groups : []);
    const count = $derived(groups.reduce((n, g) => n + g.refs.length, 0));
    const failed = $derived(concept !== null && !answered && failedFor === concept);
    const loading = $derived(concept !== null && !answered && !failed);

    /**
     * The index lives in a worker now (ADR 0041), so this is a round trip. `wanted` guards
     * against an out-of-order answer overwriting a newer one when the user switches
     * documents faster than the worker replies.
     */
    let wanted: string | null = null;
    function recompute() {
        const index = getActiveGraphIndex();
        const target = concept;
        wanted = target;
        if (!index || !target) {
            answer = null;
            return;
        }
        index.backlinks(target).then(
            (next) => {
                if (wanted !== target) return;
                answer = { concept: target, groups: next };
                failedFor = null;
            },
            () => {
                // A failed refresh leaves an answer already on screen where it is; a first fetch
                // has nothing to fall back on, so the panel says it failed and offers another try.
                if (wanted === target) failedFor = target;
            },
        );
    }

    function retry() {
        failedFor = null;
        recompute();
    }

    // Fetched again whenever what is shown changes, whichever way it changed: the pin, what
    // Show backlinks asked for, or the editor moving on. `recompute` reads `concept`, this
    // effect's one dependency; an index update re-fetches through `onUpdated` below.
    $effect(() => recompute());

    function open(sourceConcept: string) {
        openConcept(sourceConcept);
    }

    /**
     * A click on a reference's body opens the source at the line the reference is written on.
     * The wikilinks and other affordances inside the body stop their own clicks, so a click that
     * arrives here was on the body itself.
     *
     * Not while the user is selecting text out of the reference: a drag that ends inside the
     * body is still a click to the browser, and the selection just made would vanish under the
     * navigation. An ordinary click leaves a collapsed selection behind, so that is the tell.
     */
    function onRefClick(ref: DbBacklinkRef) {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return;
        openConceptAtLine(ref.sourceConcept, ref.line);
    }

    /** The keyboard half of being a button: Enter or Space on the body itself, not on a link inside it. */
    function onRefKeydown(event: KeyboardEvent, ref: DbBacklinkRef) {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openConceptAtLine(ref.sourceConcept, ref.line);
    }

    /** A link to the concept being viewed (the target page) — emphasised in bold. */
    function isTarget(linkConcept: string): boolean {
        return concept !== null && conceptKey(linkConcept) === conceptKey(concept);
    }

    /** The store's state, whoever wrote it: this View's controls, or Show backlinks from outside. */
    function apply(next: BacklinksPreferences) {
        highlight = next.highlight;
        pinned = next.pinned;
        shown = next.shown;
    }

    /** Through the store where there is one, which answers through the subscription; else directly (a harness). */
    function setPreferences(next: Partial<BacklinksPreferences>) {
        if (preferences) preferences.set(next);
        else apply({ highlight, pinned, shown, ...next });
    }

    function setHighlight(on: boolean) {
        setPreferences({ highlight: on });
    }

    /** Pin what is showing now; unpinning snaps back to whatever the editor is on. */
    function togglePin() {
        if (pinned !== null) setPreferences({ pinned: null, shown: null });
        else if (concept !== null) setPreferences({ pinned: concept, shown: null });
    }

    // The tab is titled by what the panel SHOWS, which is not always the active document: pinned,
    // it stays on the pinned one. So the View owns its title (as the asset View does) rather than
    // the workspace retitling it on every active-document change. Runs on mount too, which covers
    // a layout restored with a document already active before this panel existed.
    $effect(() => {
        const title = concept ? `${BACKLINKS_TITLE_PREFIX}${concept}` : "Backlinks";
        workspaceService("retitleView")?.(panelId ?? viewKey(view), title);
    });

    /**
     * The prose font's space and dash: the two widths the editor's outline is built from
     * (content-clamp.ts measures the same pair with a canvas), published as `--ref-space` and
     * `--ref-dash` for the row geometry in the styles below. Measured at the size the text is
     * drawn at, as the editor measures: Inter's optical sizes space glyphs differently at other
     * sizes, so a width measured at one size does not scale to another. Measured again once the
     * web font has loaded, and whenever the panel's size changes, which a change of the editor
     * font size causes.
     */
    function measureProse(root: HTMLElement) {
        const context = document.createElement("canvas").getContext("2d");
        const measure = () => {
            const style = getComputedStyle(root);
            if (!context || !style.font.trim()) return;
            context.font = style.font;
            const space = context.measureText(" ").width;
            const dash = context.measureText("-").width;
            if (!(space > 0) || !(dash > 0)) return;
            root.style.setProperty("--ref-space", `${space.toFixed(3)}px`);
            root.style.setProperty("--ref-dash", `${dash.toFixed(3)}px`);
        };
        measure();
        void document.fonts?.ready.then(measure);
        const observer = new ResizeObserver(measure);
        observer.observe(root);
        return () => observer.disconnect();
    }

    /**
     * Lay a parent's guide thread on the device-pixel grid, centred under its dot and as wide as
     * the editor's (GUIDE_WIDTH_PX), as the editor lays its threads (outline-guides.ts): a line at a
     * fractional position antialiases onto a different number of device pixels from row to row, so
     * the threads read as different thicknesses. Published as the width (`--thread-width`) and a
     * correction to the thread's CSS position (`--thread-snap`), and measured again whenever the
     * branch is resized, which a panel resize or a zoom does.
     */
    function snapThread(branchElement: HTMLElement) {
        const place = () => {
            const dot = branchElement.querySelector(":scope > .ref__block > .ref__bullet");
            if (!dot) return;
            const box = dot.getBoundingClientRect();
            const left = box.left + box.width / 2 - GUIDE_WIDTH_PX / 2;
            const dpr = window.devicePixelRatio || 1;
            const snapped = Math.round(left * dpr) / dpr;
            // The dot does not move with the correction, so this is the whole of it, not a delta.
            branchElement.style.setProperty("--thread-snap", `${(snapped - left).toFixed(3)}px`);
            branchElement.style.setProperty("--thread-width", `${GUIDE_WIDTH_PX}px`);
        };
        place();
        const observer = new ResizeObserver(place);
        observer.observe(branchElement);
        return () => observer.disconnect();
    }

    let unsubActive: (() => void) | undefined;
    let unsubIndex: (() => void) | undefined;
    let unsubPreferences: (() => void) | undefined;
    onMount(() => {
        // Only `active` is kept here. Whether the editor moving on drops what Show backlinks
        // asked for is the store's call (the workspace tells it), so a phone's closed drawer,
        // with this View unmounted, reaches the same answer.
        unsubActive = tryGetActiveEventBus()?.on("document:active-changed", ({ documentId }) => {
            active = documentId;
        });
        // Read again now that the subscription is live. Svelte runs onMount after the component
        // is created, not during it, and a restored layout (a reload) announces its document tab
        // in between: dockview creates this panel, then activates the tab. The bus has no replay,
        // so that announcement reached nobody, and the panel sat idle beside an open document.
        active = getActiveDocument();
        unsubIndex = getActiveGraphIndex()?.onUpdated(recompute);
        // The store replays its state on subscribe; that first call repeats the seeds above.
        unsubPreferences = preferences?.subscribe(apply);
    });
    onDestroy(() => {
        unsubActive?.();
        unsubIndex?.();
        unsubPreferences?.();
    });
</script>

<!-- One line of a reference, rendered as the document editor renders it: wikilinks navigate
     (dashed where the page does not exist yet), hyperlinks open a tab, an [[Asset Reference]]
     downloads or opens in its own tab, and a line holding nothing but an image shows the picture.
     Delete is absent by design - taking a reference out of a line is the editor's job. The
     reference itself is emphasised only while highlighting. -->
{#snippet line(text: string)}<InlineMarkdown {text} matches={highlight ? isTarget : undefined} />{/snippet}
<!-- A whole block (a reference's body), drawn as the editor draws it: QuotedText. -->
{#snippet quote(text: string)}<QuotedText {text} matches={highlight ? isTarget : undefined} />{/snippet}

<!-- One block of a block reference's subtree, with its children nested under it. A block with
     children hangs the editor's outline guide thread from its dot beside them (outline-guides.ts);
     a task shows its checkbox, which the index keeps apart from the text (read-only here, as
     everything in the panel is). -->
{#snippet branch(branchOf: SubtreeBranch<RefSubtreeNode>)}
    <div
        class="ref__branch"
        class:ref__branch--parent={branchOf.children.length > 0}
        data-testid="backlinks-branch"
        {@attach branchOf.children.length > 0 && snapThread}
    >
        <div
            class="ref__block"
            class:ref__block--match={branchOf.node.isMatch}
            class:ref__block--task={branchOf.node.done !== undefined}
            data-testid="backlinks-block"
            data-depth={branchOf.node.depth}
        >
            <span class="ref__bullet" aria-hidden="true"></span>
            {#if branchOf.node.done !== undefined}
                <span
                    class="ref__checkbox"
                    class:ref__checkbox--done={branchOf.node.done}
                    role="img"
                    aria-label={branchOf.node.done ? "Done task" : "Open task"}
                    data-testid="backlinks-task"
                    data-done={branchOf.node.done}
                ></span>
            {/if}
            {@render quote(branchOf.node.text)}
        </div>
        {#if branchOf.children.length > 0}
            <div class="ref__children">
                {#each branchOf.children as child, c (c)}{@render branch(child)}{/each}
            </div>
        {/if}
    </div>
{/snippet}

<div
    class="backlinks"
    {@attach measureProse}
    aria-busy={loading}
    class:backlinks--highlight={highlight}
    data-testid="backlinks-view"
    data-highlight={highlight}
    data-pinned={pinned ?? undefined}
>
    <header>
        <h3>Backlinks</h3>
        {#if answered}<span class="count" data-testid="backlinks-count">{count}</span>{/if}
        <div class="controls">
            <!-- A switch, not a checkbox: it takes effect at once, there is nothing to submit. -->
            <button
                type="button"
                role="switch"
                aria-checked={highlight}
                class="switch"
                data-testid="backlinks-highlight"
                title="Dim everything in a reference except the link to this document"
                onclick={() => setHighlight(!highlight)}
            >
                <span class="switch__label">Highlight reference</span>
                <span class="switch__track" aria-hidden="true"><span class="switch__knob"></span></span>
            </button>
            <!-- Disabled only while there is nothing to pin; the idle hint below says why. -->
            <button
                type="button"
                class="pin"
                class:pin--on={pinned !== null}
                aria-pressed={pinned !== null}
                aria-label={pinned !== null ? `Unpin from ${pinned}` : concept ? `Pin to ${concept}` : "Pin"}
                title={pinned !== null
                    ? `Pinned to ${pinned} - click to follow the editor again`
                    : "Keep showing this document's backlinks while you open others"}
                data-testid="backlinks-pin"
                disabled={concept === null}
                onclick={togglePin}
            >
                <!-- In-repo constant markup from the icon table, never document content. -->
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                {@html iconSvg("pin", { size: 18 })}
            </button>
        </div>
    </header>
    {#if pinned !== null}
        <p class="caption" data-testid="backlinks-pinned">Pinned to <strong>{pinned}</strong></p>
    {:else if shown !== null}
        <!-- Not the editor's document, and not held either: what Show backlinks asked for, until the
             editor moves on. Said here because a phone's drawer tab is not retitled. -->
        <p class="caption" data-testid="backlinks-shown">Showing <strong>{shown.concept}</strong></p>
    {/if}

    {#if !concept}
        <p class="hint" data-testid="backlinks-idle">Open a document to see what links to it.</p>
    {:else if loading}
        <!-- Shown a moment after the fetch starts, so an answer that comes straight back never
             flashes it (the style below delays it). -->
        <p class="loading" data-testid="backlinks-loading">
            <span class="loading__spinner" aria-hidden="true"></span>
            Loading backlinks to <strong>{concept}</strong>…
        </p>
    {:else if failed}
        <p class="hint hint--error" data-testid="backlinks-error">
            Could not load the backlinks to <strong>{concept}</strong>: the graph's index did not answer.
            <button type="button" class="retry" onclick={retry}>Try again</button>
        </p>
    {:else if groups.length === 0}
        <p class="hint" data-testid="backlinks-empty">
            No backlinks to <strong>{concept}</strong> yet.
        </p>
    {:else}
        <ul class="groups">
            {#each groups as group (group.sourceConcept)}
                <li class="group" data-testid="backlinks-group">
                    <!-- The document's name, a step up in size, and what kind it is as quiet help text. -->
                    <button
                        class="source"
                        data-testid="backlinks-source"
                        data-kind={group.sourceKind}
                        onclick={() => open(group.sourceConcept)}
                    >
                        <span class="source__name">{group.sourceConcept}</span>
                        <span class="source__kind">{group.sourceKind === "journal" ? "Journal" : "Page"}</span>
                    </button>
                    <ul class="refs">
                        {#each group.refs as ref, i (ref.line + ":" + i)}
                            <li class="mt-3">
                                {#if ref.kind === "title"}
                                    <!-- Where a body reference shows its outline chain, a title reference
                                         says where it sits: in the name itself, above every line. -->
                                    <div class="ref__chain ref__origin" data-testid="backlinks-title-origin">Title</div>
                                {:else if ref.breadcrumb.length > 0}
                                    <div class="ref__chain" data-testid="backlinks-chain">
                                        <strong>
                                            {#each ref.breadcrumb as label, j (j)}
                                                <!-- The mustache is not useless: Svelte trims a plain text node, so " › " would lose its spaces and the chain would read "A›B". -->
                                                <!-- eslint-disable-next-line svelte/no-useless-mustaches -->
                                                {#if j > 0}<span class="sep">{" › "}</span>{/if}{@render line(lineText(label))}
                                            {/each}
                                        </strong>
                                    </div>
                                {/if}
                                <!-- The body is the button that opens the source AT THIS LINE. A div in the
                                     button role rather than a <button>: the line inside carries real buttons
                                     and anchors of its own (InlineMarkdown), and interactive content may not
                                     nest in a button. Those stop their clicks, so the body only hears its own. -->
                                <div
                                    class="ref mt-3"
                                    role="button"
                                    tabindex="0"
                                    data-testid="backlinks-ref"
                                    data-kind={ref.kind}
                                    onclick={() => onRefClick(ref)}
                                    onkeydown={(event) => onRefKeydown(event, ref)}
                                >
                                    {#if ref.kind === "block"}
                                        {#each nestSubtree(ref.subtree) as root, n (n)}{@render branch(root)}{/each}
                                    {:else if ref.context}
                                        <div class="ref__text">{@render quote(ref.context.text)}</div>
                                    {/if}
                                </div>
                            </li>
                        {/each}
                    </ul>
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
    .backlinks {
        height: 100%;
        overflow: auto;
        padding: 0.6rem 0.75rem;
        /* Both desktop columns and mobile drawers mount this same View, so the
           root-level editor preference keeps their primary text in step. */
        font-family: var(--gk-sans, "Inter", system-ui, sans-serif);
        font-size: var(--editor-font-size, 1rem);
        line-height: 1.5;
        color: var(--gk-text-default);
    }
    header {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 0.5rem;
    }
    /* 0.875rem (text-sm) is the floor for anything read, and the size the Tasks header uses. */
    h3 {
        margin: 0;
        font-size: 0.875rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.7;
    }
    .count {
        min-width: 1.4rem;
        padding: 0.05rem 0.45rem;
        border-radius: 999px;
        background: var(--gk-surface-2, rgba(127, 127, 127, 0.15));
        font-size: 0.875rem;
        font-weight: 600;
        text-align: center;
    }
    /* The two controls, right-aligned; on a narrow drawer they wrap under the title as a row. */
    .controls {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-left: auto;
    }
    .switch {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.1rem 0;
        border: 0;
        background: transparent;
        color: var(--gk-text-muted, inherit);
        font: inherit;
        font-size: 0.875rem;
        cursor: pointer;
        white-space: nowrap;
    }
    @media (hover: hover) {
        .switch:hover {
            color: var(--gk-text-default);
        }
    }
    /* The track is 2.25 × 1.25rem: big enough to read as a switch and to tap. */
    .switch__track {
        position: relative;
        display: inline-block;
        width: 2.25rem;
        height: 1.25rem;
        border-radius: 999px;
        background: var(--gk-border-strong, rgba(127, 127, 127, 0.4));
        transition: background 120ms ease;
    }
    .switch__knob {
        position: absolute;
        top: 2px;
        left: 2px;
        width: calc(1.25rem - 4px);
        height: calc(1.25rem - 4px);
        border-radius: 50%;
        background: var(--gk-surface-0, #fff);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
        transition: transform 120ms ease;
    }
    .switch[aria-checked="true"] .switch__track {
        background: var(--gk-accent, #2563eb);
    }
    .switch[aria-checked="true"] .switch__knob {
        transform: translateX(1rem);
    }
    .pin {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 4px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--gk-text-muted, currentColor);
        cursor: pointer;
        line-height: 0;
    }
    /* Hover styling only where hover exists: a tapped button on a touch screen keeps `:hover`
       until the next tap elsewhere, and a hover colour that outranked the pinned state left the
       icon grey until the drawer was reopened. */
    @media (hover: hover) {
        .pin:hover:not(:disabled) {
            background: rgba(127, 127, 127, 0.22);
            color: var(--gk-text-default, currentColor);
        }
    }
    .pin:disabled {
        opacity: 0.4;
        cursor: default;
    }
    /* Pinned: the accent, and a tint that stays without hover, so the state is legible at rest.
       Declared after the hover rule and repeated with it, so the state wins under the pointer too. */
    .pin--on,
    .pin--on:hover {
        color: var(--gk-accent, #2563eb);
        background: color-mix(in srgb, var(--gk-accent, #2563eb) 14%, transparent);
    }
    .switch:focus-visible,
    .pin:focus-visible {
        outline: 2px solid var(--gk-accent, #2563eb);
        outline-offset: 1px;
    }
    @media (prefers-reduced-motion: reduce) {
        .switch__track,
        .switch__knob,
        .ref {
            transition: none;
        }
    }
    /* "Pinned to X" / "Showing X", under the header. */
    .caption {
        margin: -0.2rem 0 0.5rem;
        font-size: 0.875rem;
        color: var(--gk-text-muted);
    }
    .hint {
        margin: 0;
        opacity: 0.6;
        font-size: 0.875rem;
    }
    /* Not dimmed like the other hints: this one asks for something. */
    .hint--error {
        opacity: 1;
        color: var(--gk-text-muted);
    }
    .retry {
        margin-left: 0.25rem;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--gk-accent, #2563eb);
        font: inherit;
        text-decoration: underline;
        cursor: pointer;
    }
    .retry:focus-visible {
        outline: 2px solid var(--gk-accent, #2563eb);
        outline-offset: 1px;
    }
    /* Loading: a quiet ring and a line of text, faded in only once the wait is worth explaining
       (the reference image's placeholder waits the same way, AssetImage.svelte). */
    .loading {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin: 0;
        color: var(--gk-text-muted);
        font-size: 0.875rem;
        opacity: 0;
        animation: backlinks-appear 150ms ease-out 200ms forwards;
    }
    .loading__spinner {
        flex: none;
        width: 1em;
        height: 1em;
        box-sizing: border-box;
        border: 2px solid rgba(127, 127, 127, 0.25);
        border-top-color: rgba(127, 127, 127, 0.8);
        border-radius: 50%;
        animation: backlinks-spin 0.9s linear infinite;
    }
    @keyframes backlinks-appear {
        to {
            opacity: 1;
        }
    }
    @keyframes backlinks-spin {
        to {
            transform: rotate(360deg);
        }
    }
    /* Rotation is the motion the preference suppresses; a slow pulse still says "busy". */
    @media (prefers-reduced-motion: reduce) {
        .loading__spinner {
            animation: backlinks-pulse 1.6s ease-in-out infinite;
        }
    }
    @keyframes backlinks-pulse {
        50% {
            opacity: 0.3;
        }
    }
    .groups,
    .refs {
        list-style: none;
        margin: 0;
        padding: 0;
    }
    .group {
        margin-bottom: 0.7rem;
    }
    /* A group's heading: the document's name a step above the quoted text, then what kind of
       document it is as quiet help text (the 14px floor, muted, regular weight). */
    .source {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        column-gap: 0.5rem;
        width: 100%;
        padding: 0.15rem 0;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
    }
    .source__name {
        font-size: 1.1em;
        font-weight: 600;
    }
    .source__kind {
        font-size: 0.875rem;
        font-weight: 400;
        color: var(--gk-text-muted);
    }
    @media (hover: hover) {
        .source:hover .source__name {
            color: var(--gk-accent, #2563eb);
        }
    }
    .source:focus-visible {
        outline: 2px solid var(--gk-accent, #2563eb);
        outline-offset: 1px;
    }
    /* The snippet content sits in a panel that lightly contrasts the page background. The panel
       is the button that opens the source at this line, so it answers the pointer and the
       keyboard. Hover only where hover exists, for the reason given at `.pin`. A tint of the
       accent rather than the accent itself: the links inside keep the full colour, so the two
       targets - the body and a link in it - read as two. */
    .ref {
        /*
         * The editor's outline geometry, built the way the editor builds it from the prose font's
         * space and dash (measured into --ref-space and --ref-dash; Inter's are the fallbacks):
         * - a row's text starts a dash, a space and CONTENT_GUTTER (0.6em of the code font, which
         *   is 0.86 of this one) in from where its `- ` would be (content-clamp.ts);
         * - each level steps in the two spaces of the Indent Unit plus INDENT_STEP_PX (12px);
         * - the dot sits at the middle of the dash, half a line pitch down (bullet-marker.ts).
         * Rows are the editor's pitch: 1.7 lines, rounded to a whole pixel where the browser can
         * (cm-document.ts), so every row, and every dot on it, lands on the pixel grid alike.
         */
        --ref-content: calc(var(--ref-dash, 0.457em) + var(--ref-space, 0.2778em) + 0.6em * 0.86);
        --ref-step: calc(2 * var(--ref-space, 0.2778em) + 12px);
        line-height: 1.7;
        padding: 0.4rem 0.55rem;
        background: var(--gk-surface-2);
        border-radius: 6px;
        cursor: pointer;
        transition: background 120ms ease;
    }
    @supports (line-height: round(1px, 1px)) {
        .ref {
            line-height: round(1.7em, 1px);
        }
    }
    @media (hover: hover) {
        .ref:hover {
            background: color-mix(in srgb, var(--gk-accent, #2563eb) 10%, var(--gk-surface-2));
        }
    }
    .ref:focus-visible {
        outline: 2px solid var(--gk-accent, #2563eb);
        outline-offset: 1px;
    }
    /* Lines arrive as lines (QuotedText), so no `pre-wrap` here: it would keep the formatting
       whitespace inside what a line renders, a picture's overlay included. */
    .ref__text {
        word-break: break-word;
    }
    /* Block reference: the matched block + its descendant subtree, nested. A hanging indent — the
       bullet is out of the inline flow, the content column starts past it — so a long url, a
       picture or a link that does not fit BESIDE the bullet stays on the bullet's row and breaks
       within the column, rather than dropping whole to the line below and leaving the dot on its
       own. `flow-root` keeps a first line's top margin (a quote panel's) inside the row, so the
       dot stays at the row's top as the editor pins it. */
    .ref__block {
        position: relative;
        display: flow-root;
        padding-left: var(--ref-content);
        word-break: break-word;
        overflow-wrap: anywhere;
    }
    /* The dash's box, one row tall, with the editor's dot painted at its centre: a whole-pixel
       disc 0.36em across in the subtle text colour (bullet-marker.ts). */
    .ref__bullet {
        position: absolute;
        left: 0;
        top: 0;
        width: var(--ref-dash, 0.457em);
        height: calc(1.7em - 1px);
    }
    .ref__bullet::before {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        width: 0.36em;
        height: 0.36em;
        border-radius: 50%;
        background: var(--gk-text-subtle, #9ca3af);
        transform: translate(-50%, -50%);
    }
    @supports (width: round(1px, 1px)) {
        .ref__bullet::before {
            width: round(0.36em, 1px);
            height: round(0.36em, 1px);
        }
    }
    .ref__branch {
        position: relative;
    }
    /* Children step in one level, so a child's dot sits under its parent's text. */
    .ref__children {
        margin-left: var(--ref-step);
    }
    /* A parent's guide thread, as the editor draws it (outline-guides.ts): a line GUIDE_WIDTH_PX wide
       (`--thread-width`) in the strong border colour, centred under the dot on the device-pixel grid
       (`--thread-snap`, snapThread), from 8px below the dot's centre (DOT_GAP) down to the last
       row's text, which ends a quarter em above its row. */
    .ref__branch--parent::before {
        content: "";
        position: absolute;
        left: calc(var(--ref-dash, 0.457em) / 2 - var(--thread-width, 2px) / 2 + var(--thread-snap, 0px));
        top: calc(0.85em - 0.5px + 8px);
        bottom: 0.25em;
        width: var(--thread-width, 2px);
        background: var(--gk-border-strong, rgba(3, 7, 18, 0.16));
        pointer-events: none;
    }
    /* A task's checkbox, value for value as task-checkbox.ts draws it: at the content column, the
       text moved on by the checkbox slot (0.82em and its 0.36em gap) and a space, as the editor's
       clamp pads a task. Not a control: nothing in the panel edits, so it has no hover state. */
    .ref__block--task {
        padding-left: calc(var(--ref-content) + 0.82em + 0.36em + var(--ref-space, 0.2778em));
    }
    .ref__checkbox {
        position: absolute;
        left: var(--ref-content);
        top: calc(0.85em - 0.5px - 0.41em);
        box-sizing: border-box;
        width: 0.82em;
        height: 0.82em;
        border: 1.5px solid var(--gk-text-subtle, #9ca3af);
        border-radius: 3px;
    }
    .ref__checkbox--done {
        background: var(--gk-accent, #2563eb);
        border-color: var(--gk-accent, #2563eb);
    }
    .ref__checkbox--done::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        box-sizing: border-box;
        width: 0.42em;
        height: 0.22em;
        border-left: 2px solid #fff;
        border-bottom: 2px solid #fff;
        transform: translate(-50%, -70%) rotate(-45deg);
    }
    /* Breadcrumb: same text size as the snippet. */
    .ref__chain {
        margin: 0.1rem 0 0.2rem;
    }
    /* The "Title" caption of a title reference: a placement, not a chain, so it recedes. */
    .ref__origin {
        color: var(--gk-text-muted);
    }
    /* The pointer on a row brightens its asset icons a step — the editor's `.cm-line:hover`
       tier — read by InlineMarkdown through this variable. */
    .ref__block:hover,
    .ref__text:hover {
        --gk-asset-actions-opacity: 0.8;
    }
    /* Highlighting: everything but the reference itself recedes, the matched block least of all.
       Off by default — a reference reads best in the document's own colours — and the muted
       tones here are the whole feature when it is on. */
    .backlinks--highlight .ref__chain {
        opacity: 0.6;
    }
    .backlinks--highlight .ref__text {
        opacity: 0.85;
    }
    .backlinks--highlight .ref__block {
        opacity: 0.7;
    }
    .backlinks--highlight .ref__block--match {
        opacity: 0.95;
    }
</style>
