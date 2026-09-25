<script lang="ts">
    import LoadingSweep from '$lib/components/LoadingSweep.svelte'

    import type { MissingGraphDiagnosis } from './graph-availability'

    let {
        phase,
        loadingStep,
        indexed,
        message,
        missing = null,
        settingUp = false,
        setupError = null,
        shareWaiting = false,
        shareLanded = false,
        ongrant,
        onback,
        onretry,
        onsetup,
    }: {
        phase: 'loading' | 'needs-permission' | 'needs-unlock' | 'ready' | 'missing' | 'error'
        loadingStep: 'opening' | 'loading' | 'indexing'
        indexed: { done: number; total: number } | null
        message: string
        /** Why the registry had no usable record, once the `missing` phase has worked it out. */
        missing?: MissingGraphDiagnosis | null
        /** "Set it up here" is running: the registry write and the open that follows. */
        settingUp?: boolean
        /** Why "Set it up here" failed, in user copy. */
        setupError?: string | null
        /**
         * A [[Share Target]] share is waiting for this graph (ADR 0087). A stalled open says the
         * text is safe and will land once the graph opens; a failed one says where to take it.
         */
        shareWaiting?: boolean
        /** The waiting share has been added to Quick notes while the rest of the open carries on. */
        shareLanded?: boolean
        ongrant: () => void
        onback: () => void
        /** Retry the open that failed. Absent means only "back" is offered. */
        onretry?: () => void
        /** Register the graph on this device and open it (`missing.kind === 'available'`). */
        onsetup?: () => void
    } = $props()
</script>

<!-- The shared text is in sessionStorage, not on this page, so the notice has to say it is safe
     (rule 4 of the interaction standard): waiting behind a prompt, or waiting for another graph. -->
{#snippet shareWaits()}
    {#if shareWaiting}
        <p data-testid="share-waiting" class="notice__share">
            The text you shared will go into Quick notes once the graph opens.
        </p>
    {/if}
{/snippet}

{#snippet shareStranded()}
    {#if shareWaiting}
        <p data-testid="share-waiting" class="notice__share">
            The text you shared is still waiting. <a href="/share" data-testid="share-choose-another">Choose another graph</a>
        </p>
    {/if}
{/snippet}

{#if phase === 'loading'}
    <div class="notice" data-testid="graph-loading">
        <LoadingSweep label="Opening your graph" />
        <!-- The share lands as soon as the graph's store is reachable, before the index and the
             presenter, so the line flips to "Added" while the sweep is still running. -->
        {#if shareLanded}
            <p data-testid="share-landed" class="notice__share">Added to Quick notes.</p>
        {:else if shareWaiting}
            <p data-testid="share-waiting" class="notice__share">Adding the text you shared to Quick notes…</p>
        {/if}
        {#if loadingStep !== 'opening' && indexed}
            <!-- The count changes per document; inside a live region that is a running
                 commentary. The <progress> beside it carries the same numbers on demand. -->
            <p aria-hidden="true" data-testid="graph-loading-indexing">
                {loadingStep === 'loading' ? 'Loading' : 'Indexing'}
                {indexed.done.toLocaleString()} of {indexed.total.toLocaleString()} documents…
            </p>
            <progress
                max={indexed.total}
                value={indexed.done}
                aria-label={loadingStep === 'loading' ? 'Loading documents' : 'Indexing documents'}
            ></progress>
        {:else}
            <p role="status">Opening your graph…</p>
        {/if}
    </div>
{:else if phase === 'missing'}
    <!-- One registry miss, several causes (graph-availability.ts). The notice names the one
         that applies, because "not in this browser" sent a user whose graph the server still
         listed towards Reset (2026-09-01), when the fix was the registry write below. -->
    <div class="notice" data-testid="graph-missing" data-kind={missing?.kind ?? 'unknown'}>
        {#if missing?.kind === 'available'}
            <h2>This graph is on your account but not set up in this browser.</h2>
            <p>
                The sync server lists you as {missing.role === 'owner' ? 'its owner' : 'a member'}.
                Setting it up here registers it in this browser and your notes sync down as usual.
                Nothing is deleted{missing.staleRecord
                    ? '; the details this browser held for it under another sign-in are replaced.'
                    : '.'}
            </p>
            {#if setupError}
                <p role="alert" class="notice__error">{setupError}</p>
            {/if}
            <div class="notice__actions">
                <button data-testid="graph-setup-here" onclick={onsetup} disabled={settingUp}>
                    {settingUp ? 'Setting up…' : 'Set it up here'}
                </button>
                <button onclick={onback}>Back to graphs</button>
            </div>
        {:else if missing?.kind === 'other-account'}
            <h2>This graph was set up here under a different sync account.</h2>
            <p>
                The account connected now is not a member of it. Connect the other account in Sync
                settings on the Graphs page, or ask the graph's owner to invite this one.
            </p>
            <button onclick={onback}>Back to graphs</button>
        {:else if missing?.kind === 'not-a-member'}
            <h2>That graph is not in this browser.</h2>
            <p>
                Your sync account is not a member of it either. If someone shared it with you,
                accept their invite on the Graphs page.
            </p>
            <button onclick={onback}>Back to graphs</button>
        {:else if missing?.kind === 'unknown' && missing.reason === 'server-unreachable'}
            <h2>That graph is not in this browser.</h2>
            <p>
                The sync server could not be reached to check whether it is on your account. Check
                your connection, then try again.
            </p>
            <div class="notice__actions">
                {#if onretry}
                    <button data-testid="graph-missing-retry" onclick={onretry}>Try again</button>
                {/if}
                <button onclick={onback}>Back to graphs</button>
            </div>
        {:else}
            <h2>That graph is not in this browser.</h2>
            <p>
                If it is a synced graph, connect your sync server in Sync settings on the Graphs
                page and add it to this device from there.
            </p>
            <button onclick={onback}>Back to graphs</button>
        {/if}
        {@render shareStranded()}
    </div>
{:else if phase === 'needs-permission'}
    <div class="notice" data-testid="graph-needs-permission">
        <p>EtherPK needs permission to read and write this graph's folder.</p>
        <button data-testid="graph-grant" onclick={ongrant}>Grant access</button>
        {@render shareWaits()}
    </div>
{:else if phase === 'needs-unlock'}
    <div class="notice" data-testid="graph-needs-unlock">
        <h2>Unlock your notes</h2>
        <p>Enter your Recovery Code to unlock the encryption keys on this device.</p>
        {@render shareWaits()}
    </div>
{:else if phase === 'error'}
    <div class="notice" data-testid="graph-error" role="alert">
        <!-- `message` is already a full sentence from sync-error-copy.ts: what happened,
             why, what next. Prefixing it here produced "Could not open the graph: Could not
             open the graph." -->
        <p>{message}</p>
        <!-- The notice covers the whole workspace, so with no controls the only way out was
             the browser's back button. -->
        <div class="notice__actions">
            {#if onretry}
                <button data-testid="graph-error-retry" onclick={onretry}>Try again</button>
            {/if}
            <button data-testid="graph-error-back" onclick={onback}>Back to graphs</button>
        </div>
        {@render shareStranded()}
    </div>
{/if}

<style>
    .notice {
        position: fixed;
        inset: 3.5rem 0 0 0;
        display: grid;
        place-content: center;
        gap: 0.75rem;
        text-align: center;
        color: var(--gk-text-default);
        max-width: 32rem;
        margin: 0 auto;
        padding: 1rem;
    }
    .notice h2 {
        font-size: 1.05rem;
        font-weight: 600;
        margin: 0;
    }
    .notice p {
        margin: 0;
    }
    .notice__error {
        color: var(--gk-text-danger, #b91c1c);
    }
    .notice__share {
        color: var(--gk-text-subtle, #6b7280);
    }
    .notice__share a {
        color: inherit;
        text-decoration: underline;
    }
    .notice :global(.loading-sweep) {
        margin: 0 auto;
    }
    .notice progress {
        width: 100%;
        max-width: 20rem;
        margin: 0 auto;
    }
    .notice__actions {
        display: flex;
        gap: 0.5rem;
        justify-content: center;
    }
    .notice button {
        border: 1px solid var(--gk-border-soft);
        border-radius: 6px;
        padding: 0.35rem 0.75rem;
        background: var(--gk-surface-1);
        color: inherit;
        cursor: pointer;
    }
    .notice button:disabled {
        opacity: 0.6;
        cursor: default;
    }
</style>
