<script lang="ts">
    /**
     * The desktop workspace toolbar: the two Sidebar toggles, Keyboard Shortcuts, the
     * Settings cog and Tasks.
     *
     * Rendered by the desktop presenter only. The mobile presenter carries its own chrome, and
     * the Sidebar offers Settings from the drawer there (`graph.settings.open`).
     *
     * The status dot is a synced graph's one answer to "is my work safe?": sync and the
     * [[Local Mirror]] together (graph-status.ts). It is green only when every part that applies
     * is working, and opens a dialog with a section for each. A mirror writes to a folder nothing
     * on screen shows, and after a browser restart it usually needs its permission back, so a
     * stopped one must show here. When sync stops in a way the person should hear about, a notice
     * hangs under the dot until they close it. A folder graph has no dot.
     *
     * Reset workspace has no button here: an icon alone does not say what it does, and a circle
     * of arrows reads as "reload". It is a named row at the foot of the Explorer, beside
     * Settings, and a Command.
     *
     * The indexing icon is a status light too, and not a control: it shows while the search index
     * takes in a change a person may be waiting on, such as a rename, so that a link or Quick
     * Find not following yet reads as "still working" rather than as a fault. It sits first after
     * the spacer, so its coming and going moves no button.
     */

    import type { Snippet } from 'svelte'

    import { withChord } from '#lib/surface/control-help.js'
    import SidebarToggleIcon from '#lib/layout/renderers/SidebarToggleIcon.svelte'

    import type { GraphStatus, StatusCallout as Callout } from './graph-status'
    import StatusCallout from './StatusCallout.svelte'

    let {
        ontoggleleft,
        ontoggleright,
        onshortcuts,
        onsettings,
        ontasks,
        status = { shown: false },
        callout = null,
        onstatus,
        ondismisscallout,
        indexing = false,
        leftLabel = 'Toggle document tree',
        settingsLabel = 'Graph name and settings',
        rightLabel = 'Toggle backlinks',
        lead,
        chord = () => null,
    }: {
        ontoggleleft: () => void
        ontoggleright: () => void
        onshortcuts: () => void
        /** Open the settings. Without it the cog is not drawn. */
        onsettings?: () => void
        /** Open Tasks. Without it the button is not drawn: a [[Plain Folder]] has no Tasks View. */
        ontasks?: () => void
        /** Sync and the Local Mirror together; not shown on a graph that has neither. */
        status?: GraphStatus
        /** The notice under the dot, already less whatever the person closed. */
        callout?: Callout | null
        /** Open the status dialog. */
        onstatus?: () => void
        ondismisscallout?: () => void
        /** The search index is busy with work worth showing (workspace/indexing-indicator.ts). */
        indexing?: boolean
        /** What the left toggle shows and hides, where it is not the graph's document tree. */
        leftLabel?: string
        /** What the cog opens, where it is not a graph's settings. */
        settingsLabel?: string
        /** What the right toggle shows and hides, where it is not Backlinks. */
        rightLabel?: string
        /** What is open, after the left toggle: a [[Plain Folder]]'s name and what it is. A graph draws none. */
        lead?: Snippet
        /** The shortcut a tooltip names for a Command, or null. */
        chord?: (command: string) => string | null
    } = $props()

    /** The shortcut for a screen reader, which the tooltip says after the name. */
    const described = (command: string) => {
        const named = chord(command)
        return named === null ? undefined : `Shortcut: ${named}`
    }
</script>

<div class="toolbar" data-testid="ws-toolbar">
    <button
        type="button"
        class="gk-icon-button gk-button--raised"
        data-testid="ws-toggle-left"
        onclick={ontoggleleft}
        aria-label={leftLabel}
    >
        <SidebarToggleIcon side="left" />
    </button>
    {#if lead}{@render lead()}{/if}
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
    {#if status.shown}
        <!-- The wrapper is what the notice hangs from. -->
        <span class="status-wrap">
            <button
                class="gk-icon-button gk-button--raised status"
                data-tooltip={status.title} aria-description={status.title}
                aria-label={`Sync status. ${status.title}`}
                aria-haspopup="dialog"
                data-testid="graph-status"
                data-state={status.tone}
                data-sync-state={status.sync?.state ?? 'pending'}
                data-mirror-state={status.mirror?.state ?? 'none'}
                data-unsent={status.sync?.unsent ?? 0}
                onclick={onstatus}
            >
                <span class="dot"></span>
            </button>
            {#if callout && ondismisscallout}
                <StatusCallout {callout} align="end" ondismiss={ondismisscallout} />
            {/if}
        </span>
    {/if}
    <!-- The keyboard-shortcuts card. Beside the cog because that is where a user looks for
         "how does this thing work", but its own button: it is a reference, not a setting. -->
    <button
        type="button"
        class="gk-icon-button gk-button--raised"
        data-tooltip={withChord("Keyboard shortcuts", chord('help.openShortcuts'))}
        aria-description={described('help.openShortcuts')}
        aria-label="Keyboard shortcuts"
        data-testid="ws-keyboard-shortcuts"
        onclick={onshortcuts}
    >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <rect x="2.25" y="5.25" width="19.5" height="13.5" rx="2" />
            <path stroke-linecap="round" d="M6 9h.01M9.5 9h.01M13 9h.01M16.5 9h.01M6 12h.01M9.5 12h.01M13 12h.01M16.5 12h.01M18 9h.01M18 12h.01M8 15h8" />
        </svg>
    </button>
    {#if onsettings}
    <button
        type="button"
        class="gk-icon-button gk-button--raised"
        data-tooltip={settingsLabel}
        aria-label={settingsLabel}
        data-testid="ws-graph-settings"
        onclick={onsettings}
    >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
    </button>
    {/if}
    <!-- heroicons/outline clipboard-document-check. Sits immediately before the Sidebar
         toggle: it opens a View INTO that Sidebar, so the two read as a pair. -->
    {#if ontasks}
    <button
        type="button"
        class="gk-icon-button gk-button--raised"
        data-tooltip={withChord("Tasks", chord('tasks.open'))}
        aria-description={described('tasks.open')}
        aria-label="Tasks"
        data-testid="ws-tasks"
        onclick={ontasks}
    >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M11.35 3.836c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m8.9-4.414c.376.023.75.05 1.124.08 1.131.094 1.976 1.057 1.976 2.192V16.5A2.25 2.25 0 0 1 18 18.75h-2.25m-7.5-10.5H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V18.75m-7.5-10.5h6.375c.621 0 1.125.504 1.125 1.125v9.375m-8.25-3 1.5 1.5 3-3.75" />
        </svg>
    </button>
    {/if}
    <button
        type="button"
        class="gk-icon-button gk-button--raised"
        data-testid="ws-toggle-right"
        onclick={ontoggleright}
        aria-label={rightLabel}
    >
        <SidebarToggleIcon side="right" />
    </button>
</div>

<style>
    /* The button is one of the toolbar's own, the same box as the four beside it. What differs
       is only what sits inside: a dot, because this one reports rather than invites. */
    .status .dot {
        width: 1.1rem;
        height: 1.1rem;
        display: block;
        border-radius: 9999px;
        background: currentColor;
        /* Inset so the dot reads as a status light within the button, not as a filled button. */
        transform: scale(0.5);
    }
    .status[data-state='ok'] {
        color: var(--gk-mirror-ok, #16a34a);
    }
    /* Amber, not blue: busy is a transient "not settled yet", and blue read as an informational badge.
       It does not pulse: the colour is enough, and a light that moves only distracts (Style Guide, Motion). */
    .status[data-state='busy'] {
        color: var(--gk-mirror-busy, #d97706);
    }
    .status[data-state='stopped'] {
        color: var(--gk-mirror-stopped, #dc2626);
    }
    .status[data-state='idle'] {
        color: var(--gk-mirror-idle, #a3a3a3);
    }
    .status-wrap {
        position: relative;
        display: inline-flex;
    }

    /* The same box as a button beside it, without the border and fill that invite a click. It has no
       surface of its own, so it is drawn in the ink that reads on the graph's toolbar colour when one
       is set (toolbar-accent.ts), and otherwise in the theme's muted grey: grey on a light toolbar,
       light on a dark one. */
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
           set as a custom property on the workspace root; the theme surface otherwise. The
           buttons keep their own surface, so their icons stay legible whatever is picked. */
        background: var(--gk-toolbar-accent, var(--gk-surface-0));
    }
    .spacer {
        flex: 1;
    }
    /* The buttons are raised icon buttons ([[Style Guide]], "Icon buttons"): a border, the theme's
       surface and a small shadow, so their icons read over a graph's toolbar colour. An icon that
       stands away from text is 20px. */
    .toolbar :global(.gk-icon-button > svg) {
        width: 1.25rem;
        height: 1.25rem;
        display: block;
    }
</style>
