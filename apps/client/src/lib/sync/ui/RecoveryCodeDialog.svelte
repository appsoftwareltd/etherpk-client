<script lang="ts">
    /**
     * The one-time Recovery Code ritual. The code is shown once and never again, so the
     * confirm action stays disabled until the user has copied (or downloaded) it and ticked
     * the acknowledgement, making the "you will not see this again" point unmissable.
     *
     * Two arrivals, one shape: nothing is written until confirm. A FIRST mint has written
     * nothing yet (ADR 0029 rung 1), so abandoning it loses nothing and the user simply
     * retries. A REGENERATE has not touched the vault either (ADR 0029, amended 2026-09-17):
     * the current code keeps working until confirm retires it, which is why only that arrival
     * offers a way out - "Keep current code" - and why its confirm names the destructive half.
     * Neither arrival needs a tab-close guard: closing the tab on either changes nothing.
     */
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";

    let {
        code,
        arrival,
        reason,
        onconfirm,
        oncancel,
    }: {
        code: string;
        /** A first mint has no code before it; a regenerate replaces one that still works. */
        arrival: "first" | "regenerate";
        /** Why the ritual appeared now, e.g. keys minted for an account that had none. */
        reason?: string;
        onconfirm: () => void;
        /** Regenerate only: dismiss without retiring the current code. */
        oncancel?: () => void;
    } = $props();

    let open = $state(true);
    let copied = $state(false);
    let saveError = $state<string | null>(null);
    let acknowledged = $state(false);

    const regenerate = $derived(arrival === "regenerate");
    const title = $derived(regenerate ? "Save your new Recovery Code" : "Save your Recovery Code");
    const acknowledgement = $derived(
        regenerate ? "I have saved my new Recovery Code somewhere safe." : "I have saved my Recovery Code somewhere safe.",
    );
    // The regenerate confirm names the destructive half first: it is the moment the current
    // code stops working, and a plain "Continue" would hide that.
    const confirmLabel = $derived(regenerate ? "Retire old code and use this one" : "Continue");

    async function copy() {
        saveError = null;
        try {
            // `navigator.clipboard` is undefined outside a secure context and writeText rejects
            // when the document is not focused or permission is refused. Reporting neither left
            // the user free to tick "I have saved it" having saved nothing.
            await navigator.clipboard.writeText(code);
            copied = true;
        } catch {
            saveError =
                "Your browser blocked the clipboard. Select the code above and copy it by hand, or use Download.";
        }
    }

    function download() {
        saveError = null;
        try {
            const blob = new Blob(
                [`EtherPK Recovery Code\n\n${code}\n\nKeep this safe. It is the only way to restore access to your encrypted notes.\n`],
                { type: "text/plain" },
            );
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "etherpk-recovery-code.txt";
            // Attached before the click and revoked well after it: revoking in the same tick
            // cancels the transfer in some browsers, which then reported as a successful save.
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
            copied = true;
        } catch {
            saveError = "The download could not start. Copy the code above by hand instead.";
        }
    }

    function cancel() {
        open = false;
        oncancel?.();
    }
</script>

<Modal {open} {title} closeOnBackdrop={false} onclose={oncancel ? cancel : undefined}>
    {#snippet body()}
        {#if reason}
            <p data-testid="recovery-reason" class="text-sm text-gray-600 dark:text-gray-300">{reason}</p>
        {/if}
        <div class="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/30 p-3">
            <p class="text-sm font-medium text-amber-900 dark:text-amber-200">
                Copy this now. You will not see it again.
            </p>
            <p class="mt-1 text-sm text-amber-800/90 dark:text-amber-200/80">
                It is the only way to restore access to your encrypted notes if you lose every
                signed-in device. Nobody, including us, can recover it for you.
            </p>
        </div>

        <code
            data-testid="recovery-code-value"
            class="block break-all rounded-lg bg-gray-100 dark:bg-white/5 px-4 py-3 text-center text-base font-mono tracking-wide text-gray-950 dark:text-gray-100 select-all"
        >{code}</code>

        <div class="flex gap-2">
            <button
                type="button"
                onclick={copy}
                data-autofocus
                data-testid="recovery-copy"
                class="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
            >
                {copied ? "Copied" : "Copy"}
            </button>
            <button
                type="button"
                onclick={download}
                data-testid="recovery-download"
                class="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
            >
                Download
            </button>
        </div>

        {#if saveError}
            <p role="alert" data-testid="recovery-save-error" class="text-sm text-red-600 dark:text-red-400">{saveError}</p>
        {/if}

        <label class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
                type="checkbox"
                bind:checked={acknowledged}
                data-testid="recovery-ack"
                class="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600"
            />
            <span>{acknowledgement}</span>
        </label>
    {/snippet}

    {#snippet footer()}
        <!-- The disabled confirm's reason is the checkbox label directly above it, which is
             persistent text a keyboard user reaches; a second hint here squashed the buttons. -->
        {#if oncancel}
            <button
                type="button"
                onclick={cancel}
                data-testid="recovery-cancel"
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
            >
                Keep current code
            </button>
        {/if}
        <button
            type="button"
            onclick={() => { open = false; onconfirm(); }}
            disabled={!acknowledged}
            data-testid="recovery-confirm"
            class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
        >
            {confirmLabel}
        </button>
    {/snippet}
</Modal>
