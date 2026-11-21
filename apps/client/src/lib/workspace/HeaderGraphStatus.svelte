<script lang="ts">
    /**
     * The open graph's status dot in the app's header, to the right of the logo: where a phone
     * shows it, since the workspace has no toolbar there (graph-status-host.svelte.ts). Pressing it
     * opens the same dialog as the toolbar's dot on a desktop.
     */
    import { headerGraphStatus } from './graph-status-host.svelte.js'
    import StatusCallout from './StatusCallout.svelte'

    const host = $derived(headerGraphStatus.current)
</script>

{#if host}
    <span class="wrap">
        <button
            type="button"
            class="status gk-icon-button"
            data-testid="graph-status"
            data-state={host.status.tone}
            data-sync-state={host.status.sync?.state ?? 'pending'}
            data-mirror-state={host.status.mirror?.state ?? 'none'}
            data-unsent={host.status.sync?.unsent ?? 0}
            aria-label={`Sync status. ${host.status.title}`}
            aria-haspopup="dialog"
            onclick={host.open}
        >
            <span class="dot" class:pulse={host.status.tone === 'busy'}></span>
        </button>
        {#if host.callout}
            <StatusCallout callout={host.callout} align="start" ondismiss={host.dismissCallout} />
        {/if}
    </span>
{/if}

<style>
    .wrap {
        position: relative;
        display: inline-flex;
    }
    /* An icon button to press (`gk-icon-button`), around a dot the size of a status light. */
    .dot {
        width: 0.6rem;
        height: 0.6rem;
        border-radius: 9999px;
        background: var(--gk-sync-idle, #737373);
    }
    .status[data-state='ok'] .dot {
        background: var(--gk-sync-ok, #16a34a);
    }
    .status[data-state='busy'] .dot {
        background: var(--gk-sync-busy, #d97706);
    }
    .status[data-state='stopped'] .dot {
        background: var(--gk-sync-stopped, #dc2626);
    }
    .dot.pulse {
        animation: status-pulse 1.4s ease-in-out infinite;
    }
    @keyframes status-pulse {
        50% {
            opacity: 0.4;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .dot.pulse {
            animation: none;
        }
    }
</style>
