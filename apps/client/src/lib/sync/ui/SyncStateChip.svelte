<script lang="ts">
    /**
     * The synced workspace's sync chip: whether this device's edits have reached the Sync Server,
     * in words, in the desktop toolbar and the phone's top bar.
     *
     * The chip says a word or two and how many documents hold changes the server has not
     * acknowledged; pressing it opens a panel with the whole sentence and anything there is to do
     * (restart a plan, try again now, download the unsent changes). The panel is a native popover:
     * it sits in the top layer, so no toolbar or drawer clips it, and the browser gives it light
     * dismissal and Escape. Nothing is only on hover.
     *
     * `compact` is the phone: the dot and the count only, in a box the size of the bar's toggles.
     */
    import type { SyncChipAction, SyncIndicator } from "../sync-indicator";

    let {
        indicator,
        actions = [],
        compact = false,
    }: {
        /** Null until the first state has settled: the chip keeps its place and says nothing yet. */
        indicator: SyncIndicator | null;
        actions?: SyncChipAction[];
        compact?: boolean;
    } = $props();

    const panelId = $props.id();
    let trigger = $state<HTMLButtonElement>();
    let panel = $state<HTMLDivElement>();

    const PANEL_MAX_WIDTH = 320;
    const GUTTER = 8;

    /**
     * Place the panel under the chip before it shows. Its width is known from the CSS rule
     * (`min(20rem, 100vw - 16px)`), so the left edge can be clamped to the viewport without a
     * measuring frame in which it would sit at the popover's default centre.
     */
    function place(event: Event) {
        if ((event as ToggleEvent).newState !== "open" || !trigger || !panel) return;
        const rect = trigger.getBoundingClientRect();
        const width = Math.min(PANEL_MAX_WIDTH, window.innerWidth - GUTTER * 2);
        const left = Math.min(Math.max(rect.left, GUTTER), window.innerWidth - width - GUTTER);
        panel.style.top = `${rect.bottom + 6}px`;
        panel.style.left = `${left}px`;
    }

    function runAction(action: SyncChipAction) {
        action.run?.();
        panel?.hidePopover();
    }

    const unsentText = $derived(
        indicator && indicator.unsent > 0
            ? compact
                ? indicator.unsent.toLocaleString()
                : `${indicator.unsent.toLocaleString()} unsent`
            : "",
    );
    const accessibleName = $derived(
        indicator ? `Sync: ${indicator.label}. ${indicator.detail}` : "Sync: checking",
    );
</script>

<button
    bind:this={trigger}
    type="button"
    class={["chip", { compact }]}
    data-testid="sync-state"
    data-state={indicator?.state ?? "pending"}
    popovertarget={panelId}
    aria-label={accessibleName}
    title={indicator?.detail}
>
    <span class="dot" aria-hidden="true"></span>
    {#if !compact && indicator}
        <span class="label">{indicator.label}</span>
    {/if}
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
    .chip {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        box-sizing: border-box;
        height: 1.9rem;
        padding: 0 0.6rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 9999px;
        background: var(--gk-surface-1);
        color: var(--gk-text-default);
        font: inherit;
        font-size: 0.875rem;
        line-height: 1;
        white-space: nowrap;
        cursor: pointer;
        flex: none;
    }
    .chip:hover {
        background: var(--gk-surface-2, rgba(127, 127, 127, 0.12));
    }
    .chip:focus-visible {
        outline: 2px solid var(--gk-focus, #6366f1);
        outline-offset: 2px;
    }
    /* The phone: the size of the bar's toggles, growing only for a count. */
    .chip.compact {
        min-width: 1.9rem;
        justify-content: center;
        padding: 0 0.45rem;
        border-radius: 6px;
    }
    .dot {
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 9999px;
        background: var(--sync-dot, #9ca3af);
        flex: none;
    }
    .chip[data-state="synced"] {
        --sync-dot: var(--gk-sync-ok, #16a34a);
    }
    /* Amber: not settled yet, as the mirror dot's "writing". */
    .chip[data-state="sending"],
    .chip[data-state="connecting"],
    .chip[data-state="reconnecting"] {
        --sync-dot: var(--gk-sync-busy, #d97706);
    }
    .chip[data-state="offline"] {
        --sync-dot: var(--gk-sync-idle, #6b7280);
    }
    .chip[data-state="refused"],
    .chip[data-state="ended"] {
        --sync-dot: var(--gk-sync-stopped, #dc2626);
    }
    .count {
        font-variant-numeric: tabular-nums;
        color: var(--gk-text-subtle, inherit);
    }
    .panel {
        /* The popover's default is centred in the viewport; `place` puts it under the chip. */
        position: fixed;
        inset: auto;
        margin: 0;
        box-sizing: border-box;
        width: min(20rem, calc(100vw - 16px));
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
