<script lang="ts">
    import { useHydrated } from "../forms/hydration.svelte";
    import { focusFirstInvalid } from "../ui/index.svelte";
    import { touchAll, visibleErrors } from "../forms/field-errors";
    import type { PasswordResetAuthClient } from "../auth/page-clients";
    import AlertBanner from "../components/AlertBanner.svelte";
    import { page } from "$app/state";

    let { authClient }: { authClient: PasswordResetAuthClient } = $props();

    let password = $state("");
    let confirmPassword = $state("");
    let loading = $state(false);
    let formError = $state<string | null>(null);
    let fieldErrors = $state<{ password?: string; confirm?: string }>({});
    let success = $state(false);
    // This form submits in JavaScript, so the button must not be pressable before the
    // handler exists - a click landing then submits natively and silently reloads the page.
    const hydrated = useHydrated();

    const token = $derived(page.url.searchParams.get("token") ?? "");

    const inputBase = "block w-full rounded-lg border bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 transition-colors";
    const inputNormal = "border-gray-300 text-gray-950 focus:border-gray-950 focus:ring-gray-950/10";
    const inputError = "border-red-300 text-red-900 focus:border-red-500 focus:ring-red-500/10";

    function validate(): boolean {
        const errors: typeof fieldErrors = {};
        if (!password) {
            errors.password = "Password is required";
        } else if (password.length < 8) {
            errors.password = "Password must be at least 8 characters";
        }
        if (!confirmPassword) {
            errors.confirm = "Please confirm your new password";
        } else if (password !== confirmPassword) {
            errors.confirm = "Passwords do not match";
        }
        fieldErrors = errors;
        return Object.keys(errors).length === 0;
    }

    // Rule 6: validate on blur, then eagerly once a field has errored. `validate()` computes
    // every field at once, so `touched` is what stops a single blur lighting up the whole form.
    const FIELDS = ["password", "confirm"] as const;
    let touched = $state<Record<string, boolean>>({});

    function revalidate() {
        validate();
        fieldErrors = visibleErrors(fieldErrors, touched);
    }

    function blurField(field: (typeof FIELDS)[number]) {
        touched = { ...touched, [field]: true };
        revalidate();
    }

    function inputField(field: (typeof FIELDS)[number]) {
        if (fieldErrors[field]) revalidate();
    }

    /** Submit-time validation reveals everything, and puts the caret where the first fix is. */
    function validateOnSubmit(): boolean {
        touched = touchAll(touched, FIELDS);
        const ok = validate();
        if (!ok) void focusFirstInvalid();
        return ok;
    }


    async function handleSubmit(e: SubmitEvent) {
        e.preventDefault();
        if (!validateOnSubmit()) return;
        loading = true;
        formError = null;
        const result = await authClient.resetPassword({
            newPassword: password,
            token,
        });
        if (result.error) {
            formError = result.error.message ?? "Failed to reset password. The link may have expired.";
        } else {
            success = true;
        }
        loading = false;
    }
</script>

<svelte:head>
    <title>Reset Password - EtherPK</title>
</svelte:head>

<div>
    {#if success}
        <div class="text-center">
            <div class="flex justify-center mb-4">
                <div class="flex h-12 w-12 items-center justify-center rounded-full bg-green-50 ring-1 ring-green-600/20">
                    <svg class="h-6 w-6 text-green-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                        <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clip-rule="evenodd" />
                    </svg>
                </div>
            </div>
            <h1 class="text-lg font-semibold text-gray-950">Password reset</h1>
            <p class="mt-2 text-sm text-gray-500">Your password has been successfully reset.</p>
            <p class="mt-4 text-sm text-gray-500">
                <a href="/login" class="font-medium text-gray-950 hover:underline">Sign in with your new password</a>
            </p>
        </div>
    {:else if !token}
        <div class="text-center">
            <h1 class="text-lg font-semibold text-gray-950">Invalid reset link</h1>
            <p class="mt-2 text-sm text-gray-500">This password reset link is invalid or has expired.</p>
            <p class="mt-4 text-sm text-gray-500">
                <a href="/forgot-password" class="font-medium text-gray-950 hover:underline">Request a new reset link</a>
            </p>
        </div>
    {:else}
        <h1 class="text-lg font-semibold text-gray-950 text-center">Set a new password</h1>
        <p class="mt-1 text-sm text-center text-gray-500">Enter your new password below</p>

        {#if formError}
            <div class="mt-4">
                <AlertBanner variant="error" message={formError} />
            </div>
        {/if}

        <form onsubmit={handleSubmit} novalidate class="mt-6 space-y-4">
            <div>
                <label for="password" class="block text-sm font-medium text-gray-700 mb-1.5">New password</label>
                <input id="password" onblur={() => blurField("password")} oninput={() => inputField("password")} type="password" bind:value={password} autocomplete="new-password" placeholder="Min. 8 characters" aria-invalid={!!fieldErrors.password} aria-describedby={fieldErrors.password ? "pw-error" : undefined} class="{inputBase} {fieldErrors.password ? inputError : inputNormal}" />
                {#if fieldErrors.password}
                    <p id="pw-error" class="mt-1 text-sm text-red-600">{fieldErrors.password}</p>
                {/if}
            </div>

            <div>
                <label for="confirmPassword" class="block text-sm font-medium text-gray-700 mb-1.5">Confirm new password</label>
                <input id="confirmPassword" onblur={() => blurField("confirm")} oninput={() => inputField("confirm")} type="password" bind:value={confirmPassword} autocomplete="new-password" placeholder="Repeat new password" aria-invalid={!!fieldErrors.confirm} aria-describedby={fieldErrors.confirm ? "confirm-error" : undefined} class="{inputBase} {fieldErrors.confirm ? inputError : inputNormal}" />
                {#if fieldErrors.confirm}
                    <p id="confirm-error" class="mt-1 text-sm text-red-600">{fieldErrors.confirm}</p>
                {/if}
            </div>

            <button type="submit" disabled={loading || !hydrated.ready} class="mt-2 w-full rounded-lg bg-gray-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {loading ? "Resetting…" : "Reset password"}
            </button>
        </form>

        <p class="mt-6 text-center text-sm text-gray-500">
            <a href="/login" class="font-medium text-gray-950 hover:underline">Back to sign in</a>
        </p>
    {/if}
</div>
