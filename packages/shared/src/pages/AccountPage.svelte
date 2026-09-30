<script lang="ts">
    import { flushSync, tick } from "svelte";
    import { uuidv7 } from "uuidv7";
    import QRCode from "qrcode";
    import { focusFirstInvalid, textFieldClass } from "../ui/index.svelte";
    import AlertBanner from "../components/AlertBanner.svelte";
    import type { AccountAuthClient } from "../auth/page-clients";
    import { verificationResendWaitSeconds } from "../auth/verification-resend";
    import { page } from "$app/state";
    import { SESSION_ENDED_MESSAGE, signInPath } from "../navigation/sign-in-path";
    import { socialFailureMessage } from "../auth/social-failure";
    import { CURRENT_PASSWORD_REQUIRED_CODE, PASSWORD_HELP, WEAK_PASSWORD_CODE } from "../auth/password-strength";
    import { describeDevice } from "../auth/device-name";

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
            linkedProviders: Array<{ id: string; providerId: string; accountId: string; providerDisplayName: string | null }>;
            passkeys: Array<{ id: string; name: string | null; deviceType: string; backedUp: boolean; createdAt: Date | null }>;
            emailVerificationLastSentAt: Date | string | null;
            /** The providers this deployment has credentials for: only those can be connected. */
            socialProviders: { github: boolean; google: boolean };
            /** Where the account is signed in, this browser's session first. Ids only: no session's token reaches the browser. */
            sessions: Array<{ id: string; userAgent: string | null; ipAddress: string | null; createdAt: Date | string; current: boolean }>;
            /** How long an app open on another device keeps access after it is signed out, or null when it loses it at once. */
            openAppsKeepAccessMinutes: number | null;
            /** The Sync Server, whose Access tokens page lists what a sign-out leaves active. */
            syncServerUrl: string;
            /** Whether this deployment sends email; unset means it does. */
            mailEnabled?: boolean;
            user?: { id: string; name: string; email: string; emailVerified: boolean; image?: string | null } | null;
        };
        authClient: AccountAuthClient;
    } = $props();

    // Without mail nothing can verify an address or confirm a new one, so the page offers neither,
    // and linking a social account is not held back for a verification that cannot happen.
    const mailEnabled = $derived(data.mailEnabled !== false);
    const verifyBeforeLinking = $derived(mailEnabled && !data.user.emailVerified);

    const initials = $derived(
        data.user.name
            .split(" ")
            .map((n: string) => n[0])
            .slice(0, 2)
            .join("")
            .toUpperCase(),
    );

    /**
     * The message for a failed request. A 401 means the session behind this page has ended, signed
     * out in another tab or expired: no retry here can succeed, so the banner offers sign-in instead.
     */
    function failureMessage(error: { status?: number; message?: string } | null | undefined, fallback: string): string {
        return error?.status === 401 ? SESSION_ENDED_MESSAGE : (error?.message ?? fallback);
    }

    // ── Keyboard: a step takes focus when it opens and gives it back when it closes ──
    /** Attach to the control a step starts on, so its caret is there as soon as it opens. */
    function focusOnMount(node: HTMLElement) {
        node.focus();
    }

    /** Once a step has closed, put focus on what opened it, or on what now stands in its place. */
    async function refocus(target: () => HTMLElement | undefined) {
        await tick();
        target()?.focus();
    }

    // ── Email change state ─────────────────────────────────────────────────────
    let newEmail = $state("");
    let emailLoading = $state(false);
    let emailError = $state<string | null>(null);
    let emailSuccess = $state<string | null>(null);
    let emailFieldError = $state<string | null>(null);
    // The account's current password, which a change of address needs when it has one.
    let emailPassword = $state("");
    let emailPasswordError = $state<string | null>(null);

    async function handleChangeEmail(e: SubmitEvent) {
        e.preventDefault();
        if (emailLoading) return;
        emailFieldError = null;
        emailPasswordError = null;
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
        if (hasPassword && !emailPassword) {
            emailPasswordError = "Enter your current password to change your email address.";
            void focusFirstInvalid();
            return;
        }
        emailLoading = true;
        emailError = null;
        emailSuccess = null;
        const requested = newEmail.trim();
        const result = await authClient.changeEmail({
            newEmail: requested,
            callbackURL: "/account",
            ...(hasPassword ? { password: emailPassword } : {}),
        });
        if (result.error?.code === CURRENT_PASSWORD_REQUIRED_CODE || result.error?.code === "INVALID_PASSWORD") {
            emailPasswordError = result.error.message ?? "That is not your current password.";
            void focusFirstInvalid();
        } else if (result.error) {
            emailError = failureMessage(result.error, "Failed to change email. Please try again.");
        } else {
            // Better Auth answers an address that already has an account the same way and sends
            // nothing, so say what to expect without claiming that an email went.
            emailSuccess = data.user.emailVerified
                ? `Check ${data.user.email} for a link to confirm the change. It sends a verification link to ${requested}, and your address changes when you open that. If no email arrives, ${requested} may already be in use.`
                : `Check ${requested} for a verification link. Your address changes when you open it. If no email arrives, ${requested} may already be in use.`;
            newEmail = "";
            emailPassword = "";
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

    const PROVIDERS = [
        { id: "github", label: "GitHub" },
        { id: "google", label: "Google" },
    ] as const;

    // A provider this deployment has credentials for, or one the account is already linked to:
    // a link made before a provider was removed still shows, so it can be seen and disconnected.
    const offeredProviders = $derived(PROVIDERS.filter((provider) => data.socialProviders[provider.id] || isLinked(provider.id)));

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

    async function linkProvider(providerId: "github" | "google") {
        if (linkLoading) return;
        linkLoading = providerId;
        accountError = null;
        const result = await authClient.linkSocial({ provider: providerId, callbackURL: "/account" }).catch(() => null);
        // On success the browser is already on its way to the provider; only a refusal stays here.
        if (!result || result.error) accountError = socialFailureMessage("connect", providerId, result?.error);
        linkLoading = null;
    }

    async function unlinkProvider(providerId: string) {
        const linked = linkedProviders.find((p: { providerId: string }) => p.providerId === providerId);
        if (!linked || unlinkLoading) return;
        unlinkLoading = providerId;
        accountError = null;
        accountSuccess = null;
        const label = PROVIDERS.find((provider) => provider.id === providerId)?.label ?? providerId;
        // Better Auth unlinks by the account row's id, not by provider.
        const result = await authClient.unlinkAccount({ accountId: linked.id }).catch(() => null);
        if (!result || result.error) {
            accountError = failureMessage(result?.error, `Could not disconnect ${label}. Try again.`);
        } else {
            linkedProviders = linkedProviders.filter((p: { providerId: string }) => p.providerId !== providerId);
            accountSuccess = `${label} account disconnected.`;
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
    // A missing password or code, said at its field rather than in the step's banner.
    let mfaFieldError = $state<string | null>(null);
    let mfaSuccess = $state<string | null>(null);
    let backupCodesCopied = $state(false);
    let enableButton = $state<HTMLButtonElement>();
    let disableButton = $state<HTMLButtonElement>();

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
        mfaFieldError = null;
        mfaPassword = "";
    }

    async function getMfaUri(e: SubmitEvent) {
        e.preventDefault();
        if (mfaLoading) return;
        if (!mfaPassword) {
            mfaFieldError = "Enter your current password.";
            return;
        }
        mfaFieldError = null;
        mfaLoading = true;
        mfaError = null;
        const result = await authClient.twoFactor.enable({ password: mfaPassword });
        if (result.error) {
            mfaError = failureMessage(result.error, "Failed to set up two-factor authentication.");
            mfaLoading = false;
            return;
        }
        // The page enrols an authenticator app: TOTP, Better Auth's default method and the only
        // one whose answer carries the URI and backup codes.
        const enrolment = result.data;
        if (enrolment?.method !== "totp") {
            mfaError = "Failed to set up two-factor authentication.";
            mfaLoading = false;
            return;
        }
        const uri = enrolment.totpURI;
        mfaBackupCodes = enrolment.backupCodes;
        mfaSecret = extractSecret(uri);
        try {
            mfaQrDataUrl = await QRCode.toDataURL(uri, { width: 200, margin: 2 });
        } catch {
            mfaQrDataUrl = "";
        }
        mfaStep = "scan";
        mfaLoading = false;
    }

    async function verifyMfaCode(e: SubmitEvent) {
        e.preventDefault();
        if (mfaLoading) return;
        if (!/^\d{6}$/.test(mfaCode)) {
            mfaFieldError = "Enter the 6-digit code from your app.";
            return;
        }
        mfaFieldError = null;
        mfaLoading = true;
        mfaError = null;
        const result = await authClient.twoFactor.verifyTotp({ code: mfaCode });
        if (result.error) {
            mfaError = failureMessage(result.error, "Invalid code. Please try again.");
            mfaLoading = false;
            return;
        }
        mfaEnabled = true;
        mfaStep = "idle";
        mfaSuccess = "Two-factor authentication has been enabled.";
        mfaLoading = false;
        mfaCode = "";
        void refocus(() => disableButton);
    }

    function startMfaDisable() {
        mfaStep = "disable-confirm";
        mfaError = null;
        mfaFieldError = null;
        mfaPassword = "";
    }

    async function disableMfa(e: SubmitEvent) {
        e.preventDefault();
        if (mfaLoading) return;
        if (!mfaPassword) {
            mfaFieldError = "Enter your current password.";
            return;
        }
        mfaFieldError = null;
        mfaLoading = true;
        mfaError = null;
        const result = await authClient.twoFactor.disable({ password: mfaPassword });
        if (result.error) {
            mfaError = failureMessage(result.error, "Failed to disable two-factor authentication.");
            mfaLoading = false;
            return;
        }
        mfaEnabled = false;
        mfaStep = "idle";
        mfaSuccess = "Two-factor authentication has been disabled.";
        mfaLoading = false;
        mfaPassword = "";
        void refocus(() => enableButton);
    }

    function cancelMfa() {
        mfaStep = "idle";
        mfaError = null;
        mfaFieldError = null;
        mfaPassword = "";
        mfaCode = "";
        mfaBackupCodes = [];
        void refocus(() => (mfaEnabled ? disableButton : enableButton));
    }

    // ── Passkey state ──────────────────────────────────────────────────────────
    type PasskeyStep = "idle" | "add-name" | "rename";

    // svelte-ignore state_referenced_locally
    let passkeys = $state(data.passkeys ?? []);
    let passkeyStep = $state<PasskeyStep>("idle");
    let passkeySupported = $state(false);
    let passkeyLoading = $state(false);
    let passkeyError = $state<string | null>(null);
    // A missing name, said at its field rather than in the step's banner.
    let passkeyFieldError = $state<string | null>(null);
    let passkeySuccess = $state<string | null>(null);
    let addPasskeyButton = $state<HTMLButtonElement>();
    // Each row's Rename, so focus can go back to the one that opened the rename step.
    const renameButtons: Record<string, HTMLButtonElement | undefined> = {};
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
        passkeyFieldError = null;
    }

    async function addPasskey(e: SubmitEvent) {
        e.preventDefault();
        if (passkeyLoading) return;
        if (!passkeyName.trim()) {
            passkeyFieldError = "Give the passkey a name.";
            return;
        }
        passkeyFieldError = null;
        passkeyLoading = true;
        passkeyError = null;
        passkeySuccess = null;

        const result = await authClient.passkey.addPasskey({ name: passkeyName.trim() });
        if (result?.error) {
            passkeyError = failureMessage(result.error, "Failed to register passkey. Please try again.");
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
        void refocus(() => addPasskeyButton);
    }

    function cancelPasskey() {
        const renamed = passkeyRenameId;
        passkeyStep = "idle";
        passkeyError = null;
        passkeyFieldError = null;
        passkeyName = "";
        passkeyRenameId = null;
        passkeyRenameName = "";
        void refocus(() => (renamed ? renameButtons[renamed] : addPasskeyButton));
    }

    async function deletePasskey(id: string) {
        passkeyDeleteLoading = id;
        passkeyError = null;
        passkeySuccess = null;
        const result = await authClient.passkey.deletePasskey({ id });
        if (result?.error) {
            passkeyError = failureMessage(result.error, "Failed to remove passkey.");
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
        passkeyFieldError = null;
    }

    async function renamePasskey(e: SubmitEvent) {
        e.preventDefault();
        if (passkeyRenameLoading || !passkeyRenameId) return;
        if (!passkeyRenameName.trim()) {
            passkeyFieldError = "Give the passkey a name.";
            return;
        }
        passkeyFieldError = null;
        passkeyRenameLoading = true;
        passkeyError = null;

        // Use the better-auth API directly to update passkey name
        const res = await fetch("/api/auth/passkey/update-passkey", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: passkeyRenameId, name: passkeyRenameName.trim() }),
        });
        if (!res.ok) {
            passkeyError = res.status === 401 ? SESSION_ENDED_MESSAGE : "Failed to rename passkey.";
            passkeyRenameLoading = false;
            return;
        }

        const renamed = passkeyRenameId;
        passkeys = passkeys.map((p) => (p.id === passkeyRenameId ? { ...p, name: passkeyRenameName.trim() } : p));
        passkeySuccess = "Passkey renamed.";
        passkeyStep = "idle";
        passkeyRenameId = null;
        passkeyRenameName = "";
        passkeyRenameLoading = false;
        void refocus(() => renameButtons[renamed]);
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
    // Checked by default: a password is most often changed because someone else may know it.
    let signOutOthers = $state(true);

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
        // A network failure or a body that is not JSON (a proxy's error page) must still end in a
        // message, not leave the form stuck on "Saving".
        const response = await fetch("/api/v1/account/set-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ newPassword: pwNew }),
        }).catch(() => null);
        const result = ((await response?.json().catch(() => null)) ?? {}) as { error?: { message?: string; code?: string } };
        if (result.error?.code === WEAK_PASSWORD_CODE) {
            pwFieldErrors = { new: result.error.message ?? "Choose a password that is harder to guess." };
            void focusFirstInvalid();
        } else if (!response?.ok) {
            pwError = failureMessage(
                { status: response?.status, message: result.error?.message },
                "Failed to set password. Please try again.",
            );
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
        const signingOut = signOutOthers;
        const result = await authClient.changePassword({
            currentPassword: pwCurrent,
            newPassword: pwNew,
            revokeOtherSessions: signingOut,
        });
        if (result.error?.code === WEAK_PASSWORD_CODE) {
            pwFieldErrors = { new: result.error.message ?? "Choose a password that is harder to guess." };
            void focusFirstInvalid();
        } else if (result.error) {
            pwError = failureMessage(result.error, "Failed to change password. Please try again.");
        } else {
            pwSuccess = "Password changed successfully.";
            if (signingOut) {
                sessions = sessions.filter((session) => session.current);
                othersSignedOutIn = "password";
            }
            pwCurrent = "";
            pwNew = "";
            pwConfirm = "";
            pwFieldErrors = {};
        }
        pwLoading = false;
    }

    // ── Sessions ──────────────────────────────────────────────────────────────
    // svelte-ignore state_referenced_locally
    let sessions = $state(data.sessions);
    // The session being signed out, or "others" while signing out every other one.
    let sessionsBusy = $state<string | null>(null);
    let sessionsError = $state<string | null>(null);
    // Where the last "other devices are signed out" happened, so the note shows beside it.
    let othersSignedOutIn = $state<"password" | "sessions" | null>(null);
    const accessTokensUrl = $derived(new URL("/account/tokens", data.syncServerUrl).href);

    /**
     * Signs a session out by id: each app's `/account/sessions/[sessionId]` finds its token on the
     * server. Only a 401 has a message of its own; any other failure gets the retry wording, since
     * the server's text for a 500 says nothing the user can act on.
     */
    async function signOutSession(target: { id: string }) {
        if (sessionsBusy) return;
        sessionsBusy = target.id;
        sessionsError = null;
        const response = await fetch(`/account/sessions/${encodeURIComponent(target.id)}`, {
            method: "DELETE",
            headers: { accept: "application/json" },
        }).catch(() => null);
        if (response?.ok) sessions = sessions.filter((session) => session.id !== target.id);
        else sessionsError = failureMessage(response && { status: response.status }, "Could not sign that session out. Try again.");
        sessionsBusy = null;
    }

    async function signOutOtherSessions() {
        if (sessionsBusy) return;
        sessionsBusy = "others";
        sessionsError = null;
        othersSignedOutIn = null;
        const result = await authClient.revokeOtherSessions().catch(() => null);
        if (!result || result.error) {
            sessionsError = failureMessage(result?.error, "Could not sign the other sessions out. Try again.");
        } else {
            sessions = sessions.filter((session) => session.current);
            othersSignedOutIn = "sessions";
        }
        sessionsBusy = null;
    }

    // ── Email verification state ───────────────────────────────────────────────
    // A verification link sent from this page returns here; Better Auth adds `error` when the
    // link has expired or was already used, and the account is then still unverified.
    const verificationLinkFailed = $derived(["INVALID_TOKEN", "TOKEN_EXPIRED"].includes(page.url.searchParams.get("error") ?? ""));
    let verificationLoading = $state(false);
    let verificationSuccess = $state<string | null>(null);
    let verificationError = $state<string | null>(null);
    // svelte-ignore state_referenced_locally
    let lastSentAt = $state<Date | null>(data.emailVerificationLastSentAt ? new Date(data.emailVerificationLastSentAt) : null);
    let nowMs = $state(Date.now());

    // The server sends at most one resend a minute and quietly skips any other, so the button
    // waits out the same minute rather than offering a click that does nothing. The clock
    // ticks every second only while that wait is running.
    const resendWaitSeconds = $derived(verificationResendWaitSeconds(lastSentAt, nowMs));
    const resendCoolingDown = $derived(resendWaitSeconds > 0);
    const resendHintId = $props.id();

    $effect(() => {
        const id = setInterval(() => (nowMs = Date.now()), resendCoolingDown ? 1_000 : 30_000);
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
        if (verificationLoading || resendCoolingDown) return;
        verificationLoading = true;
        verificationError = null;
        verificationSuccess = null;
        const result = await authClient.sendVerificationEmail({
            email: data.user.email,
            callbackURL: "/account",
        });
        if (result.error) {
            verificationError = failureMessage(result.error, "Failed to send verification email. Please try again.");
        } else {
            verificationSuccess = `Verification email sent to ${data.user.email}. Check your inbox.`;
            lastSentAt = new Date();
            nowMs = Date.now();
        }
        verificationLoading = false;
    }

    // The browser may keep this page in its back-forward cache when it navigates away, sign-out
    // included. Nothing secret may be left in it then: the two-factor secret, its QR code and
    // backup codes, and any password typed here.
    function forgetSecrets() {
        flushSync(() => {
            mfaStep = "idle";
            mfaPassword = "";
            mfaQrDataUrl = "";
            mfaSecret = "";
            mfaCode = "";
            mfaBackupCodes = [];
            backupCodesCopied = false;
            pwCurrent = "";
            pwNew = "";
            pwConfirm = "";
            emailPassword = "";
        });
    }
</script>

<svelte:window onpagehide={forgetSecrets} />

<svelte:head>
    <title>Account - EtherPK</title>
</svelte:head>

<!-- The password field of the two-factor steps: focused when its step opens. -->
{#snippet mfaPasswordField(id: string)}
    <input
        {id}
        type="password"
        bind:value={mfaPassword}
        {@attach focusOnMount}
        oninput={() => {
            if (mfaFieldError && mfaPassword) mfaFieldError = null;
        }}
        placeholder="Current password"
        autocomplete="current-password"
        aria-invalid={mfaFieldError !== null}
        aria-describedby={mfaFieldError ? `${id}-error` : undefined}
        class={textFieldClass(!!mfaFieldError)}
    />
    {#if mfaFieldError}
        <p id="{id}-error" class="text-sm text-red-600">{mfaFieldError}</p>
    {/if}
{/snippet}

<!-- After signing other devices out: what that reached, and what it did not. -->
{#snippet othersSignedOutNote()}
    <AlertBanner variant="success" dismissible ondismiss={() => (othersSignedOutIn = null)}>
        Other devices are signed out{#if data.openAppsKeepAccessMinutes}, and EtherPK apps already open on them lose access within {data.openAppsKeepAccessMinutes} minutes{/if}.
        Access tokens stay active: revoke any you no longer trust on the <a href={accessTokensUrl} class="font-medium underline">Access tokens</a> page.
    </AlertBanner>
{/snippet}

<!-- A failed request's message, with the way on when the failure is a session that has ended. -->
{#snippet errorBanner(message: string)}
    <AlertBanner variant="error">
        {message}
        {#if message === SESSION_ENDED_MESSAGE}
            <a href={signInPath(page.url)} class="font-medium underline">Sign in again</a>
        {/if}
    </AlertBanner>
{/snippet}

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
            {#if mailEnabled}
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
            {/if}
        </div>

        {#if mailEnabled && !data.user.emailVerified}
            <div class="px-6 py-5 space-y-3">
                <div>
                    <p class="text-sm font-medium text-gray-950">Verify your email address</p>
                    <!-- The send time is recorded as an email goes and removed if the send fails, so
                         without one nothing has been sent, and the page must not say otherwise. -->
                    <p class="mt-0.5 text-sm text-gray-500">
                        {lastSentAt ? "We sent you a verification link. Didn't receive it? Resend below." : "No verification email has been sent to this address yet. Send one below."}
                    </p>
                </div>

                {#if verificationSuccess}
                    <AlertBanner variant="success" message={verificationSuccess} dismissible ondismiss={() => (verificationSuccess = null)} />
                {:else if verificationLinkFailed}
                    <AlertBanner variant="warning" message="That verification link has expired or was already used. Send a new one below." />
                {/if}

                {#if verificationError}
                    {@render errorBanner(verificationError)}
                {/if}

                <div class="flex flex-wrap items-center gap-3">
                    <button type="button" onclick={resendVerification} disabled={verificationLoading || resendCoolingDown} aria-describedby={resendCoolingDown || lastSentLabel ? resendHintId : undefined} class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                        {verificationLoading ? "Sending…" : "Resend verification email"}
                    </button>
                    {#if resendCoolingDown}
                        <span id={resendHintId} class="text-sm text-gray-500" data-testid="verification-resend-wait">
                            {lastSentLabel ?? "Sent just now"}. You can send another in {resendWaitSeconds} s.
                        </span>
                    {:else if lastSentLabel}
                        <span id={resendHintId} class="text-sm text-gray-500">{lastSentLabel}</span>
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
                <p class="text-sm text-gray-500 mt-0.5" data-testid="email-change-help">
                    {#if !mailEnabled}
                        This server does not send email, so it cannot confirm a new address. Your address stays {data.user.email}.
                    {:else if data.user.emailVerified}
                        A link to confirm the change goes to your current address first, then a verification link to the new one. Your address changes when you open that.
                    {:else}
                        A verification link goes to the new address. Your address changes when you open it.
                    {/if}
                </p>
            </div>

            {#if emailSuccess}
                <AlertBanner variant="success" message={emailSuccess} dismissible ondismiss={() => (emailSuccess = null)} />
            {/if}

            {#if emailError}
                {@render errorBanner(emailError)}
            {/if}

            {#if mailEnabled}
            <form onsubmit={handleChangeEmail} novalidate class="space-y-3">
                <div>
                    <label for="new-email" class="block text-sm font-medium text-gray-700 mb-1">New email address</label>
                    <input id="new-email" type="email" bind:value={newEmail} autocomplete="email" placeholder="new@example.com" aria-invalid={!!emailFieldError} aria-describedby={emailFieldError ? "new-email-error" : undefined} class={textFieldClass(!!emailFieldError)} />
                    {#if emailFieldError}
                        <p id="new-email-error" class="mt-1 text-sm text-red-600">{emailFieldError}</p>
                    {/if}
                </div>

                {#if hasPassword}
                    <div>
                        <label for="email-password" class="block text-sm font-medium text-gray-700 mb-1">Password</label>
                        <input
                            id="email-password"
                            type="password"
                            bind:value={emailPassword}
                            oninput={() => {
                                if (emailPasswordError && emailPassword) emailPasswordError = null;
                            }}
                            autocomplete="current-password"
                            aria-invalid={!!emailPasswordError}
                            aria-describedby={emailPasswordError ? "email-password-error" : undefined}
                            class={textFieldClass(!!emailPasswordError)}
                        />
                        {#if emailPasswordError}
                            <p id="email-password-error" class="mt-1 text-sm text-red-600">{emailPasswordError}</p>
                        {/if}
                    </div>
                {/if}

                <button type="submit" disabled={emailLoading} class="rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    {emailLoading ? "Sending…" : "Change email"}
                </button>
            </form>
            {/if}
        </div>
    </div>

    <!-- Connected accounts: only when there is a provider to connect or a link to show, or while it
         confirms a disconnect that removed the last one listed. -->
    {#if offeredProviders.length > 0 || accountSuccess}
    <div data-testid="connected-accounts" class="mt-4 rounded-xl border border-gray-950/8 bg-white shadow-sm divide-y divide-gray-950/5">
        <div class="px-6 py-5">
            <h2 class="text-sm font-semibold text-gray-950">Connected accounts</h2>
        </div>

        <div class="px-6 py-5 space-y-4">
            <p class="text-sm text-gray-500">Link your social accounts for faster sign-in.</p>

            {#if verifyBeforeLinking}
                <p class="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-600/20">Verify your email address before linking a social account.</p>
            {/if}

            {#if accountSuccess}
                <AlertBanner variant="success" message={accountSuccess} dismissible ondismiss={() => (accountSuccess = null)} />
            {/if}

            {#if accountError}
                {@render errorBanner(accountError)}
            {/if}

            <div class="space-y-3">
                {#each offeredProviders as provider (provider.id)}
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
                                    <p class="text-sm text-gray-500 dark:text-gray-400">Not connected</p>
                                {/if}
                            </div>
                        </div>
                        <div>
                            {#if isLinked(provider.id) && !canUnlink(provider.id)}
                                <!-- Said in text, not a tooltip on a control that cannot be used. -->
                                <span class="text-sm text-gray-500">Your only sign-in method</span>
                            {:else if isLinked(provider.id)}
                                <button type="button" onclick={() => unlinkProvider(provider.id)} disabled={unlinkLoading === provider.id} aria-label="Disconnect {provider.label}" class="text-sm text-red-600 hover:underline disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline">
                                    {unlinkLoading === provider.id ? "Disconnecting…" : "Disconnect"}
                                </button>
                            {:else}
                                <!-- Unverified, the notice above the list says why this is unavailable. -->
                                <button type="button" onclick={() => linkProvider(provider.id)} disabled={linkLoading === provider.id || verifyBeforeLinking} aria-label="Connect {provider.label}" class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                                    {linkLoading === provider.id ? "Connecting…" : "Connect"}
                                </button>
                            {/if}
                        </div>
                    </div>
                {/each}
            </div>
        </div>
    </div>
    {/if}

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
                        <!-- Hidden while a step is open: starting again would discard what it shows. -->
                        {#if mfaStep === "idle"}
                            <button type="button" bind:this={disableButton} onclick={startMfaDisable} class="text-sm text-red-600 hover:underline">Disable</button>
                        {/if}
                    {:else if mfaStep === "idle"}
                        <button type="button" bind:this={enableButton} onclick={startMfaEnable} class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors">Enable</button>
                    {/if}
                </div>
            </div>

            {#if mfaSuccess}
                <AlertBanner variant="success" message={mfaSuccess} dismissible ondismiss={() => (mfaSuccess = null)} />
            {/if}

            {#if mfaError && mfaStep === "idle"}
                {@render errorBanner(mfaError)}
            {/if}

            <!-- Confirm password to start enable flow -->
            {#if mfaStep === "confirm-password"}
                <form onsubmit={getMfaUri} novalidate class="rounded-lg border border-gray-950/8 bg-gray-50 p-4 space-y-3">
                    <label for="account-mfa-enable-password" class="block text-sm font-medium text-gray-700">Enter your current password to continue</label>
                    {#if mfaError}
                        {@render errorBanner(mfaError)}
                    {/if}
                    {@render mfaPasswordField("account-mfa-enable-password")}
                    <div class="flex gap-2">
                        <button type="submit" disabled={mfaLoading} class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                            {mfaLoading ? "Loading…" : "Continue"}
                        </button>
                        <button type="button" onclick={cancelMfa} class="rounded-lg border border-gray-950/15 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors">Cancel</button>
                    </div>
                </form>
            {/if}

            <!-- Scan QR code -->
            {#if mfaStep === "scan"}
                <form onsubmit={verifyMfaCode} novalidate class="rounded-lg border border-gray-950/8 bg-gray-50 p-4 space-y-4">
                    <div>
                        <!-- Focus starts on the instructions, so a screen reader reads the secret and
                             the backup codes before it reaches the code field. -->
                        <p tabindex="-1" {@attach focusOnMount} class="text-sm font-medium text-gray-950 outline-none">1. Scan this QR code with your authenticator app</p>
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
                            <p class="text-sm text-amber-700">Store these somewhere safe. If you lose your authenticator app, choose Use a backup code when you sign in and enter one of these. Each code works once.</p>
                            <div class="grid grid-cols-2 gap-1 mt-2" data-testid="mfa-backup-codes">
                                {#each mfaBackupCodes as code (code)}
                                    <code class="rounded bg-white border border-amber-200 px-2 py-1 text-sm font-mono text-gray-950 select-all">{code}</code>
                                {/each}
                            </div>
                        </div>
                    {/if}
                    <div>
                        <label for="account-mfa-code" class="block text-sm font-medium text-gray-700 mb-1.5">2. Enter the 6-digit code from your app</label>
                        {#if mfaError}
                            <div class="mb-2">
                                {@render errorBanner(mfaError)}
                            </div>
                        {/if}
                        <input
                            id="account-mfa-code"
                            type="text"
                            inputmode="numeric"
                            pattern="[0-9]*"
                            maxlength="6"
                            bind:value={mfaCode}
                            oninput={() => {
                                if (mfaFieldError && /^\d{6}$/.test(mfaCode)) mfaFieldError = null;
                            }}
                            placeholder="000000"
                            autocomplete="one-time-code"
                            aria-invalid={mfaFieldError !== null}
                            aria-describedby={mfaFieldError ? "account-mfa-code-error" : undefined}
                            class="{textFieldClass(!!mfaFieldError)} font-mono tracking-widest"
                        />
                        {#if mfaFieldError}
                            <p id="account-mfa-code-error" class="mt-1 text-sm text-red-600">{mfaFieldError}</p>
                        {/if}
                    </div>
                    <div class="flex gap-2">
                        <button type="submit" disabled={mfaLoading} class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                            {mfaLoading ? "Verifying…" : "Verify & Enable"}
                        </button>
                        <button type="button" onclick={cancelMfa} class="rounded-lg border border-gray-950/15 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors">Cancel</button>
                    </div>
                </form>
            {/if}

            <!-- Disable confirmation -->
            {#if mfaStep === "disable-confirm"}
                <form onsubmit={disableMfa} novalidate class="rounded-lg border border-red-200 bg-red-50 p-4 space-y-3">
                    <label for="account-mfa-disable-password" class="block text-sm font-medium text-red-700">Enter your current password to disable two-factor authentication</label>
                    {#if mfaError}
                        {@render errorBanner(mfaError)}
                    {/if}
                    {@render mfaPasswordField("account-mfa-disable-password")}
                    <div class="flex gap-2">
                        <button type="submit" disabled={mfaLoading} class="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                            {mfaLoading ? "Disabling…" : "Disable 2FA"}
                        </button>
                        <button type="button" onclick={cancelMfa} class="rounded-lg border border-gray-950/15 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors">Cancel</button>
                    </div>
                </form>
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
                    <button type="button" bind:this={addPasskeyButton} onclick={startAddPasskey} class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors shrink-0">Add a passkey</button>
                {/if}
            </div>

            {#if passkeySuccess}
                <AlertBanner variant="success" message={passkeySuccess} dismissible ondismiss={() => (passkeySuccess = null)} />
            {/if}

            {#if passkeyError && passkeyStep === "idle"}
                {@render errorBanner(passkeyError)}
            {/if}

            {#if !passkeySupported}
                <p class="text-sm text-gray-500 dark:text-gray-400">Your browser doesn't support passkeys (WebAuthn).</p>
            {/if}

            <!-- Add passkey: name prompt -->
            {#if passkeyStep === "add-name"}
                <form onsubmit={addPasskey} novalidate class="rounded-lg border border-gray-950/8 bg-gray-50 p-4 space-y-3">
                    <label for="account-passkey-name" class="block text-sm font-medium text-gray-700">Name your passkey</label>
                    <p id="account-passkey-name-hint" class="text-sm text-gray-500">Give it a recognisable name so you can identify it later.</p>
                    {#if passkeyError}
                        {@render errorBanner(passkeyError)}
                    {/if}
                    <input
                        id="account-passkey-name"
                        type="text"
                        bind:value={passkeyName}
                        {@attach focusOnMount}
                        oninput={() => {
                            if (passkeyFieldError && passkeyName.trim()) passkeyFieldError = null;
                        }}
                        placeholder="e.g. MacBook Pro Touch ID"
                        maxlength="100"
                        aria-invalid={passkeyFieldError !== null}
                        aria-describedby={passkeyFieldError ? "account-passkey-name-error" : "account-passkey-name-hint"}
                        class={textFieldClass(!!passkeyFieldError)}
                    />
                    {#if passkeyFieldError}
                        <p id="account-passkey-name-error" class="text-sm text-red-600">{passkeyFieldError}</p>
                    {/if}
                    <div class="flex gap-2">
                        <button type="submit" disabled={passkeyLoading} class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                            {passkeyLoading ? "Waiting for browser…" : "Continue"}
                        </button>
                        <button type="button" onclick={cancelPasskey} class="rounded-lg border border-gray-950/15 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors">Cancel</button>
                    </div>
                </form>
            {/if}

            <!-- Rename passkey -->
            {#if passkeyStep === "rename"}
                <form onsubmit={renamePasskey} novalidate class="rounded-lg border border-gray-950/8 bg-gray-50 p-4 space-y-3">
                    <label for="account-passkey-rename" class="block text-sm font-medium text-gray-700">Rename passkey</label>
                    {#if passkeyError}
                        {@render errorBanner(passkeyError)}
                    {/if}
                    <input
                        id="account-passkey-rename"
                        type="text"
                        bind:value={passkeyRenameName}
                        {@attach focusOnMount}
                        oninput={() => {
                            if (passkeyFieldError && passkeyRenameName.trim()) passkeyFieldError = null;
                        }}
                        placeholder="New name"
                        maxlength="100"
                        aria-invalid={passkeyFieldError !== null}
                        aria-describedby={passkeyFieldError ? "account-passkey-rename-error" : undefined}
                        class={textFieldClass(!!passkeyFieldError)}
                    />
                    {#if passkeyFieldError}
                        <p id="account-passkey-rename-error" class="text-sm text-red-600">{passkeyFieldError}</p>
                    {/if}
                    <div class="flex gap-2">
                        <button type="submit" disabled={passkeyRenameLoading} class="rounded-lg bg-gray-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                            {passkeyRenameLoading ? "Saving…" : "Save"}
                        </button>
                        <button type="button" onclick={cancelPasskey} class="rounded-lg border border-gray-950/15 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors">Cancel</button>
                    </div>
                </form>
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
                                <button type="button" bind:this={renameButtons[pk.id]} onclick={() => startRenamePasskey(pk.id, pk.name ?? "")} class="text-sm text-gray-500 hover:text-gray-950 hover:underline">Rename</button>
                                {#if canDeletePasskey()}
                                    <button type="button" onclick={() => deletePasskey(pk.id)} disabled={passkeyDeleteLoading === pk.id} class="text-sm text-red-600 hover:underline disabled:opacity-50 disabled:cursor-not-allowed">
                                        {passkeyDeleteLoading === pk.id ? "Removing…" : "Remove"}
                                    </button>
                                {:else}
                                    <!-- Said in text, not a tooltip on a control that cannot be used. -->
                                    <span class="text-sm text-gray-500">Your only sign-in method</span>
                                {/if}
                            </div>
                        </div>
                    {/each}
                </div>
            {:else if passkeySupported && passkeyStep === "idle"}
                <p class="text-sm text-gray-500 dark:text-gray-400">No passkeys registered. Add one to sign in without a password.</p>
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
            {#if othersSignedOutIn === "password"}
                {@render othersSignedOutNote()}
            {/if}

            {#if pwError}
                {@render errorBanner(pwError)}
            {/if}

            {#if hasPassword}
                <form onsubmit={handleChangePassword} novalidate class="space-y-3">
                    <div>
                        <label for="pw-current" class="block text-sm font-medium text-gray-700 mb-1">Current password</label>
                        <input id="pw-current" type="password" bind:value={pwCurrent} autocomplete="current-password" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;" aria-invalid={!!pwFieldErrors.current} aria-describedby={pwFieldErrors.current ? "pw-current-error" : undefined} class={textFieldClass(!!pwFieldErrors.current)} />
                        {#if pwFieldErrors.current}
                            <p id="pw-current-error" class="mt-1 text-sm text-red-600">{pwFieldErrors.current}</p>
                        {/if}
                    </div>

                    <div>
                        <label for="pw-new" class="block text-sm font-medium text-gray-700 mb-1">New password</label>
                        <input id="pw-new" type="password" bind:value={pwNew} autocomplete="new-password" aria-invalid={!!pwFieldErrors.new} aria-describedby={pwFieldErrors.new ? "pw-new-error pw-new-help" : "pw-new-help"} class={textFieldClass(!!pwFieldErrors.new)} />
                        {#if pwFieldErrors.new}
                            <p id="pw-new-error" class="mt-1 text-sm text-red-600">{pwFieldErrors.new}</p>
                        {/if}
                        <p id="pw-new-help" class="mt-1 text-sm text-gray-500">{PASSWORD_HELP}</p>
                    </div>

                    <div>
                        <label for="pw-confirm" class="block text-sm font-medium text-gray-700 mb-1">Confirm new password</label>
                        <input id="pw-confirm" type="password" bind:value={pwConfirm} autocomplete="new-password" placeholder="Repeat new password" aria-invalid={!!pwFieldErrors.confirm} aria-describedby={pwFieldErrors.confirm ? "pw-confirm-error" : undefined} class={textFieldClass(!!pwFieldErrors.confirm)} />
                        {#if pwFieldErrors.confirm}
                            <p id="pw-confirm-error" class="mt-1 text-sm text-red-600">{pwFieldErrors.confirm}</p>
                        {/if}
                    </div>

                    <label class="flex items-center gap-2 text-sm text-gray-700">
                        <input type="checkbox" bind:checked={signOutOthers} class="h-4 w-4 rounded border-gray-300" />
                        Sign out of other devices
                    </label>

                    <button type="submit" disabled={pwLoading} class="rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                        {pwLoading ? "Saving…" : "Update password"}
                    </button>
                </form>
            {:else}
                <form onsubmit={handleSetPassword} novalidate class="space-y-3">
                    <div>
                        <label for="pw-new" class="block text-sm font-medium text-gray-700 mb-1">New password</label>
                        <input id="pw-new" type="password" bind:value={pwNew} autocomplete="new-password" aria-invalid={!!pwFieldErrors.new} aria-describedby={pwFieldErrors.new ? "pw-new-error pw-new-help" : "pw-new-help"} class={textFieldClass(!!pwFieldErrors.new)} />
                        {#if pwFieldErrors.new}
                            <p id="pw-new-error" class="mt-1 text-sm text-red-600">{pwFieldErrors.new}</p>
                        {/if}
                        <p id="pw-new-help" class="mt-1 text-sm text-gray-500">{PASSWORD_HELP}</p>
                    </div>

                    <div>
                        <label for="pw-confirm" class="block text-sm font-medium text-gray-700 mb-1">Confirm password</label>
                        <input id="pw-confirm" type="password" bind:value={pwConfirm} autocomplete="new-password" placeholder="Repeat password" aria-invalid={!!pwFieldErrors.confirm} aria-describedby={pwFieldErrors.confirm ? "pw-confirm-error" : undefined} class={textFieldClass(!!pwFieldErrors.confirm)} />
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

        <!-- Sessions -->
        <div class="px-6 py-5 space-y-4" data-testid="account-sessions">
            <div class="flex items-start justify-between gap-4">
                <div>
                    <p class="text-sm font-medium text-gray-950">Sessions</p>
                    <p class="text-sm text-gray-500 mt-0.5">Where your account is signed in. Signing a session out ends it at once.</p>
                </div>
                {#if sessions.length > 1}
                    <button type="button" onclick={signOutOtherSessions} disabled={sessionsBusy !== null} class="shrink-0 rounded-lg border border-gray-950/15 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                        {sessionsBusy === "others" ? "Signing out…" : "Sign out of other sessions"}
                    </button>
                {/if}
            </div>

            {#if othersSignedOutIn === "sessions"}
                {@render othersSignedOutNote()}
            {/if}
            {#if sessionsError}
                {@render errorBanner(sessionsError)}
            {/if}

            <ul class="space-y-2">
                {#each sessions as session (session.id)}
                    <li class="flex items-center justify-between gap-3 rounded-lg border border-gray-950/8 px-4 py-3">
                        <div class="min-w-0">
                            <p class="flex items-center gap-2 text-sm font-medium text-gray-950">
                                {describeDevice(session.userAgent)}
                                {#if session.current}
                                    <span class="rounded-full bg-gray-100 px-2 py-0.5 text-sm font-medium text-gray-700">This device</span>
                                {/if}
                            </p>
                            <p class="text-sm text-gray-500">
                                Signed in {formatDate(session.createdAt)}{session.ipAddress ? ` from ${session.ipAddress}` : ""}
                            </p>
                        </div>
                        {#if !session.current}
                            <button
                                type="button"
                                onclick={() => signOutSession(session)}
                                disabled={sessionsBusy !== null}
                                aria-label="Sign out {describeDevice(session.userAgent)}, signed in {formatDate(session.createdAt)}"
                                class="shrink-0 text-sm text-red-600 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {sessionsBusy === session.id ? "Signing out…" : "Sign out"}
                            </button>
                        {/if}
                    </li>
                {/each}
            </ul>
        </div>
    </div>
</div>
