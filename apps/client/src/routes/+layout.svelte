<script lang="ts">
    import "@fontsource-variable/inter/opsz.css";
    import "@fontsource-variable/inter/opsz-italic.css";
    import "../app.css";
    import { onMount } from "svelte";
    import { beforeNavigate } from "$app/navigation";
    import { updated } from "$app/state";
    import { ensurePersistentStorage } from "$lib/storage/storage-persistence";
    import { watchAppInstall } from "$lib/storage/app-install";

    let { children } = $props();

    // A deployed update must not leave this tab running stale client code: once the
    // version poll (svelte.config `kit.version.pollInterval`) sees a new build, the next
    // client-side navigation becomes a full-page load, picking up the new hashed assets.
    // Mixed-version tabs caused days of unreproducible bug reports (2026-07-28/29).
    beforeNavigate(({ willUnload, to }) => {
        if (updated.current && !willUnload && to?.url) {
            location.href = to.url.href;
        }
    });

    onMount(() => {
        // Register the minimal service worker required for PWA installability.
        // The SW itself does no caching — it simply passes all requests to the network.
        if ("serviceWorker" in navigator) {
            navigator.serviceWorker.register("/sw.js").catch((err) => {
                console.warn("[sw] Registration failed:", err);
            });
        }
        // Ask the browser not to evict the graph registry, Local Cache and Derived Index under
        // disk pressure. Best effort and never awaited: the grant depends on the browser's
        // engagement heuristics, so a refusal is logged for diagnosis rather than acted on.
        void ensurePersistentStorage().then((outcome) => {
            if (outcome.supported && !outcome.persisted) {
                console.warn(
                    "[storage] Persistent storage was not granted; this browser may evict local graph data under disk pressure.",
                );
            }
        });
        // Catch the browser's one-shot install offer now, so the Install section in Graph
        // Settings can show it later: an installed app is what earns the grant above on a phone.
        return watchAppInstall();
    });
</script>

{@render children()}
