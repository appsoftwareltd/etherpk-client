<script lang="ts">
    /**
     * **Save a copy**: a new PDF with the person's annotations, form values and signatures written in,
     * to a file, into the graph, or both. The PDF in the graph stays as it is. Nothing here clears on a
     * failure, and the dialog stays open while the copy is being made.
     */
    import Dialog from "@appsoftwareltd/etherpk-shared/dialog";

    import { cleanCopyName, copyFileName, describeCopy } from "#lib/document/pdf/copy-name.js";

    import type { PasswordChoice } from "./pdf-save";

    export interface LinkPlace {
        /** `null` is today's Journal Entry. */
        concept: string | null;
        label: string;
    }

    export interface SaveRequest {
        name: string;
        flatten: boolean;
        password: PasswordChoice;
        toFile: boolean;
        toGraph: boolean;
        linkTo: string | null;
    }

    let {
        open,
        name,
        annotated,
        signed,
        hasPassword,
        startWithPasswordRemoved,
        folderGraph,
        hasDigitalSignature,
        linkPlaces,
        defaultLink,
        onclose,
        onsave,
    }: {
        open: boolean;
        name: string;
        annotated: boolean;
        signed: boolean;
        hasPassword: boolean;
        startWithPasswordRemoved: boolean;
        folderGraph: boolean;
        hasDigitalSignature: boolean;
        linkPlaces: LinkPlace[];
        /** Where the link goes unless the person chooses, when not today's journal. */
        defaultLink: string | null;
        onclose: () => void;
        /** Rejects with the reason, which shows in the dialog. */
        onsave: (request: SaveRequest) => Promise<void>;
    } = $props();

    type PasswordMode = "keep" | "remove" | "set";

    let flatten = $state(false);
    let passwordMode = $state<PasswordMode>("keep");
    let newPassword = $state("");
    let confirmPassword = $state("");
    let toFile = $state(true);
    let toGraph = $state(false);
    let linkTo = $state<string>("");
    let typedName = $state<string | null>(null);
    let busy = $state(false);
    let error = $state("");
    let passwordTouched = $state(false);

    // Starts again each time it opens, with the password choice the prompt's tick asked for.
    let wasOpen = false;
    $effect(() => {
        if (open && !wasOpen) {
            flatten = false;
            passwordMode = startWithPasswordRemoved ? "remove" : "keep";
            newPassword = confirmPassword = "";
            toFile = true;
            toGraph = false;
            linkTo = defaultLink ?? "";
            typedName = null;
            error = "";
            passwordTouched = false;
        }
        wasOpen = open;
    });

    const passwordDescription = $derived(passwordMode === "set" ? (hasPassword ? "change" : "keep") : passwordMode === "remove" ? "remove" : "keep");
    const suggested = $derived(
        copyFileName(name, describeCopy({ signed, annotated, password: passwordDescription as "keep" | "remove" | "change" })),
    );
    const fileName = $derived(typedName ?? suggested);

    const mismatch = $derived(passwordMode === "set" && passwordTouched && newPassword !== confirmPassword);
    const emptyPassword = $derived(passwordMode === "set" && passwordTouched && newPassword === "");
    const noDestination = $derived(!toFile && !toGraph);
    const invalidatesSignature = $derived(hasDigitalSignature && (flatten || passwordMode !== "keep"));

    /** What stops the copy being made, in words; empty when nothing does. */
    function problem(): string {
        if (!cleanCopyName(fileName)) return "Give the copy a name.";
        if (passwordMode === "set" && newPassword === "") return "Type a password for the copy.";
        if (passwordMode === "set" && newPassword !== confirmPassword) return "The two passwords do not match.";
        return noDestination ? "Choose where the copy goes." : "";
    }

    async function submit() {
        passwordTouched = true;
        error = problem();
        if (error || busy) return;
        const clean = cleanCopyName(fileName)!;
        busy = true;
        error = "";
        try {
            const password: PasswordChoice = passwordMode === "set" ? { mode: "set", password: newPassword } : { mode: passwordMode };
            await onsave({ name: clean, flatten, password, toFile, toGraph, linkTo: linkTo === "" ? null : linkTo });
            onclose();
        } catch (failure) {
            error = failure instanceof Error ? failure.message : String(failure);
        } finally {
            busy = false;
        }
    }

    const field = "rounded-lg border border-gray-300 bg-(--gk-surface-0) px-2 py-1.5 text-sm font-normal text-(--gk-text-default) dark:border-gray-700";
</script>

<Dialog {open} title="Save a copy" {onclose} {busy} busyReason="Making the copy…" testId="pdf-save-dialog" onsubmit={submit}>
    {#snippet body()}
        <div class="flex flex-col gap-4">
            <p class="text-sm text-(--gk-text-muted)">The PDF in your graph stays as it is. Your annotations and form values are written into the copy.</p>
            <label class="flex flex-col gap-1 text-sm font-medium text-(--gk-text-default)">
                Name
                <input type="text" class={field} value={fileName} oninput={(event) => (typedName = event.currentTarget.value)} data-testid="pdf-save-name" />
            </label>

            <div class="flex flex-col gap-1">
                <label class="flex items-start gap-2 text-sm text-(--gk-text-default)">
                    <input type="checkbox" class="mt-0.5" bind:checked={flatten} data-testid="pdf-save-flatten" />
                    <span>Flatten annotations into the page</span>
                </label>
                {#if flatten}
                    <p class="ml-6 text-sm text-(--gk-text-muted)" data-testid="pdf-save-flatten-note">
                        Flattening makes your annotations part of the page, so the recipient can't move or remove them. It doesn't redact: text underneath stays in the file.
                    </p>
                {/if}
            </div>

            <fieldset class="flex flex-col gap-1.5">
                <legend class="mb-1 text-sm font-medium text-(--gk-text-default)">Password on the copy</legend>
                <label class="flex items-center gap-2 text-sm text-(--gk-text-default)">
                    <input type="radio" name="pdf-save-password" value="keep" bind:group={passwordMode} data-testid="pdf-save-password-keep" />
                    {hasPassword ? "Keep the password" : "No password"}
                </label>
                {#if hasPassword}
                    <label class="flex items-center gap-2 text-sm text-(--gk-text-default)">
                        <input type="radio" name="pdf-save-password" value="remove" bind:group={passwordMode} data-testid="pdf-save-password-remove" />
                        Remove the password
                    </label>
                {/if}
                <label class="flex items-center gap-2 text-sm text-(--gk-text-default)">
                    <input type="radio" name="pdf-save-password" value="set" bind:group={passwordMode} data-testid="pdf-save-password-set" />
                    {hasPassword ? "Change the password" : "Add a password"}
                </label>
                {#if passwordMode === "set"}
                    <div class="ml-6 flex flex-col gap-2">
                        <label class="flex flex-col gap-1 text-sm text-(--gk-text-default)">
                            New password
                            <input type="password" autocomplete="new-password" class={field} bind:value={newPassword} onblur={() => (passwordTouched = true)} aria-invalid={emptyPassword} data-testid="pdf-save-new-password" />
                        </label>
                        <label class="flex flex-col gap-1 text-sm text-(--gk-text-default)">
                            Type it again
                            <input type="password" autocomplete="new-password" class={field} bind:value={confirmPassword} onblur={() => (passwordTouched = true)} aria-invalid={mismatch} data-testid="pdf-save-confirm-password" />
                        </label>
                        {#if mismatch}<p class="text-sm text-red-700 dark:text-red-400" role="alert">The two passwords do not match.</p>{/if}
                        <p class="text-sm text-(--gk-text-muted)">EtherPK does not keep this password. Without it, nobody can open the copy.</p>
                    </div>
                {:else if passwordMode === "remove" && folderGraph}
                    <p class="ml-6 text-sm text-(--gk-text-muted)" data-testid="pdf-save-unlocked-note">Added to the graph, the copy sits unlocked in your folder.</p>
                {/if}
            </fieldset>

            <fieldset class="flex flex-col gap-1.5">
                <legend class="mb-1 text-sm font-medium text-(--gk-text-default)">Where it goes</legend>
                <label class="flex items-center gap-2 text-sm text-(--gk-text-default)">
                    <input type="checkbox" bind:checked={toFile} data-testid="pdf-save-to-file" />
                    A file on this device
                </label>
                <label class="flex items-center gap-2 text-sm text-(--gk-text-default)">
                    <input type="checkbox" bind:checked={toGraph} data-testid="pdf-save-to-graph" />
                    Add to the graph, with a link to it
                </label>
                {#if toGraph}
                    <label class="ml-6 flex flex-col gap-1 text-sm text-(--gk-text-default)">
                        Put the link
                        <select class={field} bind:value={linkTo} data-testid="pdf-save-link-place">
                            {#each linkPlaces as place (place.concept ?? "")}
                                <option value={place.concept ?? ""}>{place.label}</option>
                            {/each}
                        </select>
                    </label>
                {/if}
            </fieldset>

            {#if invalidatesSignature}
                <p class="rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200" role="alert" data-testid="pdf-save-signature-warning">
                    This PDF holds a digital signature. {flatten ? "Flattening" : "Changing the password"} rewrites the file, so that signature will show as invalid.
                </p>
            {:else if hasDigitalSignature}
                <p class="text-sm text-(--gk-text-muted)" data-testid="pdf-save-signature-note">This PDF holds a digital signature. Added annotations can show as a change to the signed file.</p>
            {/if}
            {#if error}<p class="text-sm text-red-700 dark:text-red-400" role="alert" data-testid="pdf-save-error">{error}</p>{/if}
        </div>
    {/snippet}
    {#snippet footer()}
        <div class="flex justify-end gap-2">
            <button type="button" class="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-(--gk-text-default) dark:border-gray-700" onclick={onclose}>Cancel</button>
            <button type="submit" class="rounded-lg bg-(--gk-accent) px-3 py-1.5 text-sm font-medium text-(--gk-surface-0) hover:bg-(--gk-accent-hover)" data-testid="pdf-save-submit">{busy ? "Saving…" : "Save"}</button>
        </div>
    {/snippet}
</Dialog>
