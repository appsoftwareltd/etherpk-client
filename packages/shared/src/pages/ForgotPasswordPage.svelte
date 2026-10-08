<script lang="ts">
    import { useHydrated } from "../forms/hydration.svelte";
    import { focusFirstInvalid, textFieldClass } from "../ui/index.svelte";
    import type { PasswordResetAuthClient } from "../auth/page-clients";
    import AlertBanner from "../components/AlertBanner.svelte";
    import { pathWithQuery } from "../navigation/sign-in-return";

    let {
        authClient,
        mailEnabled = true,
        signInQuery = "",
    }: {
        authClient: PasswordResetAuthClient;
        /** Whether this deployment sends email. Without it no reset link can arrive, so the page says so instead of offering one. */
        mailEnabled?: boolean;
        /**
         * The query of the sign-in this page was reached from, checked by the app's server: a
         * `redirect`, or on Corporate a managed sign-in's signed request. Every way back to the
         * sign-in page carries it, and so does the reset email's link, so the sign-in with the
         * new password still returns to the page the sign-in started on.
         */
        signInQuery?: string;
    } = $props();

    const signInHref = $derived(pathWithQuery("/login", signInQuery));

    let email = $state("");
    let loading = $state(false);
    let formError = $state<string | null>(null);
    let fieldError = $state<string | null>(null);
    let sent = $state(false);
    let sentEmail = $state("");
    // This form submits in JavaScript, so the button must not be pressable before the
    // handler exists - a click landing then submits natively and silently reloads the page.
    const hydrated = useHydrated();

    function validate(): boolean {
        if (!email.trim()) {
            fieldError = "Email is required";
            return false;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            fieldError = "Please enter a valid email address";
            return false;
        }
        fieldError = null;
        return true;
    }

    /**
     * Rule 6: report on blur, then keep reporting eagerly once the field has errored. The
     * "has errored" half is fieldError itself, which is why there is no separate touched flag.
     */
    function blurEmail() {
        validate();
    }

    function inputEmail() {
        if (fieldError) validate();
    }

    function validateOnSubmit(): boolean {
        const ok = validate();
        if (!ok) void focusFirstInvalid();
        return ok;
    }

    async function handleSubmit(e: SubmitEvent) {
        e.preventDefault();
        if (!validateOnSubmit()) return;
        loading = true;
        formError = null;
        const result = await authClient.requestPasswordReset({
            email,
            redirectTo: pathWithQuery("/reset-password", signInQuery),
        });
        if (result.error) {
            formError = result.error.message ?? "Failed to send reset link. Please try again.";
        } else {
            sentEmail = email;
            sent = true;
        }
        loading = false;
    }
</script>

<svelte:head>
    <title>Forgot Password - EtherPK</title>
</svelte:head>

<div>
    {#if !mailEnabled}
        <h1 class="text-lg font-semibold text-gray-950 text-center">Reset your password</h1>
        <p class="mt-2 text-sm text-center text-gray-500" data-testid="password-reset-unavailable">
            This server does not send email, so it cannot send you a reset link. Ask the server's administrator to set a new password for you.
        </p>
        <p class="mt-6 text-center text-sm text-gray-500">
            <a href={signInHref} class="font-medium text-gray-950 hover:underline">Back to sign in</a>
        </p>
    {:else if sent}
        <div class="text-center">
            <div class="flex justify-center mb-4">
                <div class="flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 ring-1 ring-blue-600/20">
                    <svg class="h-6 w-6 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" />
                    </svg>
                </div>
            </div>
            <h1 class="text-lg font-semibold text-gray-950">Check your inbox</h1>
            <p class="mt-2 text-sm text-gray-500">
                If an account exists for <span class="font-medium text-gray-950">{sentEmail}</span>, we've sent a password reset link. The link expires in 1 hour.
            </p>
            <p class="mt-4 text-sm text-gray-500">
                <a href={signInHref} class="font-medium text-gray-950 hover:underline">Back to sign in</a>
            </p>
        </div>
    {:else}
        <h1 class="text-lg font-semibold text-gray-950 text-center">Reset your password</h1>
        <p class="mt-1 text-sm text-center text-gray-500">Enter your email and we'll send you a reset link</p>

        {#if formError}
            <div class="mt-4">
                <AlertBanner variant="error" message={formError} />
            </div>
        {/if}

        <form onsubmit={handleSubmit} novalidate class="mt-6 space-y-4">
            <div>
                <label for="email" class="block text-sm font-medium text-gray-700 mb-1.5">Email</label>
                <input id="email" type="email" bind:value={email} autocomplete="email" placeholder="you@example.com" onblur={blurEmail} oninput={inputEmail} aria-invalid={!!fieldError} aria-describedby={fieldError ? "email-error" : undefined} class={textFieldClass(!!fieldError)} />
                {#if fieldError}
                    <p id="email-error" class="mt-1 text-sm text-red-600">{fieldError}</p>
                {/if}
            </div>

            <button type="submit" disabled={loading || !hydrated.ready} class="mt-2 w-full rounded-lg bg-gray-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {loading ? "Sending…" : "Send reset link"}
            </button>
        </form>

        <p class="mt-6 text-center text-sm text-gray-500">
            Remember your password? <a href={signInHref} class="font-medium text-gray-950 hover:underline">Sign in</a>
        </p>
    {/if}
</div>
