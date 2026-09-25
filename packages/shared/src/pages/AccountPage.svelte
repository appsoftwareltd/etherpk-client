<script lang="ts">
    import { uuidv7 } from "uuidv7";
    import QRCode from "qrcode";
    import { focusFirstInvalid } from "../ui/index.svelte";
    import AlertBanner from "../components/AlertBanner.svelte";
    import type { AccountAuthClient } from "../auth/page-clients";

    /**
     * The Server and Corporate account pages were byte-identical, so every fix landed twice.
     * The only app-specific dependency is the Better Auth client, whose plugin sets differ,
     * so it arrives as a prop typed against the exact slice this page calls.
     */
    let {
        data,
        authClient,
    }: {
        data: {
            hasPassword: boolean;
            linkedProviders: Array<{ providerId: string; accountId: string; providerDisplayName: string | null }>;
            passkeys: Array<{ id: string; name: string | null; deviceType: string; backedUp: boolean; createdAt: Date | null }>;
            emailVerificationLastSentAt: Date | string | null;
            user?: { id: string; name: string; email: string; emailVerified: boolean; image?: string | null } | null;
        };
        authClient: AccountAuthClient;
    } = $props();

    const initials = $derived(
        data.user.name
            .split(" ")
            .map((n: string) => n[0])
            .slice(0, 2)
            .join("")
            .toUpperCase(),
    );

    // ── Email change state ─────────────────────────────────────────────────────
    let newEmail = $state("");
    let emailLoading = $state(false);
    let emailError = $state<string | null>(null);
    let emailSuccess = $state<string | null>(null);
    let emailFieldError = $state<string | null>(null);

    async function handleChangeEmail(e: SubmitEvent) {
        e.preventDefault();
        emailFieldError = null;
        if (!newEmail.trim()) {
            emailFieldError = "Email is required";
            void focusFirstInvalid();
            return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
            emailFieldError = "Please enter a valid email address";
            void focusFirstInvalid();
            return;
        }
        emailLoading = true;
        emailError = null;
        emailSuccess = null;
        const result = await authClient.changeEmail({
            newEmail,
            callbackURL: "/account",
        });
        if (result.error) {
            emailError = result.error.message ?? "Failed to change email. Please try again.";
        } else {
            emailSuccess = "Verification email sent to " + newEmail + ". Your email will be updated once you verify the new address.";
            newEmail = "";
        }
        emailLoading = false;
    }

    // ── Connected accounts state ───────────────────────────────────────────────
    // svelte-ignore state_referenced_locally
    let linkedProviders = $state(data.linkedProviders);
    let linkLoading = $state<string | null>(null);
    let unlinkLoading = $state<string | null>(null);
    let accountError = $state<string | null>(null);
    let accountSuccess = $state<string | null>(null);

    const availableProviders = [
        { id: "github", label: "GitHub" },
        { id: "google", label: "Google" },
    ] as const;

    function isLinked(providerId: string) {
        return linkedProviders.some((p: { providerId: string }) => p.providerId === providerId);
    }

    function getDisplayName(providerId: string): string | null {
        const linked = linkedProviders.find((p: { providerId: string }) => p.providerId === providerId);
        return linked?.providerDisplayName ?? null;
    }

    function canUnlink(providerId: string) {
        // Allow unlink only if user has password OR another linked provider
        const otherProviders = linkedProviders.filter((p: { providerId: string }) => p.providerId !== providerId);
        return hasPassword || otherProviders.length > 0;
    }

    async function linkProvider(providerId: string) {
        linkLoading = providerId;
        accountError = null;
        await authClient.linkSocial({
            provider: providerId as "github" | "google",
            callbackURL: "/account",
        });
        linkLoading = null;
    }

    async function unlinkProvider(providerId: string) {
        unlinkLoading = providerId;
        accountError = null;
        accountSuccess = null;
        const result = await authClient.unlinkAccount({ providerId });
        if (result.error) {
            accountError = result.error.message ?? "Failed to unlink account.";
        } else {
            linkedProviders = linkedProviders.filter((p: { providerId: string }) => p.providerId !== providerId);
            accountSuccess = providerId.charAt(0).toUpperCase() + providerId.slice(1) + " account disconnected.";
        }
        unlinkLoading = null;
    }

    // ── MFA state ──────────────────────────────────────────────────────────────
    type MfaStep = "idle" | "confirm-password" | "scan" | "verify" | "disable-confirm";

    // Mutable local state - intentionally diverges from prop after user actions
    // svelte-ignore state_referenced_locally
    let mfaEnabled = $state(data.user.twoFactorEnabled ?? false);
    let mfaStep = $state<MfaStep>("idle");
    let mfaPassword = $state("");
    let mfaQrDataUrl = $state("");
    let mfaSecret = $state("");
    let mfaCode = $state("");
    let mfaBackupCodes = $state<string[]>([]);
    let mfaLoading = $state(false);
    let mfaError = $state<string | null>(null);
    let mfaSuccess = $state<string | null>(null);
    let backupCodesCopied = $state(false);

    async function copyBackupCodes() {
        try {
            await navigator.clipboard.writeText(mfaBackupCodes.join("\n"));
            backupCodesCopied = true;
            setTimeout(() => (backupCodesCopied = false), 2000);
        } catch {
            // Clipboard API unavailable - user can still select the text manually
        }
    }

    function extractSecret(uri: string): string {
        try {
            const url = new URL(uri);
            return url.searchParams.get("secret") ?? "";
        } catch {
            return "";
        }
    }

    async function startMfaEnable() {
        mfaStep = "confirm-password";
        mfaError = null;
        mfaPassword = "";
    }

    async function getMfaUri() {
        mfaLoading = true;
        mfaError = null;
        const result = await authClient.twoFactor.enable({ password: mfaPassword });
        if (result.error) {
            mfaError = result.error.message ?? "Failed to set up two-factor authentication.";
            mfaLoading = false;
            return;
        }
        const data = result.data as { totpURI: string; backupCodes: string[] };
        const uri = data.totpURI;
        mfaBackupCodes = data.backupCodes ?? [];
        mfaSecret = extractSecret(uri);
        try {
            mfaQrDataUrl = await QRCode.toDataURL(uri, { width: 200, margin: 2 });
        } catch {
            mfaQrDataUrl = "";
        }
        mfaStep = "scan";
        mfaLoading = false;
    }

    async function verifyMfaCode() {
        mfaLoading = true;
        mfaError = null;
        const result = await authClient.twoFactor.verifyTotp({ code: mfaCode });
        if (result.error) {
            mfaError = result.error.message ?? "Invalid code. Please try again.";
            mfaLoading = false;
            return;
        }
        mfaEnabled = true;
        mfaStep = "idle";
        mfaSuccess = "Two-factor authentication has been enabled.";
        mfaLoading = false;
        mfaCode = "";
    }

    function startMfaDisable() {
        mfaStep = "disable-confirm";
        mfaError = null;
        mfaPassword = "";
    }

    async function disableMfa() {
        mfaLoading = true;
        mfaError = null;
        const result = await authClient.twoFactor.disable({ password: mfaPassword });
        if (result.error) {
            mfaError = result.error.message ?? "Failed to disable two-factor authentication.";
            mfaLoading = false;
            return;
        }
        mfaEnabled = false;
        mfaStep = "idle";
        mfaSuccess = "Two-factor authentication has been disabled.";
        mfaLoading = false;
        mfaPassword = "";
    }

    function cancelMfa() {
        mfaStep = "idle";
        mfaError = null;
        mfaPassword = "";
        mfaCode = "";
        mfaBackupCodes = [];
    }

    // ── Passkey state ──────────────────────────────────────────────────────────
    type PasskeyStep = "idle" | "add-name" | "rename";

    // svelte-ignore state_referenced_locally
    let passkeys = $state(data.passkeys ?? []);
    let passkeyStep = $state<PasskeyStep>("idle");
    let passkeySupported = $state(false);
    let passkeyLoading = $state(false);
    let passkeyError = $state<string | null>(null);
    let passkeySuccess = $state<string | null>(null);
    let passkeyName = $state("");
    let passkeyDeleteLoading = $state<string | null>(null);
    let passkeyRenameId = $state<string | null>(null);
    let passkeyRenameName = $state("");
    let passkeyRenameLoading = $state(false);

    $effect(() => {
        passkeySupported = typeof window !== "undefined" && !!window.PublicKeyCredential;
    });

    /** Safety check: can the user delete this passkey without losing all sign-in methods? */
    function canDeletePasskey(): boolean {
        const otherPasskeys = passkeys.length > 1;
        const hasOtherMethods = hasPassword || linkedProviders.length > 0;
        return otherPasskeys || hasOtherMethods;
    }

    function startAddPasskey() {
        passkeyStep = "add-name";
        passkeyName = "";
        passkeyError = null;
    }

    async function addPasskey() {
        if (!passkeyName.trim()) {
            passkeyError = "Please enter a name for your passkey";
            return;
        }
        passkeyLoading = true;
        passkeyError = null;
        passkeySuccess = null;

        const result = await authClient.passkey.addPasskey({ name: passkeyName.trim() });
        if (result?.error) {
            passkeyError = result.error.message ?? "Failed to register passkey. Please try again.";
            passkeyLoading = false;
            return;
        }
        // Reload passkeys from server using the passkey list endpoint
        const response = await fetch("/api/auth/passkey/list-user-passkeys", { method: "GET" });
        if (response.ok) {
            try {
                const data = await response.json();
                if (Array.isArray(data)) passkeys = data;
            } catch {
                // Fallback: add optimistically (ID will be wrong but user can refresh)
                passkeys = [
                    ...passkeys,
                    {
                        id: uuidv7(),
                        name: passkeyName.trim(),
                        deviceType: "unknown",
                        backedUp: false,
                        createdAt: new Date(),
                    },
                ];
            }
        }
        passkeySuccess = `Passkey "${passkeyName.trim()}" registered successfully.`;
        passkeyStep = "idle";
        passkeyLoading = false;
        passkeyName = "";
    }

    function cancelPasskey() {
        passkeyStep = "idle";
        passkeyError = null;
        passkeyName = "";
        passkeyRenameId = null;
        passkeyRenameName = "";
    }

    async function deletePasskey(id: string) {
        passkeyDeleteLoading = id;
        passkeyError = null;
        passkeySuccess = null;
        const result = await authClient.passkey.deletePasskey({ id });
        if (result?.error) {
            passkeyError = result.error.message ?? "Failed to remove passkey.";
            passkeyDeleteLoading = null;
            return;
        }
        const removed = passkeys.find((p: { id: string }) => p.id === id);
        passkeys = passkeys.filter((p: { id: string }) => p.id !== id);
        passkeySuccess = `Passkey "${removed?.name || "Unnamed"}" removed.`;
        passkeyDeleteLoading = null;
    }

    function startRenamePasskey(id: string, currentName: string) {
        passkeyStep = "rename";
        passkeyRenameId = id;
        passkeyRenameName = currentName || "";
        passkeyError = null;
    }

    async function renamePasskey() {
        if (!passkeyRenameId || !passkeyRenameName.trim()) {
            passkeyError = "Please enter a name";
            return;
        }
        passkeyRenameLoading = true;
        passkeyError = null;

        // Use the better-auth API directly to update passkey name
        const res = await fetch("/api/auth/passkey/update-passkey", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: passkeyRenameId, name: passkeyRenameName.trim() }),
        });
        if (!res.ok) {
            passkeyError = "Failed to rename passkey.";
            passkeyRenameLoading = false;
            return;
        }

        passkeys = passkeys.map((p) => (p.id === passkeyRenameId ? { ...p, name: passkeyRenameName.trim() } : p));
        passkeySuccess = "Passkey renamed.";
        passkeyStep = "idle";
        passkeyRenameId = null;
        passkeyRenameName = "";
        passkeyRenameLoading = false;
    }

    function formatDate(dateVal: string | Date | null): string {
        if (!dateVal) return "Unknown";
        const d = typeof dateVal === "string" ? new Date(dateVal) : dateVal;
        return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    }

    // ── Password change / set state ────────────────────────────────────────────
    // Mutable local state - intentionally diverges from prop after user actions
    // svelte-ignore state_referenced_locally
    let hasPassword = $state(data.hasPassword);
    let pwCurrent = $state("");
    let pwNew = $state("");
    let pwConfirm = $state("");
    let pwLoading = $state(false);
    let pwError = $state<string | null>(null);
    let pwSuccess = $state<string | null>(null);
    let pwFieldErrors = $state<{ current?: string; new?: string; confirm?: string }>({});

    const inputBase = "block w-full rounded-lg border bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 transition-colors";
    const inputNormal = "border-gray-300 text-gray-950 focus:border-gray-950 focus:ring-gray-950/10";
    const inputErr = "border-red-300 text-red-900 focus:border-red-500 focus:ring-red-500/10";

    function validatePw(): boolean {
        const errors: typeof pwFieldErrors = {};
        if (!pwCurrent) errors.current = "Current password is required";
        if (!pwNew) {
            errors.new = "New password is required";
        } else if (pwNew.length < 8) {
            errors.new = "Password must be at least 8 characters";
        }
        if (!pwConfirm) {
            errors.confirm = "Please confirm your new password";
        } else if (pwNew !== pwConfirm) {
            errors.confirm = "Passwords do not match";
        }
        pwFieldErrors = errors;
        if (Object.keys(errors).length > 0) void focusFirstInvalid();
        return Object.keys(errors).length === 0;
    }

    async function handleSetPassword(e: SubmitEvent) {
        e.preventDefault();
        const errors: typeof pwFieldErrors = {};
        if (!pwNew) {
            errors.new = "Password is required";
        } else if (pwNew.length < 8) {
            errors.new = "Password must be at least 8 characters";
        }
        if (!pwConfirm) {
            errors.confirm = "Please confirm your password";
        } else if (pwNew !== pwConfirm) {
            errors.confirm = "Passwords do not match";
        }
        pwFieldErrors = errors;
        if (Object.keys(errors).length > 0) {
            void focusFirstInvalid();
            return;
        }
        pwLoading = true;
        pwError = null;
        pwSuccess = null;
        const result = (await fetch("/api/v1/account/set-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ newPassword: pwNew }),
        }).then((r) => r.json())) as { status?: boolean; error?: { message: string } };
        if (result.error) {
            pwError = result.error.message ?? "Failed to set password. Please try again.";
        } else {
            pwSuccess = "Password set successfully. You can now sign in with your email and password.";
            hasPassword = true;
            pwNew = "";
            pwConfirm = "";
            pwFieldErrors = {};
        }
        pwLoading = false;
    }

    async function handleChangePassword(e: SubmitEvent) {
        e.preventDefault();
        if (!validatePw()) return;
        pwLoading = true;
        pwError = null;
        pwSuccess = null;
        const result = await authClient.changePassword({
            currentPassword: pwCurrent,
            newPassword: pwNew,
            revokeOtherSessions: false,
        });
        if (result.error) {
            pwError = result.error.message ?? "Failed to change password. Please try again.";
        } else {
            pwSuccess = "Password changed successfully.";
            pwCurrent = "";
            pwNew = "";
            pwConfirm = "";
            pwFieldErrors = {};
        }
        pwLoading = false;
    }

    // ── Email verification state ───────────────────────────────────────────────
    let verificationLoading = $state(false);
    let verificationSuccess = $state<string | null>(null);
    let verificationError = $state<string | null>(null);
    // svelte-ignore state_referenced_locally
    let lastSentAt = $state<Date | null>(data.emailVerificationLastSentAt ? new Date(data.emailVerificationLastSentAt) : null);
    let nowMs = $state(Date.now());

    $effect(() => {
        const id = setInterval(() => (nowMs = Date.now()), 30_000);
        return () => clearInterval(id);
    });

    // Verification JWTs are valid for 1 hour (better-auth default). Outside that
    // window the existing link is useless, so the "last sent" hint becomes noise.
    const VERIFICATION_TTL_MS = 60 * 60 * 1000;

    const lastSentLabel = $derived.by<string | null>(() => {
        if (!lastSentAt) return null;
        const diff = nowMs - lastSentAt.getTime();
        if (diff < 0 || diff > VERIFICATION_TTL_MS) return null;
        if (diff < 60_000) return "Last sent just now";
        const mins = Math.floor(diff / 60_000);
        if (mins < 60) return `Last sent ${mins} minute${mins === 1 ? "" : "s"} ago`;
        return "Last sent about an hour ago";
    });

    async function resendVerification() {
        verificationLoading = true;
        verificationError = null;
        verificationSuccess = null;
        const result = await authClient.sendVerificationEmail({
            email: data.user.email,
            callbackURL: "/account",
        });
        if (result.error) {
            verificationError = result.error.message ?? "Failed to send verification email. Please try again.";
        } else {
            verificationSuccess = `Verification email sent to ${data.user.email}. Check your inbox.`;
            lastSentAt = new Date();
            nowMs = Date.now();
        }
        verificationLoading = false;
    }
</script>

<svelte:head>
    <title>Account - EtherPK</title>
</svelte:head>

<div class="lg:max-w-4xl">
    <div class="mb-8">
        <h1 class="text-2xl font-semibold tracking-tight text-gray-950">Account</h1>
        <p class="mt-1 text-sm text-gray-500">Manage your profile and security settings.</p>
    </div>

    <!-- Profile card -->
    <div class="rounded-xl border border-gray-950/8 bg-white shadow-sm divide-y divide-gray-950/5">
        <div class="px-6 py-5">
            <h2 class="text-sm font-semibold text-gray-950">Profile</h2>
        </div>

        <div class="px-6 py-5 flex items-center gap-4">
            <!-- Avatar -->
            <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gray-950 text-sm font-semibold text-white">
                {initials}
            </div>
            <div class="min-w-0">
                <p class="text-sm font-medium text-gray-950 truncate">{data.user.name}</p>
                <p class="text-sm text-gray-500 truncate">{data.user.email}</p>
            </div>
            <div class="ml-auto">
                {#if data.user.emailVerified}
                    <span class="inline-flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-0.5 text-sm font-medium text-green-700 ring-1 ring-green-600/20">
                        <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                            <path fill-rule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd" />
                        </svg>
                        Verified
                    </span>
                {:else}
                    <span class="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-sm font-medium text-amber-700 ring-1 ring-amber-600/20"> Unverified </span>
                {/if}
            </div>
        </div>

        {#if !data.user.emailVerified}
            <div class="px-6 py-5 space-y-3">
                <div>
                    <p class="text-sm font-medium text-gray-950">Verify your email address</p>
                    <p class="mt-0.5 text-sm text-gray-500">We sent a verification link when you signed up. Didn't receive it? Resend below.</p>
                </div>

                {#if verificationSuccess}
                    <AlertBanner variant="success" message={verificationSuccess} dismissible ondismiss={() => (verificationSuccess = null)} />
                {/if}

                {#if verificationError}
                    <AlertBanner variant="error" message={verificationError} />
                {/if}

                <div class="flex flex-wrap items-center gap-3">
                    <button type="button" onclick={resendVerification} disabled={verificationLoading} class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                        {verificationLoading ? "Sending…" : "Resend verification email"}
                    </button>
                    {#if lastSentLabel}
                        <span class="text-sm text-gray-500">{lastSentLabel}</span>
                    {/if}
                </div>
            </div>
        {/if}
    </div>

    <!-- Email change -->
    <div class="mt-4 rounded-xl border border-gray-950/8 bg-white shadow-sm divide-y divide-gray-950/5">
        <div class="px-6 py-5">
            <h2 class="text-sm font-semibold text-gray-950">Email</h2>
        </div>

        <div class="px-6 py-5 space-y-4">
            <div>
                <p class="text-sm font-medium text-gray-950">Change email address</p>
                <p class="text-sm text-gray-500 mt-0.5">A verification email will be sent to the new address. Your email won't change until you verify it.</p>
            </div>

            {#if emailSuccess}
                <AlertBanner variant="success" message={emailSuccess} dismissible ondismiss={() => (emailSuccess = null)} />
            {/if}

            {#if emailError}
                <AlertBanner variant="error" message={emailError} />
            {/if}

            <form onsubmit={handleChangeEmail} novalidate class="space-y-3">
                <div>
                    <label for="new-email" class="block text-sm font-medium text-gray-700 mb-1">New email address</label>
                    <input id="new-email" type="email" bind:value={newEmail} autocomplete="email" placeholder="new@example.com" aria-invalid={!!emailFieldError} aria-describedby={emailFieldError ? "new-email-error" : undefined} class="{inputBase} {emailFieldError ? inputErr : inputNormal}" />
                    {#if emailFieldError}
                        <p id="new-email-error" class="mt-1 text-sm text-red-600">{emailFieldError}</p>
                    {/if}
                </div>

                <button type="submit" disabled={emailLoading} class="rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    {emailLoading ? "Sending…" : "Change email"}
                </button>
            </form>
        </div>
    </div>

    <!-- Connected accounts -->
    <div class="mt-4 rounded-xl border border-gray-950/8 bg-white shadow-sm divide-y divide-gray-950/5">
        <div class="px-6 py-5">
            <h2 class="text-sm font-semibold text-gray-950">Connected accounts</h2>
        </div>

        <div class="px-6 py-5 space-y-4">
            <p class="text-sm text-gray-500">Link your social accounts for faster sign-in.</p>

            {#if !data.user.emailVerified}
                <p class="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-600/20">Verify your email address before linking a social account.</p>
            {/if}

            {#if accountSuccess}
                <AlertBanner variant="success" message={accountSuccess} dismissible ondismiss={() => (accountSuccess = null)} />
            {/if}

            {#if accountError}
                <AlertBanner variant="error" message={accountError} />
            {/if}

            <div class="space-y-3">
                {#each availableProviders as provider (provider.id)}
                    <div class="flex items-center justify-between gap-4 rounded-lg border border-gray-950/8 px-4 py-3">
                        <div class="flex items-center gap-3">
                            {#if provider.id === "github"}
                                <svg class="h-5 w-5 text-gray-700" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                    <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z" />
                                </svg>
                            {:else}
                                <svg class="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
                                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z" />
                                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z" />
                                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62Z" />
                                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53Z" />
                                </svg>
                            {/if}
                            <div>
                                <p class="text-sm font-medium text-gray-950">{provider.label}</p>
                                {#if isLinked(provider.id)}
                                    <p class="text-sm text-gray-500">{getDisplayName(provider.id) ? `Connected as ${getDisplayName(provider.id)}` : "Connected"}</p>
                                {:else}
                                    <p class="text-sm text-gray-400">Not connected</p>
                                {/if}
                            </div>
                        </div>
                        <div>
                            {#if isLinked(provider.id)}
                                <button onclick={() => unlinkProvider(provider.id)} disabled={!canUnlink(provider.id) || unlinkLoading === provider.id} title={!canUnlink(provider.id) ? "You need at least one sign-in method" : ""} class="text-sm text-red-600 hover:underline disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline">
                                    {unlinkLoading === provider.id ? "Disconnecting…" : "Disconnect"}
                                </button>
                            {:else}
                                <button onclick={() => linkProvider(provider.id)} disabled={linkLoading === provider.id || !data.user.emailVerified} title={!data.user.emailVerified ? "Verify your email address first" : ""} class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                                    {linkLoading === provider.id ? "Connecting…" : "Connect"}
                                </button>
                            {/if}
                        </div>
                    </div>
                {/each}
            </div>
        </div>
    </div>

    <!-- Security -->
    <div class="mt-4 rounded-xl border border-gray-950/8 bg-white shadow-sm divide-y divide-gray-950/5">
        <div class="px-6 py-5">
            <h2 class="text-sm font-semibold text-gray-950">Security</h2>
        </div>

        <!-- Two-factor authentication -->
        <div class="px-6 py-5 space-y-4">
            <div class="flex items-start justify-between gap-4">
                <div>
                    <p class="text-sm font-medium text-gray-950">Two-factor authentication</p>
                    <p class="text-sm text-gray-500 mt-0.5">Add an extra layer of security with an authenticator app.</p>
                </div>
                <div class="flex items-center gap-3 shrink-0">
                    {#if mfaEnabled}
                        <span class="inline-flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-0.5 text-sm font-medium text-green-700 ring-1 ring-green-600/20">
                            <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd" /></svg>
                            Enabled
                        </span>
                        <button onclick={startMfaDisable} class="text-sm text-red-600 hover:underline">Disable</button>
                    {:else}
                        <button onclick={startMfaEnable} class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors">Enable</button>
                    {/if}
                </div>
            </div>

            {#if mfaSuccess}
                <AlertBanner variant="success" message={mfaSuccess} dismissible ondismiss={() => (mfaSuccess = null)} />
            {/if}

            {#if mfaError && mfaStep === "idle"}
                <AlertBanner variant="error" message={mfaError} />
            {/if}

            <!-- Confirm password to start enable flow -->
            {#if mfaStep === "confirm-password"}
                <div class="rounded-lg border border-gray-950/8 bg-gray-50 p-4 space-y-3">
                    <p class="text-sm font-medium text-gray-700">Enter your current password to continue</p>
                    {#if mfaError}
                        <AlertBanner variant="error" message={mfaError} />
                    {/if}
                    <input type="password" bind:value={mfaPassword} placeholder="Current password" autocomplete="current-password" class="{inputBase} {inputNormal}" />
                    <div class="flex gap-2">
                        <button onclick={getMfaUri} disabled={mfaLoading || !mfaPassword} class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                            {mfaLoading ? "Loading…" : "Continue"}
                        </button>
                        <button onclick={cancelMfa} class="rounded-lg border border-gray-950/15 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors">Cancel</button>
                    </div>
                </div>
            {/if}

            <!-- Scan QR code -->
            {#if mfaStep === "scan"}
                <div class="rounded-lg border border-gray-950/8 bg-gray-50 p-4 space-y-4">
                    <div>
                        <p class="text-sm font-medium text-gray-950">1. Scan this QR code with your authenticator app</p>
                        <p class="text-sm text-gray-500 mt-0.5">Use Google Authenticator, Authy, or any TOTP-compatible app.</p>
                    </div>
                    {#if mfaQrDataUrl}
                        <div class="flex justify-center">
                            <img src={mfaQrDataUrl} alt="TOTP QR code" width="200" height="200" class="rounded-lg" />
                        </div>
                    {/if}
                    <div>
                        <p class="text-sm font-medium text-gray-700">Can't scan? Enter this secret manually:</p>
                        <code class="mt-1 block rounded bg-white border border-gray-200 px-3 py-2 text-sm font-mono text-gray-950 select-all break-all">{mfaSecret}</code>
                    </div>
                    {#if mfaBackupCodes.length > 0}
                        <div class="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
                            <div class="flex items-center justify-between gap-2">
                                <p class="text-sm font-semibold text-amber-800">Save your backup codes</p>
                                <button type="button" onclick={copyBackupCodes} class="inline-flex items-center gap-1 rounded-md bg-amber-100 border border-amber-300 px-2 py-1 text-sm font-medium text-amber-800 hover:bg-amber-200 transition-colors">
                                    {#if backupCodesCopied}
                                        <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                                            <path fill-rule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" clip-rule="evenodd" />
                                        </svg>
                                        Copied!
                                    {:else}
                                        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                                            <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 7.5V6.108c0-1.135.845-2.098 1.976-2.192.373-.03.748-.057 1.123-.08M15.75 18H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08M15.75 18.75v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5A3.375 3.375 0 0 0 6.375 7.5H5.25m11.9-3.664A2.251 2.251 0 0 0 15 2.25h-1.5a2.251 2.251 0 0 0-2.15 1.586m5.8 0c.065.21.1.433.1.664v.75h-6V4.5c0-.231.035-.454.1-.664M6.75 7.5H4.875c-.621 0-1.125.504-1.125 1.125v12c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V16.5a9 9 0 0 0-9-9Z" />
                                        </svg>
                                        Copy codes
                                    {/if}
                                </button>
                            </div>
                            <p class="text-sm text-amber-700">Store these somewhere safe. Each code can only be used once if you lose access to your authenticator app.</p>
                            <div class="grid grid-cols-2 gap-1 mt-2">
                                {#each mfaBackupCodes as code (code)}
                                    <code class="rounded bg-white border border-amber-200 px-2 py-1 text-sm font-mono text-gray-950 select-all">{code}</code>
                                {/each}
                            </div>
                        </div>
                    {/if}
                    <div>
                        <p class="text-sm font-medium text-gray-700 mb-1.5">2. Enter the 6-digit code from your app</p>
                        {#if mfaError}
                            <div class="mb-2">
                                <AlertBanner variant="error" message={mfaError} />
                            </div>
                        {/if}
                        <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" bind:value={mfaCode} placeholder="000000" autocomplete="one-time-code" class="{inputBase} {inputNormal} font-mono tracking-widest" />
                    </div>
                    <div class="flex gap-2">
                        <button onclick={verifyMfaCode} disabled={mfaLoading || mfaCode.length !== 6} class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                            {mfaLoading ? "Verifying…" : "Verify & Enable"}
                        </button>
                        <button onclick={cancelMfa} class="rounded-lg border border-gray-950/15 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors">Cancel</button>
                    </div>
                </div>
            {/if}

            <!-- Disable confirmation -->
            {#if mfaStep === "disable-confirm"}
                <div class="rounded-lg border border-red-200 bg-red-50 p-4 space-y-3">
                    <p class="text-sm font-medium text-red-700">Enter your current password to disable two-factor authentication</p>
                    {#if mfaError}
                        <AlertBanner variant="error" message={mfaError} />
                    {/if}
                    <input type="password" bind:value={mfaPassword} placeholder="Current password" autocomplete="current-password" class="{inputBase} {inputNormal}" />
                    <div class="flex gap-2">
                        <button onclick={disableMfa} disabled={mfaLoading || !mfaPassword} class="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                            {mfaLoading ? "Disabling…" : "Disable 2FA"}
                        </button>
                        <button onclick={cancelMfa} class="rounded-lg border border-gray-950/15 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors">Cancel</button>
                    </div>
                </div>
            {/if}
        </div>

        <!-- Passkeys -->
        <div class="px-6 py-5 space-y-4">
            <div class="flex items-start justify-between gap-4">
                <div>
                    <p class="text-sm font-medium text-gray-950">Passkeys</p>
                    <p class="text-sm text-gray-500 mt-0.5">Sign in with your fingerprint, face, or screen lock instead of a password.</p>
                </div>
                {#if passkeySupported && passkeyStep === "idle"}
                    <button onclick={startAddPasskey} class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors shrink-0">Add a passkey</button>
                {/if}
            </div>

            {#if passkeySuccess}
                <AlertBanner variant="success" message={passkeySuccess} dismissible ondismiss={() => (passkeySuccess = null)} />
            {/if}

            {#if passkeyError && passkeyStep === "idle"}
                <AlertBanner variant="error" message={passkeyError} />
            {/if}

            {#if !passkeySupported}
                <p class="text-sm text-gray-400">Your browser doesn't support passkeys (WebAuthn).</p>
            {/if}

            <!-- Add passkey: name prompt -->
            {#if passkeyStep === "add-name"}
                <div class="rounded-lg border border-gray-950/8 bg-gray-50 p-4 space-y-3">
                    <p class="text-sm font-medium text-gray-700">Name your passkey</p>
                    <p class="text-sm text-gray-500">Give it a recognisable name so you can identify it later.</p>
                    {#if passkeyError}
                        <AlertBanner variant="error" message={passkeyError} />
                    {/if}
                    <input type="text" bind:value={passkeyName} placeholder="e.g. MacBook Pro Touch ID" maxlength="100" class="{inputBase} {inputNormal}" />
                    <div class="flex gap-2">
                        <button onclick={addPasskey} disabled={passkeyLoading || !passkeyName.trim()} class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                            {passkeyLoading ? "Waiting for browser…" : "Continue"}
                        </button>
                        <button onclick={cancelPasskey} class="rounded-lg border border-gray-950/15 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors">Cancel</button>
                    </div>
                </div>
            {/if}

            <!-- Rename passkey -->
            {#if passkeyStep === "rename"}
                <div class="rounded-lg border border-gray-950/8 bg-gray-50 p-4 space-y-3">
                    <p class="text-sm font-medium text-gray-700">Rename passkey</p>
                    {#if passkeyError}
                        <AlertBanner variant="error" message={passkeyError} />
                    {/if}
                    <input type="text" bind:value={passkeyRenameName} placeholder="New name" maxlength="100" class="{inputBase} {inputNormal}" />
                    <div class="flex gap-2">
                        <button onclick={renamePasskey} disabled={passkeyRenameLoading || !passkeyRenameName.trim()} class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                            {passkeyRenameLoading ? "Saving…" : "Save"}
                        </button>
                        <button onclick={cancelPasskey} class="rounded-lg border border-gray-950/15 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors">Cancel</button>
                    </div>
                </div>
            {/if}

            <!-- Passkey list -->
            {#if passkeys.length > 0}
                <div class="space-y-2">
                    {#each passkeys as pk (pk.id)}
                        <div class="flex items-center justify-between gap-3 rounded-lg border border-gray-950/8 px-4 py-3">
                            <div class="flex items-center gap-3 min-w-0">
                                <svg class="h-5 w-5 text-gray-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M7.864 4.243A7.5 7.5 0 0 1 19.5 10.5c0 2.92-.556 5.709-1.568 8.268M5.742 6.364A7.465 7.465 0 0 0 4.5 10.5a7.464 7.464 0 0 1-1.15 3.993m1.989 3.559A11.209 11.209 0 0 0 8.25 10.5a3.75 3.75 0 1 1 7.5 0c0 .527-.021 1.049-.064 1.565M12 10.5a14.94 14.94 0 0 1-3.6 9.75m6.633-4.596a18.666 18.666 0 0 1-2.485 5.33" />
                                </svg>
                                <div class="min-w-0">
                                    <p class="text-sm font-medium text-gray-950 truncate">{pk.name || "Unnamed passkey"}</p>
                                    <div class="flex items-center gap-2 text-sm text-gray-500">
                                        <span>Added {formatDate(pk.createdAt)}</span>
                                        {#if pk.backedUp}
                                            <span class="inline-flex items-center gap-0.5 rounded-full bg-blue-50 px-1.5 py-0.5 text-sm text-blue-600 ring-1 ring-blue-600/20">
                                                <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                                    <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15a4.5 4.5 0 0 0 4.5 4.5H18a3.75 3.75 0 0 0 1.332-7.257 3 3 0 0 0-3.758-3.848 5.25 5.25 0 0 0-10.233 2.33A4.502 4.502 0 0 0 2.25 15Z" />
                                                </svg>
                                                Synced
                                            </span>
                                        {/if}
                                    </div>
                                </div>
                            </div>
                            <div class="flex items-center gap-2 shrink-0">
                                <button onclick={() => startRenamePasskey(pk.id, pk.name ?? "")} class="text-sm text-gray-500 hover:text-gray-950 hover:underline">Rename</button>
                                {#if canDeletePasskey()}
                                    <button onclick={() => deletePasskey(pk.id)} disabled={passkeyDeleteLoading === pk.id} class="text-sm text-red-600 hover:underline disabled:opacity-50 disabled:cursor-not-allowed">
                                        {passkeyDeleteLoading === pk.id ? "Removing…" : "Remove"}
                                    </button>
                                {:else}
                                    <span class="text-sm text-gray-400" title="This is your only sign-in method">Remove</span>
                                {/if}
                            </div>
                        </div>
                    {/each}
                </div>
            {:else if passkeySupported && passkeyStep === "idle"}
                <p class="text-sm text-gray-400">No passkeys registered. Add one to sign in without a password.</p>
            {/if}
        </div>

        <!-- Password change / set -->
        <div class="px-6 py-5 space-y-4">
            <div>
                <p class="text-sm font-medium text-gray-950">{hasPassword ? "Change password" : "Set a password"}</p>
                <p class="text-sm text-gray-500 mt-0.5">
                    {#if hasPassword}
                        Update your account password.
                    {:else}
                        You signed in with a social account (e.g. GitHub or Google) and don't have a password yet. Set one to also sign in with your email and password.
                    {/if}
                </p>
            </div>

            {#if pwSuccess}
                <AlertBanner variant="success" message={pwSuccess} dismissible ondismiss={() => (pwSuccess = null)} />
            {/if}

            {#if pwError}
                <AlertBanner variant="error" message={pwError} />
            {/if}

            {#if hasPassword}
                <form onsubmit={handleChangePassword} novalidate class="space-y-3">
                    <div>
                        <label for="pw-current" class="block text-sm font-medium text-gray-700 mb-1">Current password</label>
                        <input id="pw-current" type="password" bind:value={pwCurrent} autocomplete="current-password" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;" aria-invalid={!!pwFieldErrors.current} aria-describedby={pwFieldErrors.current ? "pw-current-error" : undefined} class="{inputBase} {pwFieldErrors.current ? inputErr : inputNormal}" />
                        {#if pwFieldErrors.current}
                            <p id="pw-current-error" class="mt-1 text-sm text-red-600">{pwFieldErrors.current}</p>
                        {/if}
                    </div>

                    <div>
                        <label for="pw-new" class="block text-sm font-medium text-gray-700 mb-1">New password</label>
                        <input id="pw-new" type="password" bind:value={pwNew} autocomplete="new-password" placeholder="Min. 8 characters" aria-invalid={!!pwFieldErrors.new} aria-describedby={pwFieldErrors.new ? "pw-new-error" : undefined} class="{inputBase} {pwFieldErrors.new ? inputErr : inputNormal}" />
                        {#if pwFieldErrors.new}
                            <p id="pw-new-error" class="mt-1 text-sm text-red-600">{pwFieldErrors.new}</p>
                        {/if}
                    </div>

                    <div>
                        <label for="pw-confirm" class="block text-sm font-medium text-gray-700 mb-1">Confirm new password</label>
                        <input id="pw-confirm" type="password" bind:value={pwConfirm} autocomplete="new-password" placeholder="Repeat new password" aria-invalid={!!pwFieldErrors.confirm} aria-describedby={pwFieldErrors.confirm ? "pw-confirm-error" : undefined} class="{inputBase} {pwFieldErrors.confirm ? inputErr : inputNormal}" />
                        {#if pwFieldErrors.confirm}
                            <p id="pw-confirm-error" class="mt-1 text-sm text-red-600">{pwFieldErrors.confirm}</p>
                        {/if}
                    </div>

                    <button type="submit" disabled={pwLoading} class="rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                        {pwLoading ? "Saving…" : "Update password"}
                    </button>
                </form>
            {:else}
                <form onsubmit={handleSetPassword} novalidate class="space-y-3">
                    <div>
                        <label for="pw-new" class="block text-sm font-medium text-gray-700 mb-1">New password</label>
                        <input id="pw-new" type="password" bind:value={pwNew} autocomplete="new-password" placeholder="Min. 8 characters" aria-invalid={!!pwFieldErrors.new} aria-describedby={pwFieldErrors.new ? "pw-new-error" : undefined} class="{inputBase} {pwFieldErrors.new ? inputErr : inputNormal}" />
                        {#if pwFieldErrors.new}
                            <p id="pw-new-error" class="mt-1 text-sm text-red-600">{pwFieldErrors.new}</p>
                        {/if}
                    </div>

                    <div>
                        <label for="pw-confirm" class="block text-sm font-medium text-gray-700 mb-1">Confirm password</label>
                        <input id="pw-confirm" type="password" bind:value={pwConfirm} autocomplete="new-password" placeholder="Repeat password" aria-invalid={!!pwFieldErrors.confirm} aria-describedby={pwFieldErrors.confirm ? "pw-confirm-error" : undefined} class="{inputBase} {pwFieldErrors.confirm ? inputErr : inputNormal}" />
                        {#if pwFieldErrors.confirm}
                            <p id="pw-confirm-error" class="mt-1 text-sm text-red-600">{pwFieldErrors.confirm}</p>
                        {/if}
                    </div>

                    <button type="submit" disabled={pwLoading} class="rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                        {pwLoading ? "Saving…" : "Set password"}
                    </button>
                </form>
            {/if}
        </div>
    </div>
</div>
