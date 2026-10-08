<script lang="ts" module>
    /** What one server's sub-tab asks the Graphs page to do; the page owns every action. */
    export interface SyncServerSettingsActions {
        signIn(): void;
        /** A custom server refused its token: open the form to give it a new one. */
        reconnect(): void;
        beginForget(): void;
        cancelForget(): void;
        forget(): void;
        checkPlan(): void;
        createKeys(): void;
        regenerate(): void;
        /** Key Replacement (ADR 0128), once the user has confirmed it here. */
        replaceKeys(): void;
        unlock(): void;
        showFingerprint(): void;
        reset(): void;
        /** Ask for this device's passcode, which protects the server's access token (ADR 0129). */
        enterPasscode(): void;
    }
</script>

<script lang="ts">
    /**
     * One Sync Server's sub-tab on the Sync tab (ADR 0111): its account and plan, and its
     * Encryption Keys. Each server keeps its own account, Encryption Keys and Recovery Code, so
     * everything here, resetting the keys included, acts on this server only. The copies of its
     * graphs this browser holds are listed on the This Device tab, with every other server's.
     *
     * Headings follow the page's: the Sync tab's sections are h2, this server's name h3, its cards
     * h4 and the parts of a card h5, each a size or weight apart from the text beneath it.
     */
    import {
        PLAN_NOTICE_TEXT,
        UNLIMITED_ALLOWANCE,
        formatUsage,
        isServerAllowance,
        planLabel,
        planStatusLine,
        type SyncAccountSummary,
    } from "@appsoftwareltd/etherpk-shared";
    import SyncPlusOffer from "@appsoftwareltd/etherpk-shared/sync-plus-offer";
    import { tick } from "svelte";
    import {
        CUSTOM_SERVER_ICON,
        MANAGED_SERVER_ICON,
    } from "./graphs-page-icons";
    import type { SyncServerView } from "./sync-server-view.svelte";

    let {
        server,
        corporateBillingUrl,
        corporatePricingUrl,
        corporateAccountUrl,
        showPending,
        confirmingForget,
        forgetting,
        actions,
    }: {
        server: SyncServerView;
        corporateBillingUrl: string | null;
        /** Corporate's pricing page, where a Free account's offer leads. */
        corporatePricingUrl: string | null;
        corporateAccountUrl: string | null;
        /** A plan being confirmed has taken long enough to say so (delayed, so a fast answer never flashes it). */
        showPending: boolean;
        confirmingForget: boolean;
        forgetting: boolean;
        actions: SyncServerSettingsActions;
    } = $props();

    const managed = $derived(server.connection.kind === "managed");
    const account = $derived(
        server.authState === "authenticated" ? server.account : null,
    );
    const notice = $derived(server.shownPlanNotice);

    /**
     * Where this account's address is verified: Corporate's Account page on Managed Sync, the
     * server's own otherwise.
     */
    const verifyEmailUrl = $derived(
        account
            ? account.authentication.mode === "managed"
                ? corporateAccountUrl
                : `${server.origin}/account`
            : null,
    );

    /** How the server reads in the header: who is signed in there, or why nobody is. */
    const statusText = $derived.by(() => {
        switch (server.authState) {
            case "authenticated":
                return `Signed in as ${server.accountLabel}`;
            case "signed-out":
                return managed
                    ? "Signed out"
                    : "The server did not accept this device's access token";
            case "unavailable":
                return "Could not reach the server";
            case "locked":
                return "Waiting for this device's passcode";
            default:
                return "Checking…";
        }
    });

    const dayFormat = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
    });
    const formatDay = (iso: string) => dayFormat.format(new Date(iso));

    /**
     * What the account owns, against its allowance where it has one: a self-hosted server with no
     * limits shows the usage alone rather than "of Unlimited".
     */
    function ownedUsageLine(
        entitlement: SyncAccountSummary["entitlement"],
    ): string {
        const { usage, limits } = entitlement;
        const oneGraphUnlimited =
            usage.ownedGraphs === 1 &&
            limits.ownedGraphs >= UNLIMITED_ALLOWANCE;
        const graphs = `${formatUsage(usage.ownedGraphs, limits.ownedGraphs, "count")} ${oneGraphUnlimited ? "owned graph" : "owned graphs"}`;
        const storage = `${formatUsage(usage.ownedStorageBytes, limits.ownedStorageBytes, "bytes")} owned storage`;
        return `${graphs} · ${storage}`;
    }

    // Replacing the keys asks first, in place: it signs out every other device, so the sentence
    // says so before the new Recovery Code is shown.
    let confirmingReplace = $state(false);
    let replaceTrigger: HTMLElement | undefined;

    /** The trigger, kept so stepping back returns the focus to it. */
    function rememberTrigger(element: HTMLElement) {
        replaceTrigger = element;
        return () => {
            if (replaceTrigger === element) replaceTrigger = undefined;
        };
    }

    /** The confirmation's first control takes the focus, so a keyboard user lands on the choice. */
    function focusOnMount(element: HTMLElement) {
        element.focus();
    }

    async function cancelReplace() {
        confirmingReplace = false;
        // The trigger is drawn again once the confirmation goes, so wait for it.
        await tick();
        replaceTrigger?.focus();
    }

    function continueReplace() {
        confirmingReplace = false;
        actions.replaceKeys();
    }

    function escapeCancels(event: KeyboardEvent) {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        void cancelReplace();
    }

    const SECONDARY_BUTTON =
        "inline-flex items-center justify-center rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 pointer-coarse:min-h-11 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-white/5";
    const CARD =
        "rounded-xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-white/5";
    const PRIMARY_BUTTON =
        "inline-flex rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200";
    /**
     * A part of a card, such as the Recovery Code in the Encryption Keys card, in a tinted panel of
     * its own. The heading is only a little larger than the help text, so the panel's edge is what
     * shows where each part starts.
     */
    const SUBSECTION = "rounded-lg bg-gray-50 p-4 dark:bg-white/5";
    /** A part's heading: smaller than the card's own (16px), larger and heavier than its text (14px). */
    const SUBHEADING =
        "text-[0.9375rem] font-semibold text-gray-950 dark:text-white";
</script>

<div data-testid="sync-server" data-origin={server.origin} class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
            <h3
                class="flex items-center gap-2 text-base font-semibold text-gray-950 dark:text-white"
            >
                <span class="min-w-0 truncate">{server.host}</span>
                <svg
                    class="h-5 w-5 shrink-0 text-gray-500 dark:text-gray-400"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    aria-hidden="true"
                >
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d={managed ? MANAGED_SERVER_ICON : CUSTOM_SERVER_ICON}
                    />
                </svg>
            </h3>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {managed ? "Managed Sync" : "Custom server"} ·
                <span
                    data-testid="sync-server-status"
                    data-state={server.authState}>{statusText}</span
                >
            </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
            {#if confirmingForget}
                <span class="text-sm text-gray-700 dark:text-gray-300"
                    >Forget {server.host} on this device?</span
                >
                <button
                    type="button"
                    data-testid="sync-server-forget-confirm"
                    disabled={forgetting}
                    onclick={actions.forget}
                    class="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-progress pointer-coarse:min-h-11 dark:border-red-500/40 dark:hover:bg-red-950/30"
                    >{forgetting ? "Forgetting…" : "Forget"}</button
                >
                <button
                    type="button"
                    onclick={actions.cancelForget}
                    class={SECONDARY_BUTTON}>Cancel</button
                >
            {:else}
                <button
                    type="button"
                    data-testid="sync-server-forget"
                    onclick={actions.beginForget}
                    class={SECONDARY_BUTTON}>Forget this server</button
                >
            {/if}
        </div>
        {#if confirmingForget}
            <p
                class="w-full text-sm text-gray-500 dark:text-gray-400"
                data-testid="sync-server-forget-consequence"
            >
                {managed
                    ? "This app signs out on this device and locks your Encryption Keys for it. Your EtherPK account stays signed in elsewhere and its graphs stay as they are. The copies this browser holds stay hidden until you sign in again."
                    : "This device forgets its address and access token, and locks your Encryption Keys for it. The token stays active until you revoke it on the server, and the copies this browser holds stay hidden until you add it again."}
            </p>
        {/if}
    </div>

    <section
        data-testid="sync-auth-status"
        aria-labelledby="sync-account-heading"
        class={CARD}
    >
        <h4
            id="sync-account-heading"
            class="mb-3 text-base font-semibold text-gray-950 dark:text-white"
        >
            Account on {server.host}
        </h4>
        {#if account}
            <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <p
                        class="text-sm font-semibold text-gray-950 dark:text-white"
                    >
                        {account.authentication.mode === "managed"
                            ? "Signed in"
                            : "Authenticated"} as {account.principal.name ??
                            account.principal.email ??
                            "Sync account"}
                    </p>
                    {#if account.principal.name && account.principal.email}
                        <p class="text-sm text-gray-500 dark:text-gray-400">
                            {account.principal.email}
                        </p>
                    {/if}
                </div>
            </div>
            {#if notice === "upsell"}
                <!-- Free: the plan's name, then the offer every origin makes to a Free account, as
                     the Sync Server's dashboard shows them. -->
                <p
                    data-testid="sync-plan-line"
                    class="mt-3 text-sm font-medium text-gray-700 dark:text-gray-200"
                >
                    {planLabel(account.entitlement.plan)} Plan
                </p>
                <div class="mt-2">
                    <SyncPlusOffer pricingUrl={corporatePricingUrl} />
                </div>
            {:else}
                <!-- A server's own allowance is not a plan anyone holds, so it has no plan line: only
                     what the account owns against it. While the plan is being confirmed the notice
                     below says so, once. -->
                {#if !isServerAllowance(account.entitlement.plan) && notice !== "pending"}
                    <p
                        data-testid="sync-plan-line"
                        class="mt-3 text-sm font-medium text-gray-700 dark:text-gray-200"
                    >
                        {planStatusLine(account.entitlement, formatDay)}
                    </p>
                {/if}
                <p
                    data-testid="sync-usage-line"
                    class="{isServerAllowance(account.entitlement.plan)
                        ? 'mt-3'
                        : 'mt-1'} text-sm text-gray-500 dark:text-gray-400"
                >
                    {ownedUsageLine(account.entitlement)}
                </p>
                {#if notice === "payment_failed" || notice === "payment_overdue"}
                    <div
                        role="status"
                        data-testid="sync-payment-notice"
                        data-kind={notice}
                        class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-5 text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100"
                    >
                        <p>{PLAN_NOTICE_TEXT[notice]}</p>
                        {#if corporateBillingUrl}
                            <a
                                href={corporateBillingUrl}
                                data-sveltekit-reload
                                class="mt-2 {PRIMARY_BUTTON}">Fix payment</a
                            >
                        {/if}
                    </div>
                {:else if notice === "ended"}
                    <div
                        role="status"
                        data-testid="sync-read-only-notice"
                        class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-5 text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100"
                    >
                        <p>{PLAN_NOTICE_TEXT.ended}</p>
                        {#if corporateBillingUrl}
                            <a
                                href={corporateBillingUrl}
                                data-sveltekit-reload
                                class="mt-2 {PRIMARY_BUTTON}">Restart Sync+</a
                            >
                        {/if}
                    </div>
                {:else if notice === "pending"}
                    <!-- Held open from the first paint; the words arrive only if confirming takes long
                         enough to notice, so a fast answer never flashes them. -->
                    <div
                        data-testid="sync-plan-pending"
                        class="mt-2 min-h-5 text-sm leading-5 text-gray-600 dark:text-gray-300"
                    >
                        {#if showPending}
                            <p role="status" class="flex items-center gap-2">
                                <svg
                                    class="h-4 w-4 text-gray-500 motion-safe:animate-spin dark:text-gray-400"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    aria-hidden="true"
                                >
                                    <circle
                                        cx="12"
                                        cy="12"
                                        r="10"
                                        stroke="currentColor"
                                        stroke-width="3"
                                        stroke-opacity="0.25"
                                    />
                                    <path
                                        fill="currentColor"
                                        d="M4 12a8 8 0 0 1 8-8v3a5 5 0 0 0-5 5H4z"
                                    />
                                </svg>
                                {PLAN_NOTICE_TEXT.pending}
                            </p>
                        {/if}
                    </div>
                {:else if notice === "unconfirmed"}
                    <div
                        data-testid="sync-plan-unconfirmed"
                        class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-5 text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100"
                    >
                        <p role="status">{PLAN_NOTICE_TEXT.unconfirmed}</p>
                        <button
                            type="button"
                            data-testid="sync-plan-check-again"
                            aria-busy={server.planChecking}
                            onclick={actions.checkPlan}
                            class="mt-2 rounded-lg border border-amber-300 px-3 py-1.5 text-sm font-medium hover:bg-amber-100 aria-busy:cursor-progress dark:border-amber-400/30 dark:hover:bg-amber-400/10"
                            >{server.planChecking
                                ? "Checking…"
                                : "Check again"}</button
                        >
                    </div>
                {/if}
            {/if}
            <!-- What others need of this account before they can share a graph with it: the server
                 says nobody is found until both are done, whatever the reason. -->
            {#if account.invitesNeedVerifiedEmail && account.principal.emailVerified === false}
                <div
                    role="status"
                    data-testid="sharing-needs-verified-email"
                    class="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm leading-5 text-gray-700 dark:border-white/10 dark:bg-white/5 dark:text-gray-300"
                >
                    <p>
                        Verify your email address so people can share graphs
                        with you. Until then, an invite to
                        {account.principal.email ?? "your address"} does not find
                        you.
                    </p>
                    {#if verifyEmailUrl}
                        <a
                            href={verifyEmailUrl}
                            data-sveltekit-reload
                            class="mt-2 {SECONDARY_BUTTON}"
                            >Verify it on your Account page</a
                        >
                    {/if}
                </div>
            {/if}
            <!-- Managed Sync is signed out of, or disconnected, from the account menu in the top bar,
                 so the card does not repeat those. A custom server is left with Forget. -->
            {#if !managed}
                <p
                    class="mt-4 border-t border-gray-200 pt-3 text-sm leading-5 text-gray-500 dark:border-white/10 dark:text-gray-400"
                >
                    To disconnect this device, use <span class="font-medium"
                        >Forget this server</span
                    >
                    above. The access token keeps working until you revoke it on
                    {server.host}.
                </p>
            {/if}
        {:else if server.authState === "checking"}
            <p
                class="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400"
            >
                <svg
                    class="h-4 w-4 text-gray-500 motion-safe:animate-spin dark:text-gray-400"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                >
                    <circle
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        stroke-width="3"
                        stroke-opacity="0.25"
                    />
                    <path
                        fill="currentColor"
                        d="M4 12a8 8 0 0 1 8-8v3a5 5 0 0 0-5 5H4z"
                    />
                </svg>
                Checking your account on {server.host}…
            </p>
        {:else if server.authState === "signed-out"}
            <p class="text-sm font-medium text-gray-900 dark:text-gray-100">
                {managed
                    ? "You are signed out of EtherPK on this device."
                    : `${server.host} did not accept this device's access token.`}
            </p>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                {managed
                    ? "Your synced graphs there are hidden until you sign in. Local folder graphs are not affected."
                    : "The token may have been revoked, or it expired. Synced graphs from this server stay hidden until you add a new token."}
            </p>
            {#if managed}
                <button
                    type="button"
                    data-testid="managed-sync-connect"
                    onclick={actions.signIn}
                    class="mt-3 {PRIMARY_BUTTON}">Sign in</button
                >
            {:else}
                <button
                    type="button"
                    data-testid="sync-reconnect"
                    onclick={actions.reconnect}
                    class="mt-3 {SECONDARY_BUTTON}"
                    >Add a new access token</button
                >
            {/if}
        {:else if server.authState === "locked"}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                This device's access token for {server.host} is protected by the
                device's passcode, so your account there is checked once the passcode
                is entered.
            </p>
            <button
                type="button"
                data-testid="sync-server-enter-passcode"
                onclick={actions.enterPasscode}
                class="mt-3 {SECONDARY_BUTTON}">Enter passcode</button
            >
        {:else}
            <p class="text-sm font-medium text-amber-800 dark:text-amber-200">
                Could not confirm your account on {server.host}.
            </p>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Synced graphs already open in a tab keep working, and your edits
                there wait on this device until the server responds. Opening a
                graph needs the server.
            </p>
        {/if}
    </section>

    <section aria-labelledby="sync-keys-heading" class="space-y-4 {CARD}">
        <h4
            id="sync-keys-heading"
            class="text-base font-semibold text-gray-950 dark:text-white"
        >
            Encryption Keys for {server.host}
        </h4>
        {#if !account}
            <!-- Every key action needs the account, so none is offered before it answers. -->
            <p
                data-testid="keys-after-connecting"
                class="text-sm text-gray-500 dark:text-gray-400"
            >
                Your Encryption Keys and Recovery Code for {server.host} show here
                once {managed
                    ? "you sign in"
                    : "the server accepts this device"}.
            </p>
        {:else if server.vaultExists === false}
            <!-- Fresh or just-reset account: there is no vault, so an unlock prompt would ask for a
                 Recovery Code that does not exist. -->
            <div>
                <p
                    data-testid="regenerate-code-none"
                    class="text-sm text-gray-500 dark:text-gray-400"
                >
                    No Encryption Keys yet. Your first synced graph on {server.host}
                    creates them, or you can create them now. Nobody can share a
                    graph with you until you have Encryption Keys, and creating them
                    gives you your Recovery Code.
                </p>
                <button
                    type="button"
                    data-testid="create-keys"
                    onclick={actions.createKeys}
                    class="mt-2 {SECONDARY_BUTTON}"
                    >Create Encryption Keys</button
                >
            </div>
        {:else}
            <!-- Where the keys are: sealed in a vault the server stores and cannot open, and unlocked
                 on each device for itself. The heading alone read as if they were on the server. -->
            <p
                data-testid="keys-where"
                class="text-sm text-gray-500 dark:text-gray-400"
            >
                Your account on {server.host} has its own Encryption Keys. The server
                stores them sealed and cannot read them. They can be unlocked by
                approval on another unlocked device, or with a Recovery Code.
            </p>
            <div class={SUBSECTION}>
                <h5 class={SUBHEADING}>Recovery Code</h5>
                <p class="text-sm mt-1 text-gray-500 dark:text-gray-400">
                    Your Recovery Code unlocks your Encryption Keys on a device
                    when no other device of yours is unlocked to approve it. One
                    code covers every synced graph on {server.host}, including
                    graphs you join later.
                </p>
                <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    The server never sees the Recovery Code. <strong
                        class="font-semibold text-gray-700 dark:text-gray-200"
                        >If you lose it and every unlocked device, nobody can
                        recover your notes. You must keep the Recovery Code safe</strong
                    >. Other Sync Servers have Recovery Codes of their own, and
                    a code saved for one of them does not unlock Encryption Keys
                    for another.
                </p>
                <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Regenerate the Recovery Code if you did not save it or have
                    lost it. If someone else may have seen it, replace your
                    Encryption Keys below instead. The current code keeps
                    working until you confirm you have saved the new one, and
                    then stops working. Unlocked devices stay unlocked.
                </p>
                <button
                    type="button"
                    data-testid="regenerate-code"
                    onclick={actions.regenerate}
                    class="mt-2 {SECONDARY_BUTTON}"
                    >Regenerate Recovery Code</button
                >
            </div>
            <div class={SUBSECTION}>
                <h5 class={SUBHEADING}>Replace Encryption Keys</h5>
                <p class="text-sm mt-1 text-gray-500 dark:text-gray-400">
                    Replace your Encryption Keys if someone may have copied them
                    or your Recovery Code, or if a device that is still unlocked
                    is lost or no longer yours. You get a new Recovery Code and
                    a new security fingerprint, and every other device has to be
                    unlocked again.
                </p>
                {#if confirmingReplace}
                    <div
                        data-testid="replace-keys-confirm"
                        role="group"
                        aria-label="Replace Encryption Keys"
                        class="mt-2 space-y-2 rounded-lg bg-amber-50 px-3 py-2 dark:bg-amber-400/10"
                    >
                        <p class="text-sm text-amber-900 dark:text-amber-100">
                            Replace your Encryption Keys on {server.host}? Your
                            other devices must be unlocked again, with the new
                            Recovery Code or by approval, and anyone who copied
                            your old code or Encryption Keys is cut off. Invites
                            to you and from you are cancelled, and each graph
                            you own gets a new Graph Key. The new Recovery Code
                            is shown next, and nothing changes until you confirm
                            you have saved it.
                        </p>
                        <div class="flex flex-wrap gap-2">
                            <button
                                {@attach focusOnMount}
                                type="button"
                                data-testid="replace-keys-continue"
                                onkeydown={escapeCancels}
                                onclick={continueReplace}
                                class="{SECONDARY_BUTTON} bg-white dark:bg-transparent"
                                >Continue</button
                            >
                            <button
                                type="button"
                                data-testid="replace-keys-cancel"
                                onkeydown={escapeCancels}
                                onclick={cancelReplace}
                                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-700 hover:text-gray-950 pointer-coarse:min-h-11 dark:text-gray-200 dark:hover:text-white"
                                >Cancel</button
                            >
                        </div>
                    </div>
                {:else}
                    <button
                        {@attach rememberTrigger}
                        type="button"
                        data-testid="replace-keys"
                        onclick={() => (confirmingReplace = true)}
                        class="mt-2 {SECONDARY_BUTTON}"
                        >Replace Encryption Keys and lock out other devices</button
                    >
                {/if}
            </div>
            <!-- One unlock, always offered. Unlocking checks the code against the server's current
                 keys and replaces whatever key this device holds, so keys that a reset on another
                 device left out of date are replaced the same way; nothing needs locking first. -->
            <div class={SUBSECTION}>
                <h5 class={SUBHEADING}>Encryption Keys on this device</h5>
                <p
                    data-testid="keys-state"
                    class="text-sm mt-1 text-gray-500 dark:text-gray-400"
                >
                    {server.vaultUnlocked
                        ? "Encryption Keys are already unlocked on this device."
                        : "Encryption Keys are locked on this device."}
                </p>
                <p
                    data-testid="keys-help"
                    class="mt-1 text-sm text-gray-500 dark:text-gray-400"
                >
                    Your synced graphs on {server.host} open in this browser only
                    while your Encryption Keys are unlocked here. They stay unlocked
                    until you sign out, forget the server, remove its synced graphs
                    from this browser, or clear this browser's data. If your Encryption
                    Keys are replaced or reset on another device, the ones held here
                    stop working. Unlock them again, by approval from another device
                    or with the new Recovery Code, to replace them.
                </p>
                <button
                    type="button"
                    data-testid="unlock-keys"
                    onclick={actions.unlock}
                    class="mt-2 {SECONDARY_BUTTON}"
                    >Unlock Encryption Keys</button
                >
            </div>
            <div class={SUBSECTION}>
                <h5 class={SUBHEADING}>Your security fingerprint</h5>
                <p class="text-sm mt-1 text-gray-500 dark:text-gray-400">
                    When someone invites you to a graph, they see a fingerprint
                    for your account and are asked to check that it is yours.
                    Read them this one in person, or on a call you trust. The
                    fingerprint is not secret.
                </p>
                {#if server.fingerprint}
                    <code
                        data-testid="own-fingerprint"
                        class="mt-2 block rounded-lg bg-gray-100 px-4 py-3 text-center font-mono text-sm tracking-wide break-all text-gray-950 dark:bg-white/5 dark:text-gray-100"
                        >{server.fingerprint}</code
                    >
                {:else}
                    <button
                        type="button"
                        data-testid="show-own-fingerprint"
                        onclick={actions.showFingerprint}
                        disabled={server.fingerprintPending}
                        aria-busy={server.fingerprintPending}
                        class="mt-2 {SECONDARY_BUTTON} aria-busy:cursor-progress"
                        >{server.fingerprintPending
                            ? "Reading…"
                            : "Show my fingerprint"}</button
                    >
                {/if}
            </div>
        {/if}
    </section>

    <!-- Apart from everything else and last, because it destroys what cannot be recovered. Only an
         account with keys has anything to reset. It is offered while the keys are locked too, since
         being unable to unlock anywhere is when it is needed. -->
    {#if account && server.vaultExists !== false}
        <section
            data-testid="sync-danger-zone"
            aria-labelledby="sync-danger-heading"
            class="space-y-2 rounded-xl border border-red-200 bg-white p-4 dark:border-red-500/30 dark:bg-white/5"
        >
            <h4
                id="sync-danger-heading"
                class="text-base font-semibold text-red-700 dark:text-red-400"
            >
                Danger zone
            </h4>
            <h5 class={SUBHEADING}>Reset Encryption Keys</h5>
            <p class="text-sm text-gray-500 dark:text-gray-400">
                Reset only if you cannot unlock your Encryption Keys anywhere,
                because you have lost your Recovery Code and no device of yours
                is still unlocked. A reset deletes your Encryption Keys on {server.host},
                and creating new ones afterwards gives you a new Recovery Code.
            </p>
            <p class="text-sm text-gray-500 dark:text-gray-400">
                <strong class="font-semibold text-gray-700 dark:text-gray-200"
                    >Graphs you own on {server.host} will be deleted PERMANENTLY,
                    and you leave the graphs other people own that are shared with
                    you.</strong
                >
                Transfer a graph you share to another player first to keep it. The
                reset lists them and offers that. A reset cannot be undone. Other
                Sync Servers are not affected.
            </p>
            <p class="text-sm text-gray-500 dark:text-gray-400">
                A reset does not fix a problem on one device. A graph marked
                <span class="font-medium">Not on this device</span> comes back
                with
                <span class="font-medium">Add to this device</span> on the
                Graphs tab, and Encryption Keys that stop working here are
                replaced with
                <span class="font-medium">Unlock Encryption Keys</span> above.
            </p>
            <button
                type="button"
                data-testid="reset-keys"
                onclick={actions.reset}
                class="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 pointer-coarse:min-h-11 dark:border-red-500/40 dark:hover:bg-red-950/30"
                >Reset Encryption Keys</button
            >
        </section>
    {/if}
</div>
