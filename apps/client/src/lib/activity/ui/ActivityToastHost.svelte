<script lang="ts">
    /**
     * The [[Activity Toast]] host (ADR 0035): one card per running or finished [[Activity]],
     * stacked in the corner. Hosted once in the app shell, so an Activity keeps reporting
     * across client-side navigation - which is the whole point of backgrounding the work.
     *
     * The same rail carries the app's short **notices** (`../notices.ts`) - the workspace's
     * "Deleted …" / "Could not …" lines - as cards of the same shape, so everything said in
     * passing lands in one place rather than in a banner of its own in another corner.
     *
     * Placement: bottom-right from `lg` up; **top-anchored under the navbar below `lg`**,
     * because the mobile [[Command Bar]] owns the bottom edge (its pinned right-hand group
     * is the font-size zoom, exactly where a bottom-right toast would land) and it rides
     * above the soft keyboard.
     *
     * Cancelling is a two-step inside the card rather than a confirm dialog: the toast is
     * the only progress surface, and a modal over it would be the competing surface the
     * glossary entry rules out.
     */
    import { formatBytes } from "$lib/format-bytes";
    import { onMount } from "svelte";

    import { cancelActivity, dismissActivity, subscribeActivities } from "../store";
    import { type Notice, type NoticeAction, closeNotice, subscribeNotices } from "../notices";
    import type { Activity } from "../types";

    let activities = $state.raw<Activity[]>([]);
    let notices = $state.raw<Notice[]>([]);
    onMount(() => {
        const stopActivities = subscribeActivities((list) => (activities = list));
        const stopNotices = subscribeNotices((list) => (notices = list));
        return () => {
            stopActivities();
            stopNotices();
        };
    });

    /** Which card is showing its "Discard?" confirmation, if any. */
    let confirming = $state<string | null>(null);
    /** Activity ids whose action is running, so a second click cannot run it again. */
    let running = $state<Set<string>>(new Set());

    async function runAction(activity: Activity) {
        const action = activity.action;
        if (!action || running.has(activity.id)) return;
        running = new Set(running).add(activity.id);
        try {
            await action.run();
        } finally {
            const next = new Set(running);
            next.delete(activity.id);
            running = next;
        }
    }

    function amount(value: number, unit: Activity["phases"][number]["unit"]): string {
        return unit === "bytes" ? formatBytes(value) : String(value);
    }

    /** "Uploading assets: 142 MB of 1.2 GB", or the label alone for an uncounted phase. */
    function progressLine(activity: Activity): string {
        const phase = activity.phases[activity.phase];
        if (!phase) return "";
        if (activity.total === 0) return `${phase.label}…`;
        return `${phase.label}: ${amount(activity.done, phase.unit)} of ${amount(activity.total, phase.unit)}`;
    }

    function percent(activity: Activity): number {
        if (activity.total <= 0) return 0;
        return Math.min(100, Math.round((activity.done / activity.total) * 100));
    }

    /** Notice actions whose work is in flight, so a second click cannot run one again. */
    let runningActions = $state<Set<string>>(new Set());

    async function runNoticeAction(notice: Notice, action: NoticeAction) {
        const key = `${notice.id}:${action.label}`;
        if (runningActions.has(key)) return;
        runningActions = new Set(runningActions).add(key);
        try {
            await action.run();
        } finally {
            const next = new Set(runningActions);
            next.delete(key);
            runningActions = next;
        }
    }

    function requestCancel(activity: Activity) {
        if (confirming === activity.id) {
            cancelActivity(activity.id);
            confirming = null;
            return;
        }
        confirming = activity.id;
    }
</script>

<!--
    `pointer-events-none` on the rail so the fixed container never swallows clicks aimed at
    the app behind it; each card re-enables them for itself.

    The rail is mounted unconditionally so the live region exists BEFORE the first card is
    inserted into it. A region that appears together with its content is not reliably
    announced, which made the first Activity the one most likely to go unheard.
-->
<div
    data-testid="activity-toasts"
    aria-live="polite"
    aria-relevant="additions text"
    class="pointer-events-none fixed inset-x-0 top-16 z-40 flex flex-col items-center gap-2 px-4 lg:inset-x-auto lg:top-auto lg:right-4 lg:bottom-4 lg:items-end lg:px-0"
>
    {#if activities.length > 0}
        {#each activities as activity (activity.id)}
            {@const phase = activity.phases[activity.phase]}
            <div
                data-testid="activity-toast"
                data-activity-kind={activity.kind}
                data-activity-state={activity.state}
                data-activity-dismissal={activity.dismissal}
                role={activity.state === "failed" ? "alert" : undefined}
                class="pointer-events-auto w-full max-w-sm rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-(--gk-surface-0) p-3 shadow-lg"
            >
                <div class="flex items-start gap-2">
                    <p class="min-w-0 flex-1 text-sm font-medium text-gray-950 dark:text-gray-100" data-testid="activity-title">
                        {activity.title}
                    </p>
                    {#if activity.state !== "running"}
                        <button
                            onclick={() => dismissActivity(activity.id)}
                            data-testid="activity-dismiss"
                            aria-label="Dismiss"
                            class="shrink-0 rounded-lg p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10"
                        >
                            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
                                <path d="M6 18 18 6M6 6l12 12" stroke-linecap="round" stroke-linejoin="round" />
                            </svg>
                        </button>
                    {:else if activity.phases.length > 1}
                        <span class="shrink-0 text-sm text-gray-400 dark:text-gray-500" data-testid="activity-step">
                            Step {activity.phase + 1} of {activity.phases.length}
                        </span>
                    {/if}
                </div>

                {#if activity.state === "running"}
                    <p class="mt-1 text-sm text-gray-600 dark:text-gray-400" aria-hidden="true" data-testid="activity-progress">
                        {activity.cancelling ? "Cancelling…" : progressLine(activity)}
                    </p>
                    <!--
                        A determinate bar only when the phase has a real total. An uncounted
                        phase gets an indeterminate sweep rather than a bar sitting at zero,
                        which reads as "stuck" rather than "working".
                    -->
                    <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-white/10">
                        {#if activity.total > 0}
                            <div
                                class="h-full rounded-full bg-gray-900 dark:bg-gray-100 transition-[width] duration-200"
                                style:width="{percent(activity)}%"
                                data-testid="activity-bar"
                                role="progressbar"
                                aria-valuenow={activity.done}
                                aria-valuemin="0"
                                aria-valuemax={activity.total}
                                aria-label={phase?.label}
                            ></div>
                        {:else}
                            <div class="activity-sweep h-full w-1/3 rounded-full bg-gray-900 dark:bg-gray-100"></div>
                        {/if}
                    </div>
                {:else if activity.detail}
                    <p
                        class="mt-1 text-sm {activity.state === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'}"
                        data-testid="activity-detail"
                    >
                        {activity.detail}
                    </p>
                {/if}

                {#if activity.state === "running" && activity.cancellable && !activity.cancelling}
                    <div class="mt-2 flex items-center justify-end gap-2">
                        {#if confirming === activity.id}
                            <span class="mr-auto text-sm text-gray-600 dark:text-gray-400" data-testid="activity-cancel-prompt">
                                Discard this import? Nothing will be kept.
                            </span>
                            <button
                                onclick={() => (confirming = null)}
                                class="rounded-lg px-2 py-1 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                            >Keep going</button>
                            <button
                                onclick={() => requestCancel(activity)}
                                data-testid="activity-cancel-confirm"
                                class="rounded-lg border border-red-300 dark:border-red-500/40 px-2 py-1 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                            >Discard</button>
                        {:else}
                            <button
                                onclick={() => requestCancel(activity)}
                                data-testid="activity-cancel"
                                class="rounded-lg px-2 py-1 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                            >Cancel</button>
                        {/if}
                    </div>
                {:else if activity.action}
                    <div class="mt-2 flex justify-end">
                        <button
                            onclick={() => void runAction(activity)}
                            disabled={running.has(activity.id)}
                            data-testid="activity-action"
                            class="rounded-lg bg-gray-900 dark:bg-gray-100 px-3 py-1 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50"
                        >{activity.action.label}</button>
                    </div>
                {/if}
            </div>
        {/each}
    {/if}
    <!-- After the Activities: nearest the corner on a desktop, where the eye lands, and beneath
         work in flight on a phone, which must not be pushed down by a passing line. -->
    {#each notices as notice (notice.id)}
        <div
            data-testid={notice.id}
            data-notice-tone={notice.tone}
            data-notice-dismissal={notice.dismissal}
            role={notice.tone === "error" ? "alert" : undefined}
            class="pointer-events-auto w-full max-w-sm rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-(--gk-surface-0) p-3 shadow-lg"
        >
            <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1">
                    {#if notice.title}
                        <p class="text-sm font-medium text-gray-950 dark:text-gray-100">{notice.title}</p>
                    {/if}
                    <p
                        class="text-sm {notice.title ? 'mt-1' : ''} {notice.tone === 'error' ? 'text-red-600 dark:text-red-400' : notice.title ? 'text-gray-600 dark:text-gray-400' : 'text-gray-950 dark:text-gray-100'}"
                    >
                        {notice.text}
                    </p>
                    {#if notice.items?.length}
                        <ul class="mt-1 list-disc space-y-0.5 pl-5 text-sm text-gray-600 dark:text-gray-400">
                            {#each notice.items as item (item)}
                                <li>{item}</li>
                            {/each}
                        </ul>
                    {/if}
                    {#if notice.footnote}
                        <p class="mt-2 text-sm text-gray-600 dark:text-gray-400">{notice.footnote}</p>
                    {/if}
                </div>
                <button
                    onclick={() => closeNotice(notice.id)}
                    data-testid="notice-dismiss"
                    aria-label="Dismiss"
                    class="shrink-0 rounded-lg p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10"
                >
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
                        <path d="M6 18 18 6M6 6l12 12" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                </button>
            </div>
            {#if notice.actions?.length}
                <div class="mt-2 flex items-center justify-end gap-2">
                    {#each notice.actions as action (action.label)}
                        <button
                            onclick={() => void runNoticeAction(notice, action)}
                            disabled={action.disabled || runningActions.has(`${notice.id}:${action.label}`)}
                            data-testid={action.id}
                            class={action.primary
                                ? "rounded-lg bg-gray-900 dark:bg-gray-100 px-3 py-1 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50"
                                : "rounded-lg px-2 py-1 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50"}
                        >{action.label}</button>
                    {/each}
                </div>
            {/if}
        </div>
    {/each}
</div>

<style>
    .activity-sweep {
        animation: activity-sweep 1.2s ease-in-out infinite;
    }
    @keyframes activity-sweep {
        0% {
            transform: translateX(-100%);
        }
        100% {
            transform: translateX(300%);
        }
    }
    /* An indeterminate sweep is decoration, not information - hold it still when asked. */
    @media (prefers-reduced-motion: reduce) {
        .activity-sweep {
            animation: none;
            width: 100%;
        }
    }
</style>
