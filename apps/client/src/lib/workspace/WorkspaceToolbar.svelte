<script lang="ts">
    /**
     * The desktop workspace toolbar: the two Sidebar toggles, Docs, Keyboard Shortcuts, the
     * Settings cog and Tasks.
     *
     * Rendered by the desktop presenter only. The mobile presenter carries its own chrome, and
     * the Sidebar offers Settings from the drawer there (`graph.settings.open`).
     *
     * The [[Local Mirror]]'s button used to live here and moved to the Settings modal's Mirror
     * tab, which can say where the copy is going. What comes back here is smaller and different:
     * a state dot, not a control. A mirror writes to a folder nothing on screen shows, and after
     * a browser restart it usually needs its permission back - so with the tab as the only place
     * that says anything, a stopped backup looked exactly like a working one. The dot answers
     * "is my copy current?" without opening anything, and opens the tab when there is something
     * to do about it.
     *
     * A synced graph also shows its sync chip beside the document tree toggle: whether edits have
     * reached the Sync Server. On the left, before the spacer, so a label that changes length
     * moves nothing else in the bar.
     */
    import { PUBLIC_DOCS_URL } from '@appsoftwareltd/etherpk-shared'

    import SidebarToggleIcon from '$lib/layout/renderers/SidebarToggleIcon.svelte'
    import type { SyncChipAction, SyncIndicator } from '$lib/sync/sync-indicator'
    import SyncStateChip from '$lib/sync/ui/SyncStateChip.svelte'

    import type { MirrorIndicator } from './mirror-indicator'

    let {
        ontoggleleft,
        ontoggleright,
        onshortcuts,
        onsettings,
        ontasks,
        onreset,
        mirror = { state: 'hidden' },
        sync = null,
    }: {
        ontoggleleft: () => void
        ontoggleright: () => void
        onshortcuts: () => void
        onsettings: () => void
        ontasks: () => void
        /** Reset workspace: opens the confirmation, never resets on its own. */
        onreset: () => void
        mirror?: MirrorIndicator
        /** A synced graph's sync state; null for a folder graph, which has no server to reach. */
        sync?: { indicator: SyncIndicator | null; actions: SyncChipAction[] } | null
    } = $props()
</script>

<div class="toolbar" data-testid="ws-toolbar">
    <button
        class="toggle"
        title="Toggle document tree"
        data-testid="ws-toggle-left"
        onclick={ontoggleleft}
        aria-label="Toggle document tree"
    >
        <SidebarToggleIcon side="left" />
    </button>
    {#if sync}
        <SyncStateChip indicator={sync.indicator} actions={sync.actions} />
    {/if}
    <span class="spacer"></span>
    {#if mirror.state !== 'hidden'}
        <button
            class="toggle mirror"
            title={mirror.title}
            aria-label={mirror.title}
            data-testid="ws-mirror-state"
            data-state={mirror.state}
            onclick={mirror.onclick}
        >
            <span class="dot" class:spin={mirror.state === 'writing'}></span>
        </button>
    {/if}
    <!-- The published docs, in a new tab. A link rather than a button because it leaves the
         app, but drawn as one of the toolbar's own so the reference material reads as a group:
         docs, then the shortcuts card, then the cog. heroicons/outline book-open. -->
    <a
        class="toggle"
        href={PUBLIC_DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        title="Documentation"
        aria-label="Documentation (opens in a new tab)"
        data-testid="ws-docs"
    >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
        </svg>
    </a>
    <!-- The keyboard-shortcuts card. Beside the cog because that is where a user looks for
         "how does this thing work", but its own button: it is a reference, not a setting. -->
    <button
        class="toggle"
        title="Keyboard shortcuts"
        aria-label="Keyboard shortcuts"
        data-testid="ws-keyboard-shortcuts"
        onclick={onshortcuts}
    >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <rect x="2.25" y="5.25" width="19.5" height="13.5" rx="2" />
            <path stroke-linecap="round" d="M6 9h.01M9.5 9h.01M13 9h.01M16.5 9h.01M6 12h.01M9.5 12h.01M13 12h.01M16.5 12h.01M18 9h.01M18 12h.01M8 15h8" />
        </svg>
    </button>
    <button
        class="toggle"
        title="Graph name and settings"
        aria-label="Graph name and settings"
        data-testid="ws-graph-settings"
        onclick={onsettings}
    >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </svg>
    </button>
    <!-- heroicons/outline arrow-path. Reset workspace sits with the two other whole-workspace
         controls (shortcuts, settings) rather than beside the Sidebar pair. -->
    <button
        class="toggle"
        title="Reset workspace"
        aria-label="Reset workspace"
        data-testid="ws-reset-workspace"
        onclick={onreset}
    >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
        </svg>
    </button>
    <!-- heroicons/outline clipboard-document-check. Sits immediately before the Sidebar
         toggle: it opens a View INTO that Sidebar, so the two read as a pair. -->
    <button
        class="toggle"
        title="Tasks"
        aria-label="Tasks"
        data-testid="ws-tasks"
        onclick={ontasks}
    >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M11.35 3.836c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m8.9-4.414c.376.023.75.05 1.124.08 1.131.094 1.976 1.057 1.976 2.192V16.5A2.25 2.25 0 0 1 18 18.75h-2.25m-7.5-10.5H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V18.75m-7.5-10.5h6.375c.621 0 1.125.504 1.125 1.125v9.375m-8.25-3 1.5 1.5 3-3.75" />
        </svg>
    </button>
    <button
        class="toggle"
        title="Toggle backlinks"
        data-testid="ws-toggle-right"
        onclick={ontoggleright}
        aria-label="Toggle backlinks"
    >
        <SidebarToggleIcon side="right" />
    </button>
</div>

<style>
    /* The button is one of the toolbar's own, the same box as the four beside it. What differs
       is only what sits inside: a dot, because this one reports rather than invites. */
    .mirror .dot {
        width: 1.1rem;
        height: 1.1rem;
        display: block;
        border-radius: 9999px;
        background: currentColor;
        /* Inset so the dot reads as a status light within the button, not as a filled button. */
        transform: scale(0.5);
    }
    .mirror[data-state='current'] {
        color: var(--gk-mirror-ok, #16a34a);
    }
    /* Amber, not blue: writing is a transient "not settled yet", which is the same thing every
       other warning on the Mirror tab says, and blue read as an informational badge. */
    .mirror[data-state='writing'] {
        color: var(--gk-mirror-busy, #d97706);
    }
    .mirror[data-state='paused'] {
        color: var(--gk-mirror-stopped, #dc2626);
    }
    .mirror[data-state='waiting'] {
        color: var(--gk-mirror-idle, #9ca3af);
    }
    .mirror .dot.spin {
        animation: mirror-pulse 1.4s ease-in-out infinite;
    }
    @keyframes mirror-pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.35;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .mirror .dot.spin {
            animation: none;
        }
    }

    .toolbar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.3rem 0.5rem;
        border-bottom: 1px solid var(--gk-border-soft);
        /* The graph's own colour when one is set (Graph Settings → Toolbar colour, ADR 0071),
           set as a custom property on the workspace root; the theme surface otherwise. The
           buttons keep their own surface, so their icons stay legible whatever is picked. */
        background: var(--gk-toolbar-accent, var(--gk-surface-0));
    }
    .spacer {
        flex: 1;
    }
    .toggle {
        display: inline-flex;
        justify-content: center;
        align-items: center;
        padding: 0.3rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 6px;
        background: var(--gk-surface-1);
        color: inherit;
        font: inherit;
        cursor: pointer;
        /* The docs link shares the class; an anchor would otherwise underline and recolour. */
        text-decoration: none;
    }
    .toggle:hover {
        background: var(--gk-surface-2, rgba(127, 127, 127, 0.12));
    }
    .toggle > svg {
        width: 1.1rem;
        height: 1.1rem;
        display: block;
    }
</style>
