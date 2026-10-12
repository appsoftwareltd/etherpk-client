<script lang="ts">
    /**
     * A page under `/x/<extension id>/` whose extension is not installed on this device (ADR 0123,
     * amended 2026-10-12): a link someone sent, or a tab left open after the extension was removed.
     * It says which extension the page belongs to and, where the Extension Directory lists it, offers
     * to install it, asking first as Settings does. Once the extension runs here (installed from this
     * tab, or arriving from the person's account), the tab becomes the page it names.
     */
    import { onMount, tick } from "svelte";
    import type { Attachment } from "svelte/attachments";
    import { createSubscriber } from "svelte/reactivity";

    import type { ViewProps, ViewRef } from "$lib/layout";
    import { personSettings, type PersonSettings } from "$lib/person-settings/person-settings";

    import { DIRECTORY_SEGMENT } from "./addresses";
    import type { DirectoryState, ExtensionDirectory } from "./directory";
    import { newestRelease } from "./directory-format";
    import type { ExtensionHost } from "./host";
    import InstallConsent from "./InstallConsent.svelte";
    import { installedIds } from "./installed-sync";

    const {
        view,
        host,
        directory,
        onresolved,
        settings = personSettings(),
    }: ViewProps & {
        host: ExtensionHost;
        directory: ExtensionDirectory;
        /** The extension runs now and its page is `to`: put it in this tab's place. */
        onresolved: (from: ViewRef, to: ViewRef) => void;
        settings?: PersonSettings;
    } = $props();

    const extensionId = $derived(view.target.split("/")[0] ?? "");

    let directoryState = $state<DirectoryState | null>(null);
    let loading = $state(false);
    let confirming = $state(false);
    let installing = $state(false);
    let failure = $state("");
    let installButton = $state<HTMLButtonElement | null>(null);

    const listed = $derived(directoryState?.state === "ok" ? (directoryState.listing.extensions.find((extension) => extension.id === extensionId) ?? null) : null);
    const release = $derived(listed ? newestRelease(listed, directory.clientVersion) : null);
    const name = $derived(listed?.displayName ?? extensionId);

    // The person installed it on another device and their account is bringing it here.
    const watchSettings = createSubscriber((update) => settings.subscribe(update));
    const arriving = $derived.by(() => {
        watchSettings();
        return installedIds(settings).includes(extensionId);
    });

    async function load() {
        if (loading) return;
        loading = true;
        try {
            directoryState = await directory.load();
        } catch {
            directoryState = { state: "unavailable", error: "The Client's server could not be reached." };
        } finally {
            loading = false;
        }
    }

    /** The page this tab names, once its extension runs here, or null. */
    function resolved(): ViewRef | null {
        return host.addresses.view(DIRECTORY_SEGMENT, view.target);
    }

    onMount(() => {
        void load();
        // Whenever the host's extensions change, see whether the page can be shown now.
        const check = () => {
            const page = resolved();
            if (page) onresolved(view, page);
        };
        // Not while this tab is still being mounted: replacing it is a change to the Layout.
        queueMicrotask(check);
        return host.subscribe(check);
    });

    async function install() {
        if (!listed || !release || installing) return;
        installing = true;
        failure = "";
        try {
            await directory.install(listed, release);
        } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
        } finally {
            installing = false;
        }
    }

    async function cancel() {
        if (installing) return;
        confirming = false;
        failure = "";
        await tick();
        installButton?.focus();
    }

    function cancelOnEscape(event: KeyboardEvent) {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        event.preventDefault();
        void cancel();
    }

    /** The confirmation takes the keyboard as it opens, on its Install button. */
    const focusOnOpen: Attachment<HTMLButtonElement> = (button) => {
        button.focus();
    };

    const secondaryButton =
        "rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 aria-disabled:cursor-progress";
    const primaryButton =
        "rounded-lg bg-gray-900 dark:bg-gray-100 px-3 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 aria-disabled:cursor-progress";
</script>

<div class="mx-auto max-w-xl space-y-3 p-6" data-testid="extension-address" data-extension={extensionId}>
    <h2 class="text-base font-medium text-gray-950 dark:text-gray-100">This page belongs to {name}, which isn't installed on this device.</h2>

    {#if arriving}
        <p class="text-sm text-gray-600 dark:text-gray-400" role="status" data-testid="extension-address-arriving">
            You installed {name} on another device, so it is being installed here. The page opens once it is.
        </p>
    {:else if directoryState === null}
        <p class="text-sm text-gray-500 dark:text-gray-400">Reading the Extension Directory…</p>
    {:else if directoryState.state === "unavailable"}
        <div class="space-y-2" role="alert">
            <p class="text-sm text-(--gk-text-warning)">The Extension Directory couldn't be read: {directoryState.error}</p>
            <button type="button" class={secondaryButton} aria-disabled={loading} aria-busy={loading} onclick={load} data-testid="extension-address-retry">{loading ? "Trying again…" : "Try again"}</button>
        </div>
    {:else if directoryState.state === "off" || !listed}
        <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="extension-address-unlisted">The Extension Directory doesn't list {name}, so it can't be installed here.</p>
    {:else if !release}
        <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="extension-address-needs">{name} needs a newer EtherPK than this one, {directory.clientVersion}.</p>
    {:else}
        {#if listed.description}
            <p class="text-sm text-gray-600 dark:text-gray-400">{listed.description}</p>
        {/if}
        {#if confirming}
            <div class="space-y-2 border-l-2 border-gray-300 pl-3 dark:border-gray-700" role="group" aria-labelledby="extension-address-confirm-text" data-testid="extension-address-confirm">
                <InstallConsent {name} id="extension-address-confirm-text" />
                <div class="flex flex-wrap gap-2">
                    <button type="button" class={primaryButton} aria-disabled={installing} aria-busy={installing} onclick={install} onkeydown={cancelOnEscape} {@attach focusOnOpen} data-testid="extension-address-install-confirm">
                        {installing ? "Installing…" : `Install ${name}`}
                    </button>
                    <button type="button" class={secondaryButton} aria-disabled={installing} onclick={cancel} onkeydown={cancelOnEscape}>Cancel</button>
                </div>
                {#if failure}
                    <p class="text-sm text-(--gk-text-warning)" role="alert" data-testid="extension-address-failure">{name} wasn't installed: {failure}</p>
                {/if}
            </div>
        {:else}
            <button type="button" class={secondaryButton} bind:this={installButton} onclick={() => (confirming = true)} data-testid="extension-address-install">Install {name}</button>
        {/if}
    {/if}
</div>
