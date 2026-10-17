<script lang="ts">
    /**
     * One of an extension's settings (ADR 0134), as its manifest declares it: a text field, a
     * secret one shown masked until asked, or a switch. What is typed is a draft until Save; Remove
     * clears the setting. A switch is saved as soon as it is changed, as the extension's own switch
     * is, and shows its manifest's default until then. A value that arrives from another device or
     * tab replaces the draft.
     */
    import type { SettingDeclaration } from "@appsoftwareltd/etherpk-extension-api";
    import { createSubscriber } from "svelte/reactivity";

    import { extensionSettingKey, type PersonSettings } from "$lib/person-settings/person-settings";

    const { extensionId, setting, settings }: { extensionId: string; setting: SettingDeclaration; settings: PersonSettings } = $props();

    /** Longer than any key a provider issues, short enough that a pasted document is refused. */
    const MAX_LENGTH = 2000;

    const key = $derived(extensionSettingKey(extensionId, setting.id));
    const inputId = $derived(`extension-setting-${extensionId}-${setting.id}`);
    const watchSettings = createSubscriber((update) => settings.subscribe(update));
    const saved = $derived.by(() => {
        watchSettings();
        return settings.get(key) ?? "";
    });
    /** What the field holds: the saved value until the person types. */
    let draft = $derived(saved);
    let revealed = $state(false);
    const secret = $derived(setting.type === "secret");
    /** A switch's position: what the person chose, or the manifest's default. */
    const on = $derived(saved === "true" || (saved !== "false" && setting.default === true));
    const descriptionId = $derived(`${inputId}-description`);

    function save() {
        settings.set(key, draft);
    }

    function remove() {
        settings.set(key, null);
        revealed = false;
    }

    // EtherPK's control classes (controls.css, ADR 0151): the same buttons and fields an extension draws.
    const secondaryButton = "gk-button";
    const primaryButton = "gk-button gk-button--primary";
</script>

<div data-testid="extension-setting" data-setting={setting.id}>
    {#if setting.type === "boolean"}
        <label class="gk-label flex items-start gap-2">
            <input
                id={inputId}
                type="checkbox"
                checked={on}
                onchange={(e) => settings.set(key, e.currentTarget.checked ? "true" : "false")}
                aria-describedby={setting.description ? descriptionId : undefined}
                data-testid="extension-setting-switch"
                class="gk-checkbox mt-0.5"
            />
            <span>{setting.title}</span>
        </label>
        {#if setting.description}
            <p id={descriptionId} class="gk-hint mt-1">{setting.description}</p>
        {/if}
    {:else}
        <label for={inputId} class="gk-label mb-1 block">{setting.title}</label>
        {#if setting.description}
            <p class="gk-hint mb-1.5">{setting.description}</p>
        {/if}
        <div class="flex flex-wrap items-center gap-2">
            <input
                id={inputId}
                type={secret && !revealed ? "password" : "text"}
                class={[
                    "gk-input flex-1 basis-60",
                    // A key or a token is read character by character.
                    { "font-mono": secret },
                ]}
                bind:value={draft}
                placeholder={setting.placeholder}
                maxlength={MAX_LENGTH}
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                data-1p-ignore
                data-lpignore="true"
                onkeydown={(e) => {
                    if (e.key === "Enter") save();
                }}
                data-testid="extension-setting-input"
            />
            {#if secret}
                <button
                    type="button"
                    class={secondaryButton}
                    aria-label={revealed ? `Hide ${setting.title}` : `Show ${setting.title}`}
                    onclick={() => (revealed = !revealed)}
                    data-testid="extension-setting-reveal"
                >
                    {revealed ? "Hide" : "Show"}
                </button>
            {/if}
            <button type="button" class={primaryButton} disabled={draft.trim() === saved} onclick={save} data-testid="extension-setting-save">Save</button>
            {#if saved !== ""}
                <button type="button" class={secondaryButton} onclick={remove} data-testid="extension-setting-remove">Remove</button>
            {/if}
        </div>
    {/if}
    {#if setting.link}
        <p class="mt-1.5 text-sm">
            <a href={setting.link.url} target="_blank" rel="noopener noreferrer" class="gk-link">{setting.link.title}</a>
        </p>
    {/if}
</div>
