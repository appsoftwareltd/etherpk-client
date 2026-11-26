<script lang="ts">
    /** The Native App's version and its updates, on the Graphs page's This Device tab. */
    import { nativeAppVersion } from "./bridge.js";
    import { updateWords } from "./update-words.js";
    import { appUpdates } from "./updates.svelte.js";

    const words = $derived(updateWords(appUpdates.status));
    let running = $state(false);

    async function run(does: "check" | "install" | "download") {
        if (running) return;
        running = true;
        try {
            await appUpdates.run(does);
        } finally {
            running = false;
        }
    }
</script>

<p class="text-sm text-neutral-600 dark:text-neutral-400" data-testid="app-version">
    EtherPK {nativeAppVersion()}.
</p>
{#if words}
    <!-- Polite: it changes as the shell checks for and downloads an update. -->
    <p class="text-sm text-neutral-600 dark:text-neutral-400" role="status" data-testid="app-update-status" data-state={appUpdates.status.state}>
        {words.text}
    </p>
    {#if words.action}
        {@const action = words.action}
        <button type="button" class="gk-button" aria-busy={running} data-testid="app-update-run" onclick={() => void run(action.does)}>
            {action.label}
        </button>
    {/if}
{/if}
