<script lang="ts">
    /**
     * The Device Passcode section of the This Device tab (ADR 0129): whether this device has one,
     * and setting, entering, changing or turning it off. One passcode covers every server's
     * Encryption Keys on the device, so it lives with what the device holds rather than on any
     * one server's tab. A rule on the page, not a card border, separates it from the next section.
     */
    import { OPEN_HERE, THIS_PLACE } from "#lib/native/place.js";
    import DevicePasscodeDialog, {
        type DevicePasscodeDialogMode,
    } from "#lib/sync/ui/DevicePasscodeDialog.svelte";
    import { devicePasscodeState } from "#lib/sync/ui/device-passcode-state.svelte.js";

    let {
        ondone,
        onforgotten,
    }: {
        /** The passcode was set, entered, changed or turned off from this section. */
        ondone: (mode: DevicePasscodeDialogMode) => void;
        /** Forgot your passcode? removed the Encryption Keys it protected. */
        onforgotten: () => void;
    } = $props();

    const passcode = $derived(devicePasscodeState());
    let dialog = $state<DevicePasscodeDialogMode | null>(null);

    const SECONDARY_BUTTON = "gk-button";
    const PRIMARY_BUTTON = "gk-button gk-button--primary";
</script>

<section
    data-testid="device-passcode"
    aria-labelledby="device-passcode-heading"
    class="space-y-3"
>
    <h2
        id="device-passcode-heading"
        class="text-lg font-semibold text-neutral-950 dark:text-white"
    >
        Device Passcode
    </h2>
    <!-- Polite: it changes when the passcode is set or turned off here or in another tab. -->
    <p
        class="text-sm text-neutral-600 dark:text-neutral-400"
        data-testid="device-passcode-status"
        data-state={passcode}
        aria-live="polite"
    >
        {#if passcode === "off"}
            Off. The Encryption Keys this device holds for your synced graphs,
            and the access tokens for your own Sync Servers, are stored in {THIS_PLACE}
            without encryption. A passcode keeps them encrypted, and you enter it
            once each time you {OPEN_HERE}.
        {:else if passcode === "locked"}
            On. The passcode has not been entered in {THIS_PLACE} session, so
            the Encryption Keys it protects are not in use yet.
        {:else}
            On. The Encryption Keys this device holds for your synced graphs, and
            the access tokens for your own Sync Servers, are stored encrypted under the
            passcode.
        {/if}
    </p>
    <p class="text-sm text-neutral-600 dark:text-neutral-400">
        One passcode covers every Sync Server on this device. It protects
        Encryption Keys and access tokens, not the documents already stored on
        this device.
    </p>
    <div class="flex flex-wrap gap-2">
        {#if passcode === "off"}
            <button
                type="button"
                data-testid="device-passcode-set"
                onclick={() => (dialog = "set")}
                class={PRIMARY_BUTTON}>Set a passcode</button
            >
        {:else}
            {#if passcode === "locked"}
                <button
                    type="button"
                    data-testid="device-passcode-enter"
                    onclick={() => (dialog = "unlock")}
                    class={PRIMARY_BUTTON}>Enter passcode</button
                >
            {/if}
            <button
                type="button"
                data-testid="device-passcode-change"
                onclick={() => (dialog = "change")}
                class={SECONDARY_BUTTON}>Change passcode</button
            >
            <button
                type="button"
                data-testid="device-passcode-turn-off"
                onclick={() => (dialog = "turn-off")}
                class={SECONDARY_BUTTON}>Turn off</button
            >
        {/if}
    </div>
</section>

{#if dialog}
    {@const mode = dialog}
    <DevicePasscodeDialog
        {mode}
        ondone={() => {
            dialog = null;
            ondone(mode);
        }}
        onclose={() => (dialog = null)}
        onforgotten={() => {
            dialog = null;
            onforgotten();
        }}
    />
{/if}
