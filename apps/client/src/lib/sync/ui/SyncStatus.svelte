<script lang="ts">
    /**
     * A synced graph's sync status: whether this device's edits have reached the Sync Server, in
     * words, as the last row at the foot of the Graph Sidebar (desktop and the phone's left drawer
     * alike). It used to be a chip in the toolbar and the phone's top bar, which had no room for it.
     *
     * The row says a word or two and how many documents hold changes the server has not
     * acknowledged; pressing it opens a panel with the whole sentence and anything there is to do
     * (restart a plan, try again now, download the unsent changes). The panel is a native popover:
     * it sits in the top layer, so no Sidebar or drawer clips it, and the browser gives it light
     * dismissal and Escape. Nothing is only on hover.
     */
    import type { SyncIndicator, SyncStatusAction } from "../sync-indicator";

    let {
        indicator,
        actions = [],
    }: {
        /** Null until the first state has settled: the row keeps its place and says nothing yet. */
        indicator: SyncIndicator | null;
        actions?: SyncStatusAction[];
    } = $props();

    const panelId = $props.id();
    let trigger = $state<HTMLButtonElement>();
    let panel = $state<HTMLDivElement>();

    const PANEL_MAX_WIDTH = 320;
    const GUTTER = 8;
    /** Between the row and the panel. */
    const GAP = 6;

    /**
     * Place the panel beside the row before it shows. Its width is known from the CSS rule
     * (`min(20rem, 100vw - 16px)`), so the left edge can be clamped to the viewport without a
     * measuring frame in which it would sit at the popover's default centre.
     *
     * The row sits at the foot of the Sidebar, so the panel usually opens upwards. It is anchored
     * by its bottom edge then, so its height need not be measured either. A Sidebar short enough
     * to leave the row in the top half of the viewport opens it downwards instead.
     */
    function place(event: Event) {
        if ((event as ToggleEvent).newState !== "open" || !trigger || !panel) return;
        const rect = trigger.getBoundingClientRect();
        const width = Math.min(PANEL_MAX_WIDTH, window.innerWidth - GUTTER * 2);
        const left = Math.min(Math.max(rect.left, GUTTER), window.innerWidth - width - GUTTER);
        panel.style.left = `${left}px`;
        if (rect.top > window.innerHeight / 2) {
            panel.style.top = "auto";
            panel.style.bottom = `${window.innerHeight - rect.top + GAP}px`;
        } else {
            panel.style.bottom = "auto";
            panel.style.top = `${rect.bottom + GAP}px`;
        }
    }

    function runAction(action: SyncStatusAction) {
        action.run?.();
        panel?.hidePopover();
    }

    const unsentText = $derived(
        indicator && indicator.unsent > 0 ? `${indicator.unsent.toLocaleString()} unsent` : "",
    );
    const accessibleName = $derived(
        indicator ? `Sync: ${indicator.label}. ${indicator.detail}` : "Sync: checking",
    );
</script>

<button
    bind:this={trigger}
    type="button"
    class="status"
    data-testid="sync-state"
    data-state={indicator?.state ?? "pending"}
    popovertarget={panelId}
    aria-label={accessibleName}
    title={indicator?.detail}
>
    <!-- The dot sits in a box the size of the footer rows' icons, so the labels line up. -->
    <span class="icon" aria-hidden="true"><span class="dot"></span></span>
    <span class="label">{indicator?.label ?? ""}</span>
    {#if unsentText}
        <span class="count" data-testid="sync-state-unsent">{unsentText}</span>
    {/if}
</button>

<div
    bind:this={panel}
    id={panelId}
    popover="auto"
    class="panel"
    data-testid="sync-state-panel"
    onbeforetoggle={place}
>
    <p class="detail" data-testid="sync-state-detail">
        {indicator?.detail ?? "Checking the connection to the sync server."}
    </p>
    {#if actions.length > 0}
        <div class="actions">
            {#each actions as action (action.id)}
                {#if action.href}
                    <a
                        class="action"
                        data-testid={action.id}
                        href={action.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        onclick={() => panel?.hidePopover()}>{action.label}</a
                    >
                {:else}
                    <button
                        type="button"
                        class="action"
                        data-testid={action.id}
                        disabled={action.disabled}
                        onclick={() => runAction(action)}>{action.label}</button
                    >
                {/if}
            {/each}
        </div>
    {/if}
</div>

<style>
    /* The Sidebar footer's own row: the same box, padding and hover as All documents and Reset
       workspace above it. A min-height, so the row does not shrink while the label is empty. */
    .status {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        box-sizing: border-box;
        width: 100%;
        min-height: 2rem;
        padding: 0.375rem 0.5rem;
        border: 0;
        border-radius: 0.375rem;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 0.875rem;
        line-height: 1.25rem;
        text-align: left;
        white-space: nowrap;
        cursor: pointer;
    }
    .status:hover {
        background: var(--gk-surface-2, rgba(127, 127, 127, 0.12));
    }
    .status:focus-visible {
        outline: 2px solid var(--gk-focus, #6366f1);
        outline-offset: -2px;
    }
    .icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1rem;
        height: 1rem;
        flex: none;
    }
    .dot {
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 9999px;
        background: var(--sync-dot, #9ca3af);
    }
    .status[data-state="synced"] {
        --sync-dot: var(--gk-sync-ok, #16a34a);
    }
    /* Amber: not settled yet, as the mirror dot's "writing". */
    .status[data-state="sending"],
    .status[data-state="connecting"],
    .status[data-state="reconnecting"],
    .status[data-state="waiting-for-key"] {
        --sync-dot: var(--gk-sync-busy, #d97706);
    }
    .status[data-state="offline"] {
        --sync-dot: var(--gk-sync-idle, #6b7280);
    }
    .status[data-state="refused"],
    .status[data-state="ended"] {
        --sync-dot: var(--gk-sync-stopped, #dc2626);
    }
    .label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    /* Right-aligned, as the document count on the All documents row. */
    .count {
        margin-left: auto;
        font-variant-numeric: tabular-nums;
        color: var(--gk-text-subtle, inherit);
    }
    .panel {
        /* The popover's default is centred in the viewport; `place` puts it beside the row. */
        position: fixed;
        inset: auto;
        margin: 0;
        box-sizing: border-box;
        width: min(20rem, calc(100vw - 16px));
        max-height: calc(100vh - 16px);
        overflow-y: auto;
        padding: 0.75rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 8px;
        background: var(--gk-surface-0, #fff);
        color: var(--gk-text-default);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
        font-size: 0.875rem;
        line-height: 1.4;
    }
    .detail {
        margin: 0;
    }
    .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-top: 0.75rem;
    }
    .action {
        display: inline-flex;
        align-items: center;
        padding: 0.35rem 0.7rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 6px;
        background: var(--gk-surface-1);
        color: inherit;
        font: inherit;
        text-decoration: none;
        cursor: pointer;
    }
    .action:hover:not(:disabled) {
        background: var(--gk-surface-2, rgba(127, 127, 127, 0.12));
    }
    .action:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
</style>
