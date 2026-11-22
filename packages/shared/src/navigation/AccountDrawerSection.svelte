<script lang="ts">
    import type { Snippet } from "svelte";

    /**
     * The account control at the top of the navigation drawer on a phone (`AccountPlacement`
     * "drawer"): a row naming the account that expands, in place, into what the header's account
     * dropdown holds on a wider screen. It starts closed each time the drawer opens. The contents
     * are each app's own, since each app ends a different session.
     */
    interface Props {
        /** The account, usually an email address: the row's text and its tooltip. */
        label: string;
        /** A line above the label, such as "Signed in as". */
        caption?: string;
        children: Snippet;
    }

    let { label, caption, children }: Props = $props();

    let open = $state(false);
    const panelId = $props.id();
    let row: HTMLButtonElement | undefined = $state();
    let panel: HTMLDivElement | undefined = $state();

    function toggle(): void {
        // Closing takes the panel's links away. Focus on one of them would fall out of the
        // drawer, a modal dialog, onto the page behind it, so it moves to the row first.
        if (open && panel?.contains(document.activeElement)) row?.focus();
        open = !open;
    }
</script>

<button
    bind:this={row}
    type="button"
    data-testid="account-drawer-toggle"
    class="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-neutral-950 dark:text-neutral-300 dark:hover:bg-white/5 dark:hover:text-white"
    title={label}
    aria-expanded={open}
    aria-controls={panelId}
    onclick={toggle}
>
    <!-- A person in a circle: the account, as against the drawer's places to go. -->
    <svg class="h-5 w-5 shrink-0 text-(--gk-text-muted)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.964 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
    <span class="min-w-0 flex-1">
        {#if caption}
            <span class="block font-normal text-(--gk-text-muted)">{caption}</span>
        {/if}
        <span class="block truncate">{label}</span>
    </span>
    <svg class="h-4 w-4 shrink-0 motion-safe:transition-transform {open ? 'rotate-180' : ''}" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" />
    </svg>
</button>
{#if open}
    <!-- Indented under the row, as the Graphs menu sits under its item lower in the drawer. The
         guide line starts 1.25rem below the row, as far as the menu's words stand from the line. -->
    <div bind:this={panel} id={panelId} data-testid="account-drawer-panel" data-drawer-submenu class="panel mt-5 ml-3 border-l border-neutral-950/8 pl-2 dark:border-white/10">
        {@render children()}
    </div>
{/if}

<style>
    /* The menu's rows put their words 0.75rem in (`gk-menu-item`), so the words stand 1.25rem from
       the guide line. A divider spans the words' column rather than the rows' whole width, and
       leaves the same 1.25rem between it and the words above and below: 0.875rem here, as each
       row's own 0.375rem padding makes up the rest. */
    .panel :global(.gk-menu-separator) {
        margin: 0.875rem 0.75rem;
    }
</style>
