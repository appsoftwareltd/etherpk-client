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
     *
     * Every code belongs to one Sync Server's account (ADR 0111), and a device connected to two
     * servers is given two. The acknowledgement, the download's name and the saved text all name
     * the server, and on a device that holds another server the dialog opens by saying which
     * server this code is for, so a second code never reads as a replacement for the first.
     *
     * A first code on a device with one server shows the warning and the code and little else:
     * nothing above them competes with "copy this now".
     */
    import { saveBlob } from "#lib/native/save-file.js";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import { recoveryCodeFileName, recoveryCodeFileText } from "../recovery-code-file";
    import { serverHost } from "../sync-connections";

    let {
        code,
        arrival,
        reason,
        serverOrigin,
        account = null,
        otherServerHeld = false,
        onconfirm,
        oncancel,
    }: {
        code: string;
        /** The Sync Server whose account this code unlocks. */
        serverOrigin: string;
        /** The account's address on that server, when it has one to name. */
        account?: string | null;
        /**
         * A first mint has no code before it; a regenerate replaces one that still works; a
         * replace (ADR 0128) replaces the code and the keys with it.
         */
        arrival: "first" | "regenerate" | "replace";
        /**
         * This device holds another Sync Server besides this code's, so there may be another code
         * to tell this one from: the dialog then opens by naming the server and the account.
         */
        otherServerHeld?: boolean;
        /**
         * What the person needs to know about this arrival. A regenerate or a replace says what
         * confirming retires, which is read before the code, so it shows above the warning. A
         * first mint has nothing to lose: its one sentence shows under the code.
         */
        reason?: string;
        onconfirm: () => void;
        /** Regenerate only: dismiss without retiring the current code. */
        oncancel?: () => void;
    } = $props();

    let open = $state(true);
    let copied = $state(false);
    let saveError = $state<string | null>(null);
    let acknowledged = $state(false);

    // Both replace a code that still works, so both say "new" and offer a way out.
    const replacing = $derived(arrival !== "first");
    const host = $derived(serverHost(serverOrigin));
    const title = $derived(replacing ? "Save your new Recovery Code" : "Save your Recovery Code");
    const acknowledgement = $derived(
        replacing
            ? `I have saved my new Recovery Code for ${host} somewhere safe.`
            : `I have saved my Recovery Code for ${host} somewhere safe.`,
    );
    // The confirm names the destructive half first: it is the moment the current code (and, on a
    // replace, the current keys) stop working, and a plain "Continue" would hide that.
    const confirmLabel = $derived(
        arrival === "replace"
            ? "Replace Encryption Keys and use this code"
            : arrival === "regenerate"
              ? "Retire old code and use this one"
              : "Continue",
    );
    const cancelLabel = $derived(arrival === "replace" ? "Keep current Encryption Keys" : "Keep current code");

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

    async function download() {
        saveError = null;
        try {
            const blob = new Blob([recoveryCodeFileText({ code, serverOrigin, account })], { type: "text/plain" });
            // Not kept until it is: an app that asks where to save can be told not to.
            if ((await saveBlob(blob, recoveryCodeFileName(serverOrigin))) !== "cancelled") copied = true;
        } catch (error) {
            console.error("[recovery code] could not be saved", error);
            saveError = "The file was not saved. Copy the code above by hand instead.";
        }
    }

    function cancel() {
        open = false;
        oncancel?.();
    }
</script>

<Modal {open} {title} closeOnBackdrop={false} onclose={oncancel ? cancel : undefined}>
    {#snippet body()}
        {#if otherServerHeld}
            <p data-testid="recovery-server" class="text-sm text-neutral-700 dark:text-neutral-200">
                For your account on <span class="font-semibold text-neutral-950 dark:text-white">{host}</span
                >{#if account}&nbsp;({account}){/if}. It unlocks your Encryption Keys on this Sync Server only. A code you
                saved for another Sync Server stays valid and is not replaced by this one: keep each one.
            </p>
        {/if}
        {#if reason && replacing}
            <p data-testid="recovery-reason" class="text-sm text-neutral-600 dark:text-neutral-300">{reason}</p>
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
            class="block break-all rounded-lg bg-neutral-100 dark:bg-white/5 px-4 py-3 text-center text-base font-mono tracking-wide text-neutral-950 dark:text-neutral-100 select-all"
        >{code}</code>

        <div class="flex gap-2">
            <button
                type="button"
                onclick={copy}
                data-autofocus
                data-testid="recovery-copy"
                class="gk-button flex-1"
            >
                {copied ? "Copied" : "Copy"}
            </button>
            <button
                type="button"
                onclick={download}
                data-testid="recovery-download"
                class="gk-button flex-1"
            >
                Download
            </button>
        </div>

        {#if saveError}
            <p role="alert" data-testid="recovery-save-error" class="text-sm text-red-600 dark:text-red-400">{saveError}</p>
        {/if}

        {#if reason && !replacing}
            <p data-testid="recovery-note" class="text-sm text-neutral-600 dark:text-neutral-300">{reason}</p>
        {/if}

        <label class="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
            <input
                type="checkbox"
                bind:checked={acknowledged}
                data-testid="recovery-ack"
                class="gk-checkbox mt-0.5"
            />
            <span data-testid="recovery-ack-label">{acknowledgement}</span>
        </label>
    {/snippet}

    {#snippet footer()}
        <!-- The disabled confirm's reason is the checkbox label directly above it, which is
             persistent text a keyboard user reaches; a second hint here squashed the buttons. -->
        <!-- Both labels say what they do to the keys, so together they are wider than the dialog:
             the buttons stack, and on a narrow phone the confirm's label takes a second line. -->
        <div class="flex min-w-0 flex-wrap justify-end gap-2">
            {#if oncancel}
                <button
                    type="button"
                    onclick={cancel}
                    data-testid="recovery-cancel"
                    class="gk-button max-w-full whitespace-normal"
                >
                    {cancelLabel}
                </button>
            {/if}
            <button
                type="button"
                onclick={() => { open = false; onconfirm(); }}
                disabled={!acknowledged}
                data-testid="recovery-confirm"
                class="gk-button gk-button--primary max-w-full whitespace-normal"
            >
                {confirmLabel}
            </button>
        </div>
    {/snippet}
</Modal>
