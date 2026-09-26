<script lang="ts">
    import { tick } from "svelte";
    import {
        missingCodeMessage,
        twoFactorFailureMessage,
        type TwoFactorFailure,
        type TwoFactorMode,
    } from "./two-factor-step";

    /**
     * The second step of a password sign-in when the account has two-factor authentication on.
     * Shared by Corporate's sign-in page and the standalone Sync Server portal's, which are
     * separate apps with separate Better Auth clients, so each passes its own verify calls
     * (Corporate adds the signed OAuth query to both).
     *
     * It accepts an authenticator code or one of the backup codes the Account page issued when
     * 2FA was turned on.
     */
    type Verify = (code: string) => Promise<{ error?: TwoFactorFailure | null }>;

    let {
        verifyTotp,
        verifyBackupCode,
        onverified,
        onback,
        ready = true,
    }: {
        verifyTotp: Verify;
        verifyBackupCode: Verify;
        /** Called once a code is accepted and the session exists. Usually navigates away. */
        onverified: () => void;
        /** Return to the password step. */
        onback: () => void;
        /** False until the page has hydrated: a native submit before then would reload it. */
        ready?: boolean;
    } = $props();

    let mode = $state<TwoFactorMode>("totp");
    let code = $state("");
    let error = $state<string | null>(null);
    let verifying = $state(false);
    let input = $state<HTMLInputElement>();

    // The step replaces the password form, so the caret belongs in the code field.
    function focusOnMount(node: HTMLInputElement) {
        node.focus();
    }

    async function submit(event: SubmitEvent) {
        event.preventDefault();
        // Guard the handler, not only the button: Enter can arrive while a request is in flight.
        if (verifying) return;
        const value = code.trim();
        if (!value) {
            error = missingCodeMessage(mode);
            input?.focus();
            return;
        }
        verifying = true;
        error = null;
        const result = await (mode === "totp" ? verifyTotp : verifyBackupCode)(value);
        if (result.error) {
            error = twoFactorFailureMessage(mode, result.error);
            verifying = false;
            input?.focus();
            return;
        }
        // Stay busy: onverified navigates, and the button must not offer a second submit.
        onverified();
    }

    async function switchMode(next: TwoFactorMode) {
        mode = next;
        code = "";
        error = null;
        await tick();
        input?.focus();
    }
</script>

<div class="text-center">
    <div class="flex justify-center mb-4">
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 ring-1 ring-blue-600/20">
            <svg class="h-6 w-6 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
            </svg>
        </div>
    </div>
    <h1 class="text-lg font-semibold text-gray-950">Two-factor authentication</h1>
    <p class="mt-1 text-sm text-gray-500" id="two-factor-instructions">
        {#if mode === "totp"}
            Enter the 6-digit code from your authenticator app
        {:else}
            Enter one of the backup codes you saved when you turned on two-factor authentication. Each code works once.
        {/if}
    </p>
</div>

<form onsubmit={submit} novalidate class="mt-6 space-y-4">
    <div>
        {#if mode === "totp"}
            <label for="two-factor-code" class="block text-sm font-medium text-gray-700 mb-1.5">Authenticator code</label>
            <input
                bind:this={input}
                {@attach focusOnMount}
                id="two-factor-code"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="6"
                bind:value={code}
                placeholder="000000"
                aria-invalid={!!error}
                aria-describedby={error ? "two-factor-instructions two-factor-error" : "two-factor-instructions"}
                class={[
                    "block w-full rounded-lg border bg-white px-3 py-2 text-center text-lg tracking-widest placeholder:text-gray-400 focus:outline-none focus:ring-2 transition-colors",
                    error ? "border-red-300 text-red-900 focus:border-red-500 focus:ring-red-500/10" : "border-gray-300 text-gray-950 focus:border-gray-950 focus:ring-gray-950/10",
                ]}
            />
        {:else}
            <!-- Backup codes look like "LDR6D-nBJCn": letters, digits and a hyphen, case-sensitive,
                 so no numeric keyboard, no length cap, no autocorrect and no autofill. -->
            <label for="two-factor-code" class="block text-sm font-medium text-gray-700 mb-1.5">Backup code</label>
            <input
                bind:this={input}
                id="two-factor-code"
                type="text"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                bind:value={code}
                placeholder="xxxxx-xxxxx"
                aria-invalid={!!error}
                aria-describedby={error ? "two-factor-instructions two-factor-error" : "two-factor-instructions"}
                class={[
                    "block w-full rounded-lg border bg-white px-3 py-2 text-center font-mono text-lg tracking-wider placeholder:text-gray-400 focus:outline-none focus:ring-2 transition-colors",
                    error ? "border-red-300 text-red-900 focus:border-red-500 focus:ring-red-500/10" : "border-gray-300 text-gray-950 focus:border-gray-950 focus:ring-gray-950/10",
                ]}
            />
        {/if}
        {#if error}
            <p id="two-factor-error" role="alert" class="mt-1.5 text-sm text-red-600">{error}</p>
        {/if}
    </div>

    <button type="submit" disabled={verifying || !ready} class="mt-2 w-full rounded-lg bg-gray-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
        {verifying ? "Verifying…" : "Verify"}
    </button>
</form>

<div class="mt-6 flex flex-col items-center gap-3 text-sm text-gray-500">
    {#if mode === "totp"}
        <button type="button" onclick={() => switchMode("backup")} disabled={verifying} class="font-medium text-gray-950 hover:underline disabled:opacity-50">Use a backup code</button>
    {:else}
        <button type="button" onclick={() => switchMode("totp")} disabled={verifying} class="font-medium text-gray-950 hover:underline disabled:opacity-50">Use an authenticator code</button>
    {/if}
    <button type="button" onclick={onback} disabled={verifying} class="font-medium text-gray-950 hover:underline disabled:opacity-50">Back to sign in</button>
</div>
