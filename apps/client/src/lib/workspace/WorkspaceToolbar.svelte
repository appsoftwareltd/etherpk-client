<script lang="ts">
    /**
     * The desktop workspace toolbar: the two Sidebar toggles, and after the left one a heading
     * that says what is open: its name, then two icons for what kind of thing it is and where it
     * is kept (workspace-heading.ts, KindIcons.svelte).
     *
     * Rendered by the desktop presenter only. The mobile presenter carries its own chrome.
     *
     * The toggles are drawn as the Activity Bar's icons are: an icon alone, with no border or fill,
     * each in the column of the Activity Bar's icons when the bar is under it. With nothing but
     * the two of them to press, a border round each only added weight.
     *
     * It holds nothing else to press. Settings and Keyboard shortcuts are rows of the Activity
     * Bar's menu (sidebar-commands.ts), Tasks is an icon of the Activity Bar, and a synced
     * graph's status dot is in the app's header, beside the logo, as it is on a phone
     * (HeaderGraphStatus.svelte).
     *
     * The indexing icon is a status light, and not a control: it shows while the search index
     * takes in a change a person may be waiting on, such as a rename, so that a link or Quick
     * Find not following yet reads as "still working" rather than as a fault. It sits after the
     * spacer, so its coming and going moves neither toggle.
     */

    import SidebarToggleIcon from '#lib/layout/renderers/SidebarToggleIcon.svelte'

    import KindIcons from './KindIcons.svelte'
    import { headingText, type WorkspaceHeading } from './workspace-heading'

    let {
        ontoggleleft,
        ontoggleright,
        heading,
        indexing = false,
        leftLabel = 'Toggle document tree',
        rightLabel = 'Toggle backlinks',
    }: {
        ontoggleleft: () => void
        ontoggleright: () => void
        /** What is open: its name once that is known, and its kind. */
        heading: WorkspaceHeading
        /** The search index is busy with work worth showing (workspace/indexing-indicator.ts). */
        indexing?: boolean
        /** What the left toggle shows and hides, where it is not the graph's document tree. */
        leftLabel?: string
        /** What the right toggle shows and hides, where it is not Backlinks. */
        rightLabel?: string
    } = $props()
</script>

<div class="toolbar" data-testid="ws-toolbar">
    <button
        type="button"
        class="gk-icon-button toggle"
        data-testid="ws-toggle-left"
        onclick={ontoggleleft}
        aria-label={leftLabel}
    >
        <SidebarToggleIcon side="left" />
    </button>
    <!-- The name on one line, clipped where the window is too narrow for it. The whole of it is
         the heading's text, so a screen reader and a search of the page have the name in full.
         While the name is not known the heading is the kind in words. The icons are never clipped. -->
    <h1 class="heading" data-testid="ws-heading" data-named={heading.name !== null}>{headingText(heading)}</h1>
    <span class="kind"><KindIcons kind={heading.kind} coloured /></span>
    <span class="spacer"></span>
    {#if indexing}
        <!-- Not a live region: indexing comes and goes with every rename, and announcing each
             would be noise. The label names it for anyone who reaches it with a screen reader. -->
        <span
            class="indexing"
            role="img"
            aria-label="Updating the search index"
            data-tooltip="Updating the search index. Search, links and backlinks catch up when it finishes."
            data-testid="ws-indexing"
        >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <circle cx="12" cy="12" r="8.25" opacity="0.25" />
                <path stroke-linecap="round" d="M20.25 12A8.25 8.25 0 0 0 12 3.75" />
            </svg>
        </span>
    {/if}
    <button
        type="button"
        class="gk-icon-button toggle"
        data-testid="ws-toggle-right"
        onclick={ontoggleright}
        aria-label={rightLabel}
    >
        <SidebarToggleIcon side="right" />
    </button>
</div>

<style>
    /* It has no surface of its own, so it takes the ink that reads on the graph's toolbar colour
       when one is set (toolbar-accent.ts), and otherwise the theme's strong text. It gives way
       before the buttons do: a long name is clipped, and the toggles keep their place. */
    .heading {
        flex: 0 1 auto;
        min-width: 0;
        margin: 0;
        overflow: hidden;
        color: var(--gk-toolbar-ink, var(--gk-text-strong));
        font-size: 0.875rem;
        font-weight: 600;
        line-height: 1.25rem;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* The same box as a button beside it, without the border and fill that invite a click. It has no
       surface of its own, so it is drawn in the ink that reads on the graph's toolbar colour when one
       is set (toolbar-accent.ts), and otherwise in the theme's muted grey: grey on a light toolbar,
       light on a dark one. */
    /* The icons sit 6px after the name, as they do on a Graphs page card: the toolbar's 8px gap,
       less 2. They take the heading's ink a step quieter, where the theme has a quieter one. */
    .kind {
        display: inline-flex;
        flex: none;
        margin-left: -0.125rem;
        color: var(--gk-toolbar-ink, var(--gk-text-muted));
    }
    .indexing {
        display: inline-flex;
        justify-content: center;
        align-items: center;
        /* A 20px ring in a 32px box. */
        padding: 0.375rem;
        color: var(--gk-toolbar-ink, var(--gk-text-muted));
    }
    .indexing > svg {
        width: 1.25rem;
        height: 1.25rem;
        display: block;
        animation: indexing-spin 0.9s linear infinite;
    }
    @keyframes indexing-spin {
        to {
            transform: rotate(360deg);
        }
    }
    /* Still, the ring with its brighter arc reads as "in progress" without the turn. */
    @media (prefers-reduced-motion: reduce) {
        .indexing > svg {
            animation: none;
        }
    }

    .toolbar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.25rem 0.5rem;
        border-bottom: 1px solid var(--gk-border-soft);
        /* The graph's own colour when one is set (Graph Settings → Toolbar colour, ADR 0071),
           set as a custom property on the workspace root; the theme surface otherwise. What is
           drawn on it has no surface of its own, and takes the ink that reads on the colour. */
        background: var(--gk-toolbar-accent, var(--gk-surface-0));
    }
    .spacer {
        flex: 1;
    }
    /* A Sidebar toggle is an icon button with no border or fill, as an icon of the Activity Bar is:
       a 32px square, 8px in from the toolbar's end, so it stands in the column of the bar's icons.
       Its icon is muted until the pointer is over it. On a graph's toolbar colour it takes the ink
       that reads on that colour, and the pointer lights it with a wash of the same ink. */
    .toolbar > .toggle {
        flex: none;
        color: var(--gk-toolbar-ink, var(--gk-text-muted));
    }
    .toolbar > .toggle:hover {
        background: var(--gk-toolbar-hover, var(--gk-menu-hover));
        color: var(--gk-toolbar-ink, var(--gk-text-strong));
    }
    /* An icon that stands away from text is 20px, the size of the Activity Bar's icons. */
    .toolbar :global(.gk-icon-button > svg) {
        width: 1.25rem;
        height: 1.25rem;
        display: block;
    }
</style>
