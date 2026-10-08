<script lang="ts">
    import { useHydrated } from "../forms/hydration.svelte";
    import { focusFirstInvalid, textFieldClass } from "../ui/index.svelte";
    import { touchAll, visibleErrors } from "../forms/field-errors";
    import type { PasswordResetAuthClient } from "../auth/page-clients";
    import { PASSWORD_HELP, WEAK_PASSWORD_CODE } from "../auth/password-strength";
    import AlertBanner from "../components/AlertBanner.svelte";
    import { page } from "$app/state";
    import { replaceState } from "$app/navigation";
    import { onMount } from "svelte";
    import { pathWithQuery } from "../navigation/sign-in-return";

    let {
        authClient,
        signInQuery = "",
    }: {
        authClient: PasswordResetAuthClient;
        /**
         * The query of the sign-in the reset was asked for from, as the forgotten-password page
         * put it in the email's link and the app's server checked it: a `redirect`, or on
         * Corporate a managed sign-in's signed request. The way back to sign in carries it.
         */
        signInQuery?: string;
    } = $props();

    const signInHref = $derived(pathWithQuery("/login", signInQuery));
    const forgotPasswordHref = $derived(pathWithQuery("/forgot-password", signInQuery));

    let password = $state("");
    let confirmPassword = $state("");
    let loading = $state(false);
    let formError = $state<string | null>(null);
    let fieldErrors = $state<{ password?: string; confirm?: string }>({});
    let success = $state(false);
    // This form submits in JavaScript, so the button must not be pressable before the
    // handler exists - a click landing then submits natively and silently reloads the page.
    const hydrated = useHydrated();

    // Read once: the token is taken out of the address bar as soon as the page has it, so it
    // is not left in history, in a Referer, or for any script that reads location. A reload
    // after that shows the invalid-link state; the emailed link works again until it is used or
    // expires.
    const token = page.url.searchParams.get("token") ?? "";

    onMount(() => {
        if (!page.url.searchParams.has("token")) return;
        const withoutToken = new URL(page.url);
        withoutToken.searchParams.delete("token");
        // On a first page load this runs while SvelteKit is still starting its router, and
        // replaceState throws until it has. The router finishes in the same task, so the next
        // task is soon enough.
        const timer = setTimeout(() => replaceState(withoutToken, page.state), 0);
        return () => clearTimeout(timer);
    });

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
        if (result.error?.code === WEAK_PASSWORD_CODE) {
            // Refused by the server's password rule: say why at the field, keep what was typed.
            touched = { ...touched, password: true };
            fieldErrors = { ...fieldErrors, password: result.error.message ?? "Choose a password that is harder to guess." };
            void focusFirstInvalid();
        } else if (result.error) {
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
                <a href={signInHref} class="font-medium text-gray-950 hover:underline">Sign in with your new password</a>
            </p>
        </div>
    {:else if !token}
        <div class="text-center">
            <h1 class="text-lg font-semibold text-gray-950">Invalid reset link</h1>
            <p class="mt-2 text-sm text-gray-500">This password reset link is invalid or has expired. If you reloaded this page, open the link in your email again.</p>
            <p class="mt-4 text-sm text-gray-500">
                <a href={forgotPasswordHref} class="font-medium text-gray-950 hover:underline">Request a new reset link</a>
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
                <input id="password" onblur={() => blurField("password")} oninput={() => inputField("password")} type="password" bind:value={password} autocomplete="new-password" aria-invalid={!!fieldErrors.password} aria-describedby={fieldErrors.password ? "pw-error pw-help" : "pw-help"} class={textFieldClass(!!fieldErrors.password)} />
                {#if fieldErrors.password}
                    <p id="pw-error" class="mt-1 text-sm text-red-600">{fieldErrors.password}</p>
                {/if}
                <p id="pw-help" class="mt-1 text-sm text-gray-500">{PASSWORD_HELP}</p>
            </div>

            <div>
                <label for="confirmPassword" class="block text-sm font-medium text-gray-700 mb-1.5">Confirm new password</label>
                <input id="confirmPassword" onblur={() => blurField("confirm")} oninput={() => inputField("confirm")} type="password" bind:value={confirmPassword} autocomplete="new-password" placeholder="Repeat new password" aria-invalid={!!fieldErrors.confirm} aria-describedby={fieldErrors.confirm ? "confirm-error" : undefined} class={textFieldClass(!!fieldErrors.confirm)} />
                {#if fieldErrors.confirm}
                    <p id="confirm-error" class="mt-1 text-sm text-red-600">{fieldErrors.confirm}</p>
                {/if}
            </div>

            <button type="submit" disabled={loading || !hydrated.ready} class="mt-2 w-full rounded-lg bg-gray-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {loading ? "Resetting…" : "Reset password"}
            </button>
        </form>

        <p class="mt-6 text-center text-sm text-gray-500">
            <a href={signInHref} class="font-medium text-gray-950 hover:underline">Back to sign in</a>
        </p>
    {/if}
</div>
