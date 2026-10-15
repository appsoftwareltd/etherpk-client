<script lang="ts">
    /**
     * Signing in the agent's computer, the one its Headless Client runs on, to one Sync Server,
     * once (ADR 0072, ADR 0132): an Agent Setup Code, and the `login` command that carries it. Shown
     * in a graph's Agents tab, as its first step, and on the Graphs page's Agents tab, where no
     * graph is open (ADR 0147): signing in belongs to the account, not to one graph. A browser
     * signed in to a custom server holds a Personal Access Token, which cannot ask for a code, so
     * there the code is created on the Sync Server's own Access tokens page.
     *
     * The code lives here and nowhere else: never stored, gone when this is closed, and replaced by
     * "expired" when its time is up, so the screen never offers a command that can no longer work.
     */
    import { onDestroy, tick } from "svelte";

    import { SyncApiError } from "$lib/sync/sync-api";
    import { describeSyncFailure } from "$lib/sync/sync-error-copy";

    import { loginCommand, tokensPageUrl } from "./agents-tab";

    const {
        serverBaseUrl,
        headlessClient,
        createSetupCode,
        numbered = false,
    }: {
        serverBaseUrl: string;
        headlessClient: string;
        /** Ask the server for an Agent Setup Code over the managed connection; null on a custom server (ADR 0132). */
        createSetupCode: (() => Promise<{ code: string; expiresAt: string }>) | null;
        /** The first of numbered steps: "1. Sign in the agent's computer". */
        numbered?: boolean;
    } = $props();

    type SetupCodeState =
        | { phase: "idle" }
        | { phase: "making" }
        | { phase: "ready"; code: string; expiresAt: string }
        | { phase: "expired" }
        | { phase: "failed"; message: string };
    let setupCode = $state<SetupCodeState>({ phase: "idle" });
    let setupCodeRequest = 0;
    let setupCodeTimer: ReturnType<typeof setTimeout> | undefined;
    let loginCopyButton = $state<HTMLButtonElement>();
    let copied = $state(false);
    let copyError = $state<string | null>(null);
    onDestroy(() => clearTimeout(setupCodeTimer));

    const heading = $derived(numbered ? "1. Sign in the agent's computer" : "Sign in the agent's computer");

    async function makeSetupCode() {
        const create = createSetupCode;
        if (!create || setupCode.phase === "making") return;
        const request = ++setupCodeRequest;
        clearTimeout(setupCodeTimer);
        setupCode = { phase: "making" };
        try {
            const made = await create();
            if (request !== setupCodeRequest) return;
            setupCode = { phase: "ready", ...made };
            // The next thing to do is copy the command: put that a key press away.
            await tick();
            loginCopyButton?.focus();
            setupCodeTimer = setTimeout(
                () => {
                    if (request === setupCodeRequest) setupCode = { phase: "expired" };
                },
                Math.max(0, new Date(made.expiresAt).getTime() - Date.now()),
            );
        } catch (error) {
            if (request !== setupCodeRequest) return;
            if (error instanceof SyncApiError && error.status === 409) {
                // The server's own words say how many codes are waiting and how long to wait.
                setupCode = { phase: "failed", message: error.message };
            } else {
                setupCode = { phase: "failed", message: describeSyncFailure(error, "create an Agent Setup Code") };
            }
        }
    }

    async function copy(text: string) {
        copyError = null;
        try {
            await navigator.clipboard.writeText(text);
            copied = true;
            setTimeout(() => (copied = false), 2000);
        } catch {
            // No clipboard (an insecure context, a denied permission): the text is on screen
            // and selectable, so say that rather than failing silently.
            copyError = "Couldn't copy - select the command and copy it by hand.";
        }
    }

    const command = $derived(setupCode.phase === "ready" ? loginCommand(serverBaseUrl, headlessClient, setupCode.code) : null);
    const link = "underline decoration-gray-400 underline-offset-2 hover:decoration-gray-950 dark:hover:decoration-gray-100";
</script>

{#if createSetupCode === null}
    <p>
        <span class="font-medium">{heading}</span>, once per computer. Create an Agent Setup Code on
        <a href={tokensPageUrl(serverBaseUrl)} target="_blank" rel="noreferrer" class={link} data-testid="agents-setup-on-portal">the Sync Server's Access tokens page</a
        >, under <strong>Set up an agent</strong>, and run the command it shows on the agent's computer. The Headless Client trades the code for an Agent Token limited to the
        routes an agent needs, then asks for Device Approval: confirm the matching code in EtherPK on any device where your Encryption Keys are unlocked.
    </p>
{:else}
    <p>
        <span class="font-medium">{heading}</span>, once per computer. Create an Agent Setup Code and run the command on the agent's computer. The Headless Client trades the code
        for an Agent Token limited to the routes an agent needs, then asks for Device Approval: confirm the matching code in EtherPK on any device where your Encryption Keys are
        unlocked.
    </p>
{/if}
{#if command}
    <div class="flex items-start gap-2">
        <pre
            class="min-w-0 flex-1 overflow-x-auto rounded-md border border-gray-900/10 dark:border-gray-100/15 bg-gray-50 dark:bg-white/5 p-3 font-mono text-sm"
            data-testid="agents-login-command">{command}</pre>
        <button
            type="button"
            bind:this={loginCopyButton}
            onclick={() => copy(command)}
            class="shrink-0 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
            data-testid="agents-copy-login">{copied ? "Copied" : "Copy"}</button
        >
    </div>
{/if}
{#if copyError}<p role="status" class="text-sm text-red-700 dark:text-red-400">{copyError}</p>{/if}
{#if setupCode.phase === "ready"}
    <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="agents-setup-code-expiry">
        Works once and expires at {new Date(setupCode.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Keep it secret until then.
    </p>
{:else if setupCode.phase === "expired"}
    <p role="status" class="text-sm text-gray-600 dark:text-gray-400" data-testid="agents-setup-code-expired">
        That Agent Setup Code has expired. Create a new one when you're ready to run the command.
    </p>
{:else if setupCode.phase === "failed"}
    <p role="alert" class="text-sm text-red-700 dark:text-red-400" data-testid="agents-setup-code-error">{setupCode.message}</p>
{/if}
{#if createSetupCode !== null}
    <button
        type="button"
        onclick={makeSetupCode}
        disabled={setupCode.phase === "making"}
        class="rounded-lg bg-gray-950 dark:bg-white px-4 py-2 text-sm font-medium text-white dark:text-gray-950 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-60"
        data-testid="agents-make-setup-code"
    >
        {setupCode.phase === "making"
            ? "Creating an Agent Setup Code…"
            : setupCode.phase === "idle"
              ? "Create an Agent Setup Code"
              : setupCode.phase === "failed"
                ? "Try again"
                : "Create a new Agent Setup Code"}
    </button>
{/if}
