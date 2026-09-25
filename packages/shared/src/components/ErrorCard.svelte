<script lang="ts">
    import type { Snippet } from "svelte";
    import type { ResolvedTheme, ThemePreference } from "../theme";

    // Theme is applied by the server hook decorating the document, not by this card, so both
    // theme props are accepted and ignored. Callers pass themePreference and the aliases keep
    // that contract without pretending the values are read here.
    let {
        children,
        themePreference: _themePreference = "system",
        resolvedTheme: _resolvedTheme = "light",
    }: {
        children: Snippet;
        themePreference?: ThemePreference;
        resolvedTheme?: ResolvedTheme;
    } = $props();
</script>

<!--
    Shared page shell for all error pages (SvelteKit +error.svelte and /auth-error).
    Renders the full-page centred layout: background, max-width container, EtherPK
    logo, and the white card. Card contents are provided via the children snippet.
-->
<div class="flex min-h-dvh flex-col items-center justify-center bg-gray-50 dark:bg-[var(--gk-surface-0)] px-4 py-12">
    <div class="w-full max-w-sm">
        <!-- Logo -->
        <div class="flex justify-center mb-8">
            <a href="/home" aria-label="EtherPK home" class="inline-flex items-center gap-2.5 text-gray-950 dark:text-white hover:opacity-80 transition-opacity">
                <svg class="h-7 w-auto" viewBox="0 0 191.82 166.13" fill="currentColor" aria-hidden="true">
                    <path fill-rule="evenodd" d="M67.09,132.92,47.93,166.13H9.59L0,149.52,86.33,0H105.5L19.17,149.52H38.34l19.17-33.2h76.8l9.59,16.6Zm48-83.12,9.65,16.71H143.9L115.08,16.6q-24,41.57-48,83.12H143.9q14.37,24.9,28.76,49.8h-96l-9.59,16.61H182.24l9.58-16.61-38.34-66.4H96C95.85,82.9,113.39,52.73,115.08,49.8Z" />
                </svg>
                <span class="text-xl font-semibold tracking-tight">EtherPK</span>
            </a>
        </div>

        <!-- Card -->
        <div class="rounded-2xl bg-white dark:bg-[var(--gk-surface-0)] shadow-sm dark:shadow-gray-950/40 ring-1 ring-gray-950/5 dark:ring-white/10 px-6 py-8">
            {@render children()}
        </div>
    </div>
</div>
