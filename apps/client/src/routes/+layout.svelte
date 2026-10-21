<script lang="ts">
    import "@fontsource-variable/inter/opsz.css";
    import "@fontsource-variable/inter/opsz-italic.css";
    import "../app.css";
    import { onMount } from "svelte";
    import { beforeNavigate } from "$app/navigation";
    import { continueIfSignedInElsewhere } from "@appsoftwareltd/etherpk-shared";
    import { updated } from "$app/state";
    import { dev } from "$app/environment";
    import { goto } from "$app/navigation";
    import { watchAppInstall } from "$lib/storage/app-install";
    import InstallAppDialog from "$lib/install/InstallAppDialog.svelte";
    import { welcomeInstalledApp } from "$lib/install/install-notices";
    import { launchTarget } from "$lib/install/launch-target";

    let { children, data } = $props();

    /** Chromium's launch queue, where the manifest's `launch_handler` delivers a launch. */
    type LaunchQueue = { setConsumer(consumer: (params: { targetURL?: string }) => void): void };
    // The address this page was opened at, read before any client-side navigation: the launch
    // that opened the page also arrives in the queue, and must not be carried out twice.
    const openedHref = typeof location === "undefined" ? "" : location.href;

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
        // The service worker (src/service-worker.ts, ADR 0142) keeps the app's files so the app
        // starts with no network, and makes it installable. SvelteKit serves it as a module in
        // development. Registering a new script at the same scope replaces the old `/sw.js`.
        if ("serviceWorker" in navigator) {
            navigator.serviceWorker.register("/service-worker.js", { type: dev ? "module" : "classic" }).catch((err) => {
                console.warn("[sw] Registration failed:", err);
            });
        }
        // Catch the browser's one-shot install offer now (or adopt the one `app.html` held), so
        // every Install entry can show it later: an installed app is what earns persistent
        // storage on a phone (the workspace layout asks for it).
        const stopWatching = watchAppInstall();
        welcomeInstalledApp();
        // The manifest's `launch_handler` focuses the open window for a new launch instead of
        // opening another. A plain launch leaves the person where they were; a shortcut or a
        // share is carried out in this window.
        const queue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;
        queue?.setConsumer((params) => {
            const target = launchTarget(params.targetURL, location.origin, openedHref);
            if (target) void goto(target);
        });
        return stopWatching;
    });
</script>

{@render children()}

<InstallAppDialog />
