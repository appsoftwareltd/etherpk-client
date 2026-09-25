<script lang="ts">
    /**
     * The **Protected Documents** tab of the Settings modal: the per-device lock timings, what a
     * Lock Now does to the tab strip, this device's passkey, and changing the passphrase.
     *
     * Renders into someone else's dialog rather than hosting one, so every button here declares
     * `type="button"` — an untyped button inside the shell's form is a submit button, and would
     * save and close the whole modal (`dialog-button-type.test.ts`).
     *
     * The timings and the Lock Now preference are written the moment they change rather than on
     * Save. They are per-device `localStorage`, so there is nothing to reconcile and nothing to
     * lose by leaving the tab; and a Save that applied to two tabs at once would be the confusing
     * thing, not this.
     */
    import { untrack } from "svelte";

    import type { ProtectionTabProps } from "./protection-tab";

    let {
        isConfigured,
        isUnlocked,
        lockSettings,
        canBindPasskey,
        hasPasskey,
        onsettings,
        onsetup,
        onbindpasskey,
        onchangepassphrase,
    }: ProtectionTabProps = $props();

    // Seeded once, deliberately: these are controls the user drives, and the modal mounts fresh.
    let maskGraceMs = $state(untrack(() => lockSettings.maskGraceMs));
    let idleLockMs = $state(untrack(() => lockSettings.idleLockMs));
    let closeOnLockNow = $state(untrack(() => lockSettings.closeOnLockNow));

    let passkeyBusy = $state(false);
    let passkeyMessage = $state<string | null>(null);
    let passkeyError = $state<string | null>(null);

    let changing = $state(false);
    let currentPassphrase = $state("");
    let nextPassphrase = $state("");
    let confirmPassphrase = $state("");
    let changeBusy = $state(false);
    let changeError = $state<string | null>(null);
    let changeDone = $state(false);

    /** Zero is a real choice, not a typo: a hard lock the instant attention leaves. */
    const GRACE_CHOICES = [
        { ms: 0, label: "Immediately" },
        { ms: 15_000, label: "After 15 seconds" },
        { ms: 60_000, label: "After 1 minute" },
        { ms: 300_000, label: "After 5 minutes" },
    ];

    /** Zero disables idle locking, for a device the user considers physically safe. */
    const IDLE_CHOICES = [
        { ms: 60_000, label: "1 minute" },
        { ms: 300_000, label: "5 minutes" },
        { ms: 900_000, label: "15 minutes" },
        { ms: 3_600_000, label: "1 hour" },
        { ms: 0, label: "Never" },
    ];

    function persist() {
        onsettings({ maskGraceMs, idleLockMs, closeOnLockNow });
    }

    async function bindPasskey() {
        if (passkeyBusy) return;
        passkeyBusy = true;
        passkeyError = null;
        passkeyMessage = null;
        try {
            await onbindpasskey();
            passkeyMessage = "This device can now unlock with its passkey.";
        } catch (e) {
            passkeyError = (e as Error).message;
        } finally {
            passkeyBusy = false;
        }
    }

    async function changePassphrase() {
        if (changeBusy) return;
        changeError = null;
        if (!currentPassphrase || !nextPassphrase) {
            changeError = "Enter both your current and your new passphrase.";
            return;
        }
        if (nextPassphrase !== confirmPassphrase) {
            changeError = "The new passphrase and its confirmation don't match.";
            return;
        }
        changeBusy = true;
        try {
            await onchangepassphrase(currentPassphrase, nextPassphrase);
            changeDone = true;
            changing = false;
            currentPassphrase = "";
            nextPassphrase = "";
            confirmPassphrase = "";
        } catch (e) {
            changeError = (e as Error).message;
        } finally {
            changeBusy = false;
        }
    }
</script>

{#if !isConfigured}
    <!-- The front door. With protection settings out of the command menu, a tab that said only
         "nothing here" would teach people the feature does not exist — and this is a calmer place
         to meet the no-recovery warning than mid-flow when you were trying to hide one line. -->
    <div class="space-y-3" data-testid="protection-tab-empty">
        <p class="text-sm text-gray-600 dark:text-gray-400">
            Protected documents are scrambled on disk. Their contents can only be read after you
            enter a passphrase, and they are never reachable by search.
        </p>
        <p class="text-sm text-gray-600 dark:text-gray-400">
            This graph has no protection passphrase yet. Setting one up takes a moment - but choose
            it carefully, because <strong>a forgotten passphrase cannot be recovered</strong>, by us
            or by your Recovery Code.
        </p>
        <button
            type="button"
            onclick={onsetup}
            data-testid="protection-setup"
            class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
        >Set up protection…</button>
    </div>
{:else}
    <div class="space-y-4">
        <div>
            <label for="protection-grace" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">
                Lock after I switch away
            </label>
            <select
                id="protection-grace"
                bind:value={maskGraceMs}
                onchange={persist}
                data-testid="protection-grace-select"
                class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100"
            >
                {#each GRACE_CHOICES as choice (choice.ms)}
                    <option value={choice.ms}>{choice.label}</option>
                {/each}
            </select>
            <p class="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
                Contents leave the screen the instant you switch away either way. This is how long
                before the key itself is discarded, so coming back needs your passphrase again.
            </p>
        </div>

        <div>
            <label for="protection-idle" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">
                Lock after this long with no activity
            </label>
            <select
                id="protection-idle"
                bind:value={idleLockMs}
                onchange={persist}
                data-testid="protection-idle-select"
                class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100"
            >
                {#each IDLE_CHOICES as choice (choice.ms)}
                    <option value={choice.ms}>{choice.label}</option>
                {/each}
            </select>
            <p class="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
                Both apply to <strong>this device only</strong>, and save as you change them. A
                desktop at home and a laptop on a train deserve different answers.
            </p>
        </div>

        <!-- A privacy setting, not a tidiness one, so it defaults to on: a deliberate lock is the
             user saying they are leaving, and a row of padlocked tabs still names what they had
             open. Only a Lock Now closes anything - the timers above never touch the Layout. -->
        <div>
            <label class="flex items-start gap-2 text-sm text-gray-950 dark:text-gray-100">
                <input
                    type="checkbox"
                    bind:checked={closeOnLockNow}
                    onchange={persist}
                    data-testid="protection-close-on-lock"
                    class="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-700"
                />
                <span>Close protected documents when I lock now</span>
            </label>
            <p class="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
                Only when you lock deliberately - from the sidebar, a document's padlock or the
                command. Timeouts never close anything, so it can't take your tabs away mid-work.
            </p>
        </div>

        <div class="border-t border-gray-100 dark:border-gray-800 pt-4">
            <h3 class="text-sm font-medium text-gray-950 dark:text-gray-100">This device</h3>
            {#if hasPasskey}
                <p class="mt-1 text-sm text-gray-600 dark:text-gray-400" data-testid="protection-passkey-bound">
                    A passkey is bound to this device, so you can unlock with your fingerprint, face
                    or device PIN instead of typing your passphrase.
                </p>
            {:else if !canBindPasskey}
                <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
                    This browser does not support passkeys, so unlocking here always needs the
                    passphrase.
                </p>
            {:else}
                <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
                    Bind a passkey and this device can unlock without the passphrase. It also means
                    that if you ever forget the passphrase, this device can still get in and let you
                    set a new one - which is the only way back there is.
                </p>
                <button
                    type="button"
                    onclick={() => void bindPasskey()}
                    disabled={passkeyBusy || !isUnlocked}
                    data-testid="protection-bind-passkey"
                    class="mt-2 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-40"
                >{passkeyBusy ? "Waiting…" : "Bind a passkey to this device"}</button>
                {#if !isUnlocked}
                    <p class="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
                        Unlock this graph first - binding a passkey needs the key itself.
                    </p>
                {/if}
            {/if}
            {#if passkeyMessage}
                <p role="status" class="mt-2 text-sm text-green-700 dark:text-green-500" data-testid="protection-passkey-message">{passkeyMessage}</p>
            {/if}
            {#if passkeyError}
                <p role="alert" class="mt-2 text-sm text-red-600" data-testid="protection-passkey-error">{passkeyError}</p>
            {/if}
        </div>

        <div class="border-t border-gray-100 dark:border-gray-800 pt-4">
            <h3 class="text-sm font-medium text-gray-950 dark:text-gray-100">Passphrase</h3>
            {#if changeDone}
                <p role="status" class="mt-1 text-sm text-green-700 dark:text-green-500" data-testid="protection-change-done">
                    Your passphrase has been changed.
                </p>
            {:else if changing}
                <div class="mt-2 space-y-2">
                    <input
                        type="password"
                        bind:value={currentPassphrase}
                        placeholder="Current passphrase"
                        aria-label="Current passphrase"
                        autocomplete="current-password"
                        data-testid="protection-change-current"
                        class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100"
                    />
                    <input
                        type="password"
                        bind:value={nextPassphrase}
                        placeholder="New passphrase"
                        aria-label="New passphrase"
                        autocomplete="new-password"
                        data-testid="protection-change-next"
                        class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100"
                    />
                    <input
                        type="password"
                        bind:value={confirmPassphrase}
                        placeholder="New passphrase, again"
                        aria-label="Confirm new passphrase"
                        autocomplete="new-password"
                        data-testid="protection-change-confirm"
                        class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100"
                    />
                    {#if changeError}
                        <p role="alert" class="text-sm text-red-600" data-testid="protection-change-error">{changeError}</p>
                    {/if}
                    <div class="flex gap-2">
                        <button
                            type="button"
                            onclick={() => void changePassphrase()}
                            disabled={changeBusy}
                            data-testid="protection-change-submit"
                            class="rounded-lg bg-gray-900 dark:bg-gray-100 px-3 py-1.5 text-sm font-medium text-white dark:text-gray-900 disabled:opacity-40"
                        >{changeBusy ? "Changing…" : "Change passphrase"}</button>
                        <button
                            type="button"
                            onclick={() => (changing = false)}
                            class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400"
                        >Cancel</button>
                    </div>
                </div>
            {:else}
                <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
                    Changing it re-wraps the same key, so no note is re-encrypted and nothing becomes
                    unreadable.
                </p>
                <button
                    type="button"
                    onclick={() => (changing = true)}
                    data-testid="protection-change-open"
                    class="mt-2 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-white/5"
                >Change passphrase…</button>
            {/if}
        </div>
    </div>
{/if}
