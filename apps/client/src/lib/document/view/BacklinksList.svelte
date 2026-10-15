<script lang="ts">
    /**
     * One concept's [[Backlink]]s as a list: a group per source document, headed by its name and
     * kind, and each reference in it with its outline chain and its block drawn as the editor draws
     * it (`QuotedText`), a block reference's subtree nested under the editor's guide threads.
     * Clicking a source opens it; clicking a reference's BODY opens the source at the line the
     * reference is written on, the landing a Tasks View row makes. A document scoped by this one
     * (its title names this concept, ADR 0083) is a reference too: its quoted line is the title,
     * captioned "Title" where a body reference shows its outline chain.
     *
     * The one rendering of a backlinks list, shared by the Backlinks panel (`BacklinksView`) and the
     * section beneath every document (`DocumentBacklinks`, ADR 0135), so the two cannot drift apart.
     * Everything here is read-only: a reference is changed in the document that holds it.
     */
    import {
        type DbBacklinkGroup,
        type DbBacklinkRef,
        nestSubtree,
        type RefSubtreeNode,
        type SubtreeBranch,
    } from "../backlinks";
    import { openConcept, openConceptAtLine } from "../open-concept";
    import { lineText } from "../quote-segments";
    import { CONTENT_GUTTER } from "./augmentations/content-clamp";
    import { GUIDE_WIDTH_PX } from "./augmentations/outline-guides-core";
    import InlineMarkdown from "./InlineMarkdown.svelte";
    import QuotedText from "./QuotedText.svelte";

    let {
        groups,
        highlight,
        matches,
        sourcePanelId,
    }: {
        groups: DbBacklinkGroup[];
        /** Dim everything in a reference except the link to the concept (`backlinks-preferences.ts`). */
        highlight: boolean;
        /** Whether a link names the concept whose backlinks these are (`linksToConcept`). */
        matches: (link: string) => boolean;
        /**
         * The panel the list is shown in, so what it opens lands in that panel's Pane: the section
         * beneath a document passes the document's. Absent, the Layout places it (the panel).
         */
        sourcePanelId?: string;
    } = $props();

    /** Emphasised only while highlighting: a reference reads best in the document's own colours. */
    const emphasis = $derived(highlight ? matches : undefined);

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
        openConceptAtLine(ref.sourceConcept, ref.line, sourcePanelId);
    }

    /** The keyboard half of being a button: Enter or Space on the body itself, not on a link inside it. */
    function onRefKeydown(event: KeyboardEvent, ref: DbBacklinkRef) {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openConceptAtLine(ref.sourceConcept, ref.line, sourcePanelId);
    }

    /**
     * The prose font's space and dash: the two widths the editor's outline is built from
     * (content-clamp.ts measures the same pair with a canvas), published as `--ref-space` and
     * `--ref-dash` for the row geometry in the styles below. Measured at the size the text is
     * drawn at, as the editor measures: Inter's optical sizes space glyphs differently at other
     * sizes, so a width measured at one size does not scale to another. Measured again once the
     * web font has loaded, and whenever the list's size changes, which a change of the editor
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
</script>

<!-- One line of a reference, rendered as the document editor renders it: wikilinks navigate
     (dashed where the page does not exist yet), hyperlinks open a tab, an [[Asset Reference]]
     downloads or opens in its own tab, and a line holding nothing but an image shows the picture.
     Delete is absent by design - taking a reference out of a line is the editor's job. The
     reference itself is emphasised only while highlighting. -->
{#snippet line(text: string)}<InlineMarkdown {text} matches={emphasis} {sourcePanelId} />{/snippet}
<!-- A whole block (a reference's body), drawn as the editor draws it: QuotedText. -->
{#snippet quote(text: string, sourceConcept: string)}<QuotedText {text} {sourceConcept} matches={emphasis} {sourcePanelId} />{/snippet}

<!-- One block of a block reference's subtree, with its children nested under it. A block with
     children hangs the editor's outline guide thread from its dot beside them (outline-guides.ts);
     a task shows its checkbox, which the index keeps apart from the text (read-only here, as
     everything in the list is). -->
{#snippet branch(branchOf: SubtreeBranch<RefSubtreeNode>, sourceConcept: string)}
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
            {@render quote(branchOf.node.text, sourceConcept)}
        </div>
        {#if branchOf.children.length > 0}
            <div class="ref__children">
                {#each branchOf.children as child, c (c)}{@render branch(child, sourceConcept)}{/each}
            </div>
        {/if}
    </div>
{/snippet}

<ul
    class="groups"
    class:groups--highlight={highlight}
    {@attach measureProse}
    style:--content-gutter={CONTENT_GUTTER}
>
    {#each groups as group (group.sourceConcept)}
        <li class="group" data-testid="backlinks-group">
            <!-- The document's name, a step up in size, and what kind it is as quiet help text. -->
            <button
                class="source"
                data-testid="backlinks-source"
                data-kind={group.sourceKind}
                onclick={() => openConcept(group.sourceConcept, sourcePanelId)}
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
                                {#each nestSubtree(ref.subtree) as root, n (n)}{@render branch(root, ref.sourceConcept)}{/each}
                            {:else if ref.context}
                                <div class="ref__text">{@render quote(ref.context.text, ref.sourceConcept)}</div>
                            {/if}
                        </div>
                    </li>
                {/each}
            </ul>
        </li>
    {/each}
</ul>

<style>
    /* The quoted text is document text, so it follows the editor's font size, in the panel and
       beneath a document alike. */
    .groups {
        font-family: var(--gk-sans, "Inter", system-ui, sans-serif);
        font-size: var(--editor-font-size, 1rem);
        line-height: 1.5;
        color: var(--gk-text-default);
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
       keyboard. Hover only where hover exists: a tapped element on a touch screen keeps `:hover`
       until the next tap elsewhere. A tint of the accent rather than the accent itself: the links
       inside keep the full colour, so the two targets - the body and a link in it - read as two. */
    .ref {
        /*
         * The editor's outline geometry, built the way the editor builds it from the prose font's
         * space and dash (measured into --ref-space and --ref-dash; Inter's are the fallbacks):
         * - a row's text starts a dash, a space and CONTENT_GUTTER in from where its `- ` would be
         *   (content-clamp.ts; passed in on the root as --content-gutter, the editor's own value);
         * - each level steps in the two spaces of the Indent Unit plus INDENT_STEP_PX (12px);
         * - the dot sits at the middle of the dash, half a line pitch down (bullet-marker.ts).
         * Rows are the editor's pitch: 1.7 lines, rounded to a whole pixel where the browser can
         * (cm-document.ts), so every row, and every dot on it, lands on the pixel grid alike.
         */
        --ref-content: calc(var(--ref-dash, 0.457em) + var(--ref-space, 0.2778em) + var(--content-gutter));
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
    @media (prefers-reduced-motion: reduce) {
        .ref {
            transition: none;
        }
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
       clamp pads a task. Not a control: nothing in the list edits, so it has no hover state. */
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
       tones here are the whole feature when it is on. The steps are colours, each 4.5:1 or more,
       where opacity had taken the receding text under that; links keep their own colour. */
    .groups--highlight .ref__chain,
    .groups--highlight .ref__block {
        color: var(--gk-text-subtle);
    }
    .groups--highlight .ref__text {
        color: var(--gk-text-muted);
    }
    .groups--highlight .ref__block--match {
        color: var(--gk-text-default);
    }
</style>
