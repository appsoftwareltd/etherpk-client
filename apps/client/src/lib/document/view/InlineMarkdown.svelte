<script lang="ts">
    /**
     * One line of document source rendered **read-only**: wikilinks, external hyperlinks,
     * [[Asset Reference]]s, images and inline math, under the inline marks (bold, italic, code,
     * strikethrough, highlight) the editor styles, with everything else left as the text it is.
     *
     * What each construct is, and what a click on it should do, is `inline-parts.ts` — the editor's
     * own rules read over plain text. This component is only the markup around them, which is why
     * a panel showing another document's line cannot end up disagreeing with the editor about what
     * that line contains.
     *
     * Every affordance here is read-only. Wikilinks navigate (opening a [[Draft]] where there is no
     * page yet, the editor's rule), hyperlinks open a tab, an asset downloads or opens in its own
     * tab — from the trailing icon cluster the editor's asset link carries, placed and shaded the
     * same way, or from the [[Context Menu]] on right-click and long press. Nothing edits: a
     * reference's **delete** needs the line it is written on, and that belongs to the document
     * editor. See `AssetActions.svelte`.
     */
    import { attachContextMenu } from "$lib/surface";

    import { conceptIsMissing, openConcept } from "../open-concept";
    import { runAssetCommand } from "../asset-affordances";
    import { LINK_COPY_PATH, fileLinkActions, runLinkCommand } from "../link-affordances";
    import { ASSET_DOWNLOAD } from "../commands/asset-commands";
    import { type InlineMark, type InlinePart, inlineParts } from "../inline-parts";
    import AssetActions from "./AssetActions.svelte";
    import AssetImage from "./AssetImage.svelte";
    import InlineActions from "./InlineActions.svelte";
    import RenderedSource from "./RenderedSource.svelte";

    let {
        text,
        /**
         * True for a concept the host wants emphasised — the page whose references are shown.
         * Absent when the host is not highlighting, in which case every link reads the same.
         */
        matches,
        /**
         * The wikilinks' test id. Defaults to the Backlinks panel's, the only surface
         * mounting this today and what its e2e suite keys on; a second host passes its own.
         */
        wikilinkTestId = "backlinks-wikilink",
    }: {
        text: string;
        matches?: (concept: string) => boolean;
        wikilinkTestId?: string;
    } = $props();

    const parts = $derived(inlineParts(text));

    /** Each file link's cluster, by part index: the link text shares its copy button's tick. */
    let fileLinkClusters: (InlineActions | undefined)[] = $state([]);

    /** A file link's one action, from its text or its keyboard: the same Command the button runs. */
    function copyFileLink(index: number, event: Event) {
        event.stopPropagation();
        void fileLinkClusters[index]?.trigger(LINK_COPY_PATH);
    }

    function download(ref: string) {
        runAssetCommand(ASSET_DOWNLOAD, { kind: "asset", ref });
    }

    /** One class per mark, styled below as markdown-format.ts styles it. */
    function markClasses(marks: readonly InlineMark[]): string {
        return marks.map((mark) => `md-${mark}`).join(" ");
    }

    /** A wikilink's one action, from a click or from Enter: open the concept it names. */
    function openWikilink(concept: string, event: Event) {
        // These sit inside a clickable reference row; a link's activation is about the link.
        event.stopPropagation();
        void openConcept(concept);
    }

    /** Right-click and long press on a reference raise the same actions its icons offer. */
    function assetMenu(ref: string) {
        return (node: HTMLElement) => attachContextMenu(node, () => ({ kind: "asset", ref }));
    }
</script>

<!-- One part's markup. No whitespace between tags anywhere here: this is inline flow, and a
     stray space would render. -->
{#snippet body(part: InlinePart, i: number)}{#if part.kind === "text"}{part.text}{:else if part.kind === "math"}<RenderedSource
            info="math"
            source={part.tex}
            inline>{part.text}</RenderedSource
        >{:else if part.kind === "wikilink"}<!-- Inline text in the link role, not a <button>: a button is one box, so a long
             link dropped whole onto its own line, wrapped inside the box with its text centred,
             and covered the row, leaving no body to click. The editor's link is inline text. --><span
            role="link"
            tabindex="0"
            class="wikilink"
            class:wikilink--missing={conceptIsMissing(part.concept)}
            class:wikilink--match={matches?.(part.concept) ?? false}
            data-testid={wikilinkTestId}
            data-concept={part.concept}
            onclick={(event) => openWikilink(part.concept, event)}
            onkeydown={(event) => {
                // A link's keyboard half: Enter, not Space, which a link leaves to scrolling.
                if (event.key !== "Enter") return;
                event.preventDefault();
                openWikilink(part.concept, event);
            }}>{part.text}</span
        >{:else if part.kind === "link"}<a
            class="hyperlink"
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="reference-hyperlink"
            onclick={(event) => event.stopPropagation()}>{part.text}</a
        >{:else if part.kind === "file-link"}<span class="file-link" data-testid="reference-file-link"
            ><span
                class="file-link__label"
                role="button"
                tabindex="0"
                title="Copy path"
                data-file-path={part.path}
                onclick={(event) => copyFileLink(i, event)}
                onkeydown={(event) => {
                    // The keyboard half of being a button, which a span does not get for free.
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    copyFileLink(i, event);
                }}>{part.text}</span
            ><InlineActions
                bind:this={fileLinkClusters[i]}
                kind="file-link"
                subject={part.path}
                actions={fileLinkActions()}
                name={part.path}
                run={(action) => runLinkCommand(action.command, { kind: "file-link", path: part.path })}
            /></span
        >{:else if part.kind === "asset"}<span class="asset" data-testid="reference-asset" {@attach assetMenu(part.ref)}
            ><span
                class="asset__label"
                role="button"
                tabindex="0"
                data-asset-ref={part.ref}
                onclick={(event) => {
                    // A plain click downloads, exactly as a click on an asset link does in the
                    // editor — and through the same Command.
                    event.stopPropagation();
                    download(part.ref);
                }}
                onkeydown={(event) => {
                    // The keyboard half of being a button, which a span does not get for free.
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    download(part.ref);
                }}>{part.text}</span
            ><AssetActions ref={part.ref} /></span
        >{:else}<AssetImage
            url={part.url}
            alt={part.alt}
            maxWidth={part.maxWidth}
            maxHeight={part.maxHeight}
        />{/if}{/snippet}

<!-- Keyed on position and kind, which is all the identity a positional decomposition of one
     string has. It is enough for the case that matters: an `AssetImage` whose slot becomes a
     hyperlink is rebuilt rather than re-pointed. A marked part sits inside one span carrying
     its marks, so a bold link is a link in bold. -->
{#each parts as part, i (`${i}-${part.kind}`)}{#if part.marks}<span class={markClasses(part.marks)}
            >{@render body(part, i)}</span
        >{:else}{@render body(part, i)}{/if}{/each}

<style>
    /* The inline marks, value for value as markdown-format.ts styles `.cm-md-*`. One difference:
       inline code's wash is the code panel's translucent grey rather than `--gk-surface-2`, which
       is the reference card's own background here and would not show. Its size keeps the 14px
       floor every read text keeps. */
    .md-strong {
        font-weight: 700;
    }
    .md-em {
        font-style: italic;
    }
    .md-strike {
        text-decoration: line-through;
    }
    .md-highlight {
        background: var(--gk-highlight-bg, rgba(250, 204, 21, 0.45));
        border-radius: 2px;
        padding: 0.05em 0.15em;
        margin: 0 -0.05em;
    }
    .md-code {
        font-family: var(--gk-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: max(0.875rem, 0.86em);
        background: var(--gk-code-bg, rgba(127, 127, 127, 0.1));
        border-radius: 4px;
        padding: 0.1em 0.4em;
        margin: 0 0.1em;
    }

    /* Wikilinks keep exactly the styling the panel gave them before this component existed, so
       adopting it changed nothing about how an existing reference reads. */
    .wikilink,
    .hyperlink,
    .asset__label {
        border: 0;
        background: transparent;
        padding: 0;
        font: inherit;
        cursor: pointer;
        color: var(--gk-accent, #2563eb);
        text-decoration: underline;
    }
    .wikilink:hover,
    .hyperlink:hover,
    .asset__label:hover {
        color: var(--gk-accent-hover, #1d4ed8);
    }
    /* Missing target: link colour like any other wikilink, marked only by a dashed underline. */
    .wikilink--missing {
        text-decoration-style: dashed;
    }
    /* The concept being viewed, emphasised among the other links. */
    .wikilink--match {
        font-weight: 600;
    }
    /* A long link wraps anywhere, as the text around it does. */
    .wikilink {
        overflow-wrap: anywhere;
    }
    .wikilink:focus-visible {
        outline: 2px solid var(--gk-accent, #2563eb);
        outline-offset: 1px;
    }
    /* Plain inline flow, as the editor's link and its trailing widget are: the label wraps like
       any other text and the icons follow its LAST word, wherever that falls — not the far corner
       of a box. The 4px is the editor's `marginLeft` on the same cluster. `touch-action` /
       `user-select` are the long-press contract's, or iOS Safari's callout takes the gesture first. */
    .asset {
        touch-action: manipulation;
        user-select: none;
    }
    .asset__label {
        overflow-wrap: anywhere;
    }
    /* A file link, as the editor draws it: underlined in the text colour, never the link colour,
       because a click copies its path rather than opening anything (CONTEXT.md → File Link). */
    .file-link__label {
        border: 0;
        background: transparent;
        padding: 0;
        font: inherit;
        color: inherit;
        text-decoration: underline;
        cursor: pointer;
        overflow-wrap: anywhere;
    }
    .file-link__label:focus-visible {
        outline: 2px solid var(--gk-accent, #2563eb);
        outline-offset: 1px;
    }
    .asset :global(.actions),
    .file-link :global(.actions) {
        margin-left: 4px;
    }
    /* The editor's three-step shading: quiet at rest, brighter while the pointer is on the row
       (the host sets `--gk-asset-actions-opacity` for that), full when on the reference itself or
       an icon has focus. Always visible where there is no hover to wait for. */
    .asset :global(.actions),
    .file-link :global(.actions) {
        opacity: var(--gk-asset-actions-opacity, 0.45);
        transition: opacity 120ms ease;
    }
    .asset:hover :global(.actions),
    .asset :global(.actions:focus-within),
    .file-link:hover :global(.actions),
    .file-link :global(.actions:focus-within) {
        opacity: 1;
    }
    @media (hover: none) {
        .asset :global(.actions),
        .file-link :global(.actions) {
            opacity: 1;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .asset :global(.actions),
        .file-link :global(.actions) {
            transition: none;
        }
    }
</style>
