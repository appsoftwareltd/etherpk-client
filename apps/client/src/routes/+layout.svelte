<script lang="ts">
    import "@fontsource-variable/inter/opsz.css";
    import "@fontsource-variable/inter/opsz-italic.css";
    import "../app.css";
    import { onMount } from "svelte";
    import { beforeNavigate } from "$app/navigation";
    import { continueIfSignedInElsewhere } from "@appsoftwareltd/etherpk-shared";
    import { updated } from "$app/state";
    import { watchAppInstall } from "$lib/storage/app-install";

    let { children, data } = $props();

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
        // A sign-in made at the account site since the last silent check missed: ask there, and
        // go through the silent check on a yes, so the visit comes back signed in.
        if (data.signedInElsewhereCheck) void continueIfSignedInElsewhere(data.signedInElsewhereCheck);
        // Register the minimal service worker required for PWA installability.
        // The SW itself does no caching — it simply passes all requests to the network.
        if ("serviceWorker" in navigator) {
            navigator.serviceWorker.register("/sw.js").catch((err) => {
                console.warn("[sw] Registration failed:", err);
            });
        }
        // Catch the browser's one-shot install offer now, so the Install section in Graph
        // Settings can show it later: an installed app is what earns persistent storage on a
        // phone (the workspace layout asks for it).
        return watchAppInstall();
    });
</script>

{@render children()}
