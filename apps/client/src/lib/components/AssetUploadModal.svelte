<script lang="ts">
    /**
     * The in-app asset upload dialog: a drop zone, a "Browse files" button, and the clipboard.
     * Opened by the `asset.upload` Command (slash menu / mobile bar) via the {@link assetPicker}
     * rune store; hosted once in the app shell. On file selection it saves each file
     * through the active asset store and inserts the markdown reference at the caret
     * position captured when the dialog opened. The other upload routes - drag-and-drop and
     * paste straight onto the editor - bypass this dialog entirely.
     *
     * Two clipboard routes, because touch devices have no Ctrl+V:
     * - a `paste` event while the dialog is open (the same files-win-without-text rule as the
     *   editor, see `clipboard-assets.ts`), which can carry any copied file;
     * - a **Paste from clipboard** button over the Async Clipboard API, which browsers limit
     *   to images and text. Hidden when the API is absent; a refusal is worded in place.
     *
     * Built on the shared Dialog shell, so it inherits the focus contract, Escape and the
     * busy behaviour rather than reimplementing them; it used to be its own modal.
     *
     * The **Optimise images** box at the bottom is the one place [[Image Optimisation]]
     * (ADR 0080) can be switched off, and only for the upload it is unticked for: it comes
     * back ticked every time the dialog opens. Paste and drop straight onto the editor have no
     * surface to ask on and always optimise.
     */
    import Dialog from "@appsoftwareltd/etherpk-shared/dialog";
    import { tryGetActiveAssetStore } from "$lib/document";
    import {
        type AssetPickerState,
        closeAssetPicker,
        getAssetPickerState,
        resolveAssetPickerTarget,
        subscribeAssetPicker,
    } from "$lib/document/view/asset-picker";
    import {
        ClipboardAccessRefused,
        clipboardAssetFiles,
        nameClipboardFile,
        readClipboardImages,
    } from "$lib/document/view/clipboard-assets";
    import { startAssetUpload } from "$lib/document/view/upload-activity";

    let picker = $state<AssetPickerState>(getAssetPickerState());
    let optimizeImages = $state(true);
    $effect(() =>
        subscribeAssetPicker((s) => {
            // Ticked afresh on every open: the opt-out is for one upload, never remembered. A
            // failed upload keeps the dialog open, and the tick, for the retry. Reset on CLOSE
            // rather than on an open transition: the listener fires synchronously inside this
            // effect, and reading `picker` here to detect the transition would make the effect
            // depend on the state it writes - a re-run loop whenever the dialog is open at mount.
            if (!s.open) optimizeImages = true;
            picker = s;
        }),
    );

    let uploading = $state(false);
    let dragOver = $state(false);
    let fileInput = $state<HTMLInputElement>();
    let error = $state("");

    // The Async Clipboard API is what the Paste button needs; without it the button is
    // noise (Firefox exposes `read` only behind a flag), so it is hidden rather than dead.
    const canReadClipboard =
        typeof navigator !== "undefined" &&
        typeof navigator.clipboard?.read === "function";

    async function handleFiles(files: readonly File[] | null) {
        if (uploading) return;
        // Resolved now, not when the dialog opened: a promoting [[Draft]] may have remounted
        // its editor in between, and the view pinned then no longer exists.
        const target = resolveAssetPickerTarget();
        const store = tryGetActiveAssetStore();
        if (!files || files.length === 0) {
            // The user cancelled the OS picker: nothing was asked for, nothing to report.
            closeAssetPicker();
            return;
        }
        if (!target || !store) {
            // Not a cancellation. Closing silently here read as success while nothing was
            // uploaded, which is the failure the comment below already guards against.
            error =
                "No open document to attach this to. Open a document, then upload.";
            return;
        }
        uploading = true;
        error = "";
        try {
            // The upload is an Activity: it reports through a toast and outlives this
            // dialog. The dialog still waits, so a failure can be shown in place - a silent
            // close reads as success while the asset never made it (the store's messages
            // name the failing piece, e.g. the storage bucket's CORS policy).
            const activity = await startAssetUpload(
                target.view,
                store,
                files,
                target.pos,
                { optimizeImages },
            );
            if (activity.state === "failed") {
                error = activity.detail ?? "Upload failed.";
                return;
            }
            closeAssetPicker();
        } finally {
            uploading = false;
            // Reset the input so re-picking the same file after a failure fires change again.
            if (fileInput) fileInput.value = "";
        }
    }

    function handleDrop(event: DragEvent) {
        event.preventDefault();
        dragOver = false;
        if (uploading) return;
        void handleFiles(Array.from(event.dataTransfer?.files ?? []));
    }

    /** Ctrl+V / ⌘V while the dialog is open: the same rule as pasting onto the editor. */
    function handlePaste(event: ClipboardEvent) {
        if (uploading) return;
        const files = clipboardAssetFiles(event.clipboardData);
        if (files.length === 0) return; // text, or nothing: not ours
        event.preventDefault();
        void handleFiles(files.map((f) => nameClipboardFile(f)));
    }

    /** The Paste button: reads images through the Async Clipboard API (touch devices). */
    async function pasteFromClipboard() {
        if (uploading) return;
        error = "";
        let files: File[];
        try {
            files = await readClipboardImages(navigator.clipboard);
        } catch (err) {
            error =
                err instanceof ClipboardAccessRefused
                    ? "Clipboard access was refused. Allow it for this site and try again, or paste with Ctrl+V (⌘V on a Mac)."
                    : `Could not read the clipboard: ${(err as Error).message}`;
            return;
        }
        if (files.length === 0) {
            error =
                "Nothing on the clipboard that can be uploaded here. Copy an image and try again - a copied file needs Ctrl+V (⌘V on a Mac) on a desktop.";
            return;
        }
        await handleFiles(files);
    }
</script>

<svelte:window onpaste={picker.open ? handlePaste : undefined} />

<Dialog
    open={picker.open}
    title="Upload asset"
    testId="asset-upload-modal"
    busy={uploading}
    busyReason="Uploading…"
    onclose={() => closeAssetPicker()}
>
    {#snippet body()}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors {dragOver
                ? 'border-(--gk-accent,#007ACC) bg-(--gk-accent,#007ACC)/5'
                : 'border-gray-300 dark:border-gray-700'}"
            data-testid="asset-dropzone"
            ondragover={(e) => {
                e.preventDefault();
                dragOver = true;
            }}
            ondragleave={() => (dragOver = false)}
            ondrop={handleDrop}
        >
            {#if uploading}
                <p
                    class="text-sm text-gray-600 dark:text-gray-400"
                    role="status"
                    data-testid="asset-uploading"
                >
                    Uploading…
                </p>
            {:else}
                <p
                    class="text-sm text-gray-600 dark:text-gray-400"
                    data-testid="asset-upload-help"
                >
                    Drag and drop files here, paste from your clipboard, or
                </p>
                <div class="flex flex-wrap items-center justify-center gap-2">
                    <button
                        type="button"
                        onclick={() => fileInput?.click()}
                        data-autofocus
                        class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors"
                    >
                        Browse files
                    </button>
                    {#if canReadClipboard}
                        <button
                            type="button"
                            onclick={pasteFromClipboard}
                            data-testid="asset-paste-button"
                            class="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                        >
                            Paste from clipboard
                        </button>
                    {/if}
                </div>
                <p class="text-sm text-gray-400 dark:text-gray-500">
                    Ctrl+V (⌘V on a Mac) pastes any copied image or file. The
                    Paste button reads images from your clipboard, which is the
                    way to paste on a phone or tablet.
                </p>
            {/if}
            <input
                bind:this={fileInput}
                type="file"
                multiple
                class="hidden"
                data-testid="asset-file-input"
                onchange={(e) =>
                    handleFiles(
                        Array.from(
                            (e.currentTarget as HTMLInputElement).files ?? [],
                        ),
                    )}
            />
        </div>
        <!-- Help as a sibling, not inside the label, so the box's accessible name is the two
             words and the sentence is its description (the pattern in ProtectionSettingsTab). -->
        <div>
            <label
                class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300"
            >
                <input
                    type="checkbox"
                    bind:checked={optimizeImages}
                    data-testid="asset-optimize-images"
                    aria-describedby="asset-optimize-images-help"
                    class="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600"
                />
                <span>Optimise images</span>
            </label>
            <p
                id="asset-optimize-images-help"
                class="mt-1 text-sm text-gray-500 dark:text-gray-400"
            >
                Untick to keep the originals for this upload.
            </p>
        </div>
        {#if error}
            <p
                role="alert"
                class="text-sm text-red-600 dark:text-red-400"
                data-testid="asset-upload-error"
            >
                {error}
            </p>
        {/if}
    {/snippet}
</Dialog>
