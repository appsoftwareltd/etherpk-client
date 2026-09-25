<script lang="ts">
    import type { Snippet } from "svelte";

    type Variant = "error" | "success" | "info" | "warning";

    let {
        variant = "error",
        message = "",
        dismissible = false,
        ondismiss,
        children,
    }: {
        variant?: Variant;
        /** The one-line body. Ignored when `children` supplies structured content instead. */
        message?: string;
        dismissible?: boolean;
        ondismiss?: () => void;
        /** Structured body - a line plus a list, say - where one sentence would not do. */
        children?: Snippet;
    } = $props();

    const styles: Record<Variant, string> = {
        error: "bg-red-50 border-red-200 text-red-700 dark:!bg-red-950/70 dark:!border-red-800 dark:!text-red-100",
        success: "bg-green-50 border-green-200 text-green-700 dark:!bg-green-950/70 dark:!border-green-800 dark:!text-green-100",
        info: "bg-blue-50 border-blue-200 text-blue-700 dark:!bg-blue-950/70 dark:!border-blue-800 dark:!text-blue-100",
        warning: "bg-amber-50 border-amber-200 text-amber-700 dark:!bg-amber-950/70 dark:!border-amber-800 dark:!text-amber-100",
    };
</script>

<div role="alert" class="rounded-lg border px-3 py-2.5 text-sm {styles[variant]}">
    <div class="flex items-start justify-between gap-2">
        {#if children}
            <div class="min-w-0">{@render children()}</div>
        {:else}
            <span>{message}</span>
        {/if}
        {#if dismissible}
            <button type="button" onclick={ondismiss} aria-label="Dismiss" class="shrink-0 opacity-60 hover:opacity-100 transition-opacity">
                <svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
                </svg>
            </button>
        {/if}
    </div>
</div>
