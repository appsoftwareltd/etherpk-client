<script lang="ts">
    /**
     * A file in a [[Quick Note]], as the Quick Notes View shows it (ADR 0186): a picture as a
     * thumbnail, any other file as its name, which downloads it. The bytes come from the open
     * graph's [[Asset]] store, which on a synced graph may still be on their way up or down, so
     * the row keeps its height while it waits and says so when the file is not here yet.
     *
     * A note shared from another device arrives before its file has finished uploading there,
     * so a file the store does not have is asked for again (`quickNoteAssetWait`), and the row
     * shows it when it arrives with no reload.
     */
    import { type ResolvedAsset, displayNameForRef } from "#lib/storage/fs/asset-store.js";

    import { tryGetActiveAssetStore } from "../active-asset-store";
    import { quickNoteAssetWait } from "../quick-note-asset-wait";
    import { parseImageDisplaySizeHint } from "./augmentations/image-display-size";

    let { url, kind, alt = "" }: { url: string; kind: "image" | "file"; alt?: string } = $props();

    const name = $derived(displayNameForRef(url));
    /** The label without its display-size hint: what a screen reader should hear. */
    const spoken = $derived(parseImageDisplaySizeHint(alt).cleanAlt);

    /** `loading` for the first ask, `waiting` between later ones, `missing` once no more follow. */
    let phase = $state<"loading" | "waiting" | "missing">("loading");
    let asset = $state.raw<ResolvedAsset | null>(null);

    // Reading a file from the asset store is a fetch outside Svelte, repeated on a timer, so it
    // is an effect: it starts again when the note names another file, and stops with the row.
    $effect(() => {
        const ref = url;
        const store = tryGetActiveAssetStore();
        asset = null;
        phase = "loading";
        if (!store) {
            phase = "missing";
            return;
        }
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let retry = 0;
        const ask = async () => {
            // A failed read (the connection, the server for a moment) is asked again like a missing file.
            const found = await store.resolve(ref).catch(() => null);
            if (stopped) return;
            if (found) {
                asset = found;
                return;
            }
            const wait = quickNoteAssetWait(retry++);
            phase = wait === null ? "missing" : "waiting";
            if (wait !== null) timer = setTimeout(ask, wait);
        };
        void ask();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    });
</script>

{#if !asset}
    <p
        class={["text-sm text-(--gk-text-muted)", kind === "image" && phase === "loading" && "flex h-24 items-center"]}
        data-testid="quick-notes-asset"
        data-state={phase}
    >
        {#if phase === "loading"}
            {name}
        {:else if phase === "waiting"}
            {name} (not here yet, checking again)
        {:else}
            {name} (not on this device)
        {/if}
    </p>
{:else if kind === "image"}
    <img
        src={asset.url}
        alt={spoken || name}
        class="max-h-40 max-w-full rounded-md border border-(--gk-border-soft) object-contain"
        data-testid="quick-notes-asset"
        data-state="shown"
    />
{:else}
    <a
        href={asset.url}
        download={asset.name}
        class="inline-flex max-w-full items-center gap-1.5 rounded-md text-sm text-(--gk-accent) underline-offset-2 hover:underline pointer-coarse:min-h-11"
        data-testid="quick-notes-asset"
        data-state="shown"
    >
        <svg class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
        </svg>
        <span class="truncate">{asset.name}</span>
    </a>
{/if}
