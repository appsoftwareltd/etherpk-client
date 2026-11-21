<script lang="ts">
    /**
     * What the graph's status dot opens: a section for sync and one for the [[Local Mirror]], each
     * with its state in a word, the whole sentence, and whatever there is to do about it
     * (graph-status.ts). The dot says only whether everything is working; this says which part is
     * not, and why.
     */
    import Modal from '@appsoftwareltd/etherpk-shared/dialog'

    import type { GraphStatus, GraphStatusActions } from './graph-status'

    let {
        status,
        actions,
        onclose,
    }: {
        status: Extract<GraphStatus, { shown: true }>
        actions: GraphStatusActions
        onclose: () => void
    } = $props()

    const unsentText = $derived(status.sync && status.sync.unsent > 0 ? `${status.sync.unsent.toLocaleString()} unsent` : '')

    function openMirrorSettings() {
        onclose()
        actions.openMirrorSettings()
    }
</script>

<Modal open title="Sync status" testId="graph-status-dialog" {onclose}>
    {#snippet body()}
        <section class="part" data-testid="graph-status-sync" data-state={status.sync?.state ?? 'pending'} data-tone={status.sync?.tone ?? 'busy'}>
            <h3>
                <span class="dot" aria-hidden="true"></span>
                <span class="name">Sync</span>
                <span class="label" data-testid="sync-state-label">{status.sync?.label ?? 'Checking'}</span>
                {#if unsentText}
                    <span class="count" data-testid="sync-state-unsent">{unsentText}</span>
                {/if}
            </h3>
            <p data-testid="sync-state-detail">{status.sync?.detail ?? 'Checking the connection to the sync server.'}</p>
            {#if actions.sync.length > 0}
                <div class="actions">
                    {#each actions.sync as action (action.id)}
                        {#if action.href}
                            <a class="gk-button" data-testid={action.id} href={action.href} target="_blank" rel="noopener noreferrer">{action.label}</a>
                        {:else}
                            <button type="button" class="gk-button" data-testid={action.id} disabled={action.disabled} onclick={() => action.run?.()}>{action.label}</button>
                        {/if}
                    {/each}
                </div>
            {/if}
        </section>

        <section class="part" data-testid="graph-status-mirror" data-state={status.mirror?.state ?? 'none'} data-tone={status.mirror?.tone ?? 'none'}>
            <h3>
                <span class="dot" aria-hidden="true"></span>
                <span class="name">Mirroring</span>
                <span class="label" data-testid="mirror-state-label">{status.mirror?.label ?? 'Not set up'}</span>
            </h3>
            <p data-testid="mirror-state-detail">
                {status.mirror?.detail ?? 'This graph is not mirrored to a folder on this device. A mirror keeps a copy of the graph as Markdown files.'}
            </p>
            <div class="actions">
                <button type="button" class="gk-button" data-testid="graph-status-mirror-settings" onclick={openMirrorSettings}>
                    {status.mirror ? 'Mirror settings' : 'Set up mirroring'}
                </button>
            </div>
        </section>
    {/snippet}

    {#snippet footer()}
        <button type="button" class="gk-button" data-testid="graph-status-close" onclick={onclose}>Close</button>
    {/snippet}
</Modal>

<style>
    .part {
        --part-dot: #a3a3a3;
        font-size: 0.875rem;
        line-height: 1.45;
        color: var(--gk-text-default);
    }
    .part + .part {
        margin-top: 1rem;
        padding-top: 1rem;
        border-top: 1px solid var(--gk-border-soft);
    }
    .part[data-tone='ok'] {
        --part-dot: var(--gk-sync-ok, #16a34a);
    }
    .part[data-tone='busy'] {
        --part-dot: var(--gk-sync-busy, #d97706);
    }
    .part[data-tone='idle'] {
        --part-dot: var(--gk-sync-idle, #737373);
    }
    .part[data-tone='stopped'] {
        --part-dot: var(--gk-sync-stopped, #dc2626);
    }
    h3 {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin: 0 0 0.35rem;
        font-size: 0.875rem;
        font-weight: 600;
    }
    .dot {
        flex: none;
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 9999px;
        background: var(--part-dot);
    }
    .label {
        font-weight: 400;
        color: var(--gk-text-muted);
    }
    .count {
        margin-left: auto;
        font-weight: 400;
        font-variant-numeric: tabular-nums;
        color: var(--gk-text-muted);
    }
    p {
        margin: 0;
    }
    .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-top: 0.75rem;
    }
</style>
