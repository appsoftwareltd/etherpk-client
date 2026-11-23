<script lang="ts">
    /**
     * The [[Protected Documents View]] (CONTEXT.md): whether this device holds the graph's
     * [[Protection Key]], the one control that unlocks or locks every [[Protected Document]], and
     * the way to the settings. A resident of the [[Primary Sidebar]], with a padlock for its icon.
     *
     * It never lists the documents: a list of what a person protects is what protection should not
     * advertise from a drawer anyone can open. One control for the whole graph, because the key is
     * the unit (ADR 0058).
     *
     * The record is read off the graph-open critical path, so this View can mount before the answer
     * has landed, and says so rather than that the graph has none. Every answer and every lock
     * transition is announced as `protection:changed`, and the View reads its state again then.
     */
    import { onMount } from "svelte";

    import type { ViewProps } from "#lib/layout/index.js";
    import { iconSvg } from "#lib/surface/icons.js";
    import { tryGetActiveEventBus } from "#lib/surface/index.js";
    import { currentWorkspaceServices } from "#lib/workspace/workspace-services.js";

    import { idleLockText } from "../protection/idle-lock-text";

    // Every View is handed its ViewRef; this one is the only one of its kind.
    let { view: _view }: ViewProps = $props();

    function read() {
        const controls = currentWorkspaceServices()?.protection;
        return {
            controls,
            record: controls?.record() ?? { state: "reading" as const },
            unlocked: controls?.status === "unlocked" || controls?.status === "masked",
            idleLockMs: controls?.idleLockMs() ?? 0,
        };
    }
    let shown = $state.raw(read());

    /** Reading the record again, after it could not be read. */
    let retrying = $state(false);
    async function retry() {
        if (retrying) return;
        retrying = true;
        try {
            await shown.controls?.readAgain();
        } finally {
            retrying = false;
            shown = read();
        }
    }

    /** The service's sentence starts in lower case, to follow other words; here it stands alone. */
    const sentence = (words: string) => `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;

    onMount(() => tryGetActiveEventBus()?.on("protection:changed", () => (shown = read())));
</script>

<div
    class="h-full overflow-y-auto break-words text-(--gk-text-default)"
    style:font-family="var(--gk-sans, 'Inter', system-ui, sans-serif)"
    data-testid="protected-documents-view"
>
    <div class="flex flex-col items-start gap-3 p-3 text-sm">
        {#if shown.record.state === "reading"}
            <p class="m-0 text-(--gk-text-muted)" role="status" data-testid="protection-reading">Reading this graph's protection…</p>
        {:else if shown.record.state === "problem"}
            <p class="gk-error m-0" role="alert" data-testid="protection-problem">{sentence(shown.record.message)}</p>
            <button type="button" class="gk-button" onclick={retry} aria-busy={retrying} disabled={retrying} data-testid="protection-retry">
                {retrying ? "Trying again…" : "Try again"}
            </button>
        {:else if shown.record.state === "none"}
            <p class="m-0" data-testid="protection-none">
                A protected document is scrambled on disk, and can only be read after you enter a passphrase. This graph has no
                protection passphrase yet.
            </p>
            <button type="button" class="gk-button gk-button--primary" onclick={() => shown.controls?.openSettings()} data-testid="protection-open-settings">
                Set up in Settings
            </button>
        {:else}
            <section class="flex flex-col items-start gap-3" data-testid="protection-section">
                <p class="m-0 flex items-center gap-2" role="status" data-testid="protection-status">
                    <span class="inline-flex shrink-0 text-(--gk-text-muted)" aria-hidden="true">
                        <!-- In-repo constant markup from the icon table, never user or document content. -->
                        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                        {@html iconSvg(shown.unlocked ? "lock-open" : "lock", { size: 16 })}
                    </span>
                    {shown.unlocked ? "Unlocked on this device" : "Locked on this device"}
                </p>
                <!-- One button, so the keyboard stays on it when what it does changes. Filled while
                     unlocked: that is the state worth noticing, and Lock now the action worth
                     reaching for. -->
                <button
                    type="button"
                    data-testid={shown.unlocked ? "protection-lock" : "protection-unlock"}
                    data-state={shown.unlocked ? "unlocked" : "locked"}
                    onclick={() => (shown.unlocked ? shown.controls?.lockNow() : shown.controls?.requestUnlock())}
                    class={["gk-button", shown.unlocked && "gk-button--primary"]}
                >
                    {shown.unlocked ? "Lock now" : "Unlock"}
                </button>
                <p class="gk-hint m-0" data-testid="protection-idle">{idleLockText(shown.idleLockMs)}</p>
            </section>
            <button type="button" class="gk-link" onclick={() => shown.controls?.openSettings()} data-testid="protection-open-settings">
                Protection settings
            </button>
        {/if}
    </div>
</div>
