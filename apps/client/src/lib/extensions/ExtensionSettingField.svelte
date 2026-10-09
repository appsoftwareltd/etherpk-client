<script lang="ts">
    /**
     * One of an extension's settings (ADR 0134), as its manifest declares it: a text field, or a
     * secret one shown masked until asked. What is typed is a draft until Save; Remove clears the
     * setting. A value that arrives from another device or tab replaces the draft.
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

    function save() {
        settings.set(key, draft);
    }

    function remove() {
        settings.set(key, null);
        revealed = false;
    }

    const secondaryButton =
        "rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50";
    const primaryButton =
        "rounded-lg bg-gray-900 dark:bg-gray-100 px-3 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:bg-gray-300 disabled:text-gray-600 dark:disabled:bg-gray-700 dark:disabled:text-gray-300";
</script>

<div data-testid="extension-setting" data-setting={setting.id}>
    <label for={inputId} class="mb-1 block text-sm font-medium text-gray-950 dark:text-gray-100">{setting.title}</label>
    {#if setting.description}
        <p class="mb-1.5 text-sm text-gray-600 dark:text-gray-400">{setting.description}</p>
    {/if}
    <div class="flex flex-wrap items-center gap-2">
        <input
            id={inputId}
            type={secret && !revealed ? "password" : "text"}
            class={[
                "block min-w-0 flex-1 basis-60 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-950 dark:border-gray-700 dark:bg-white/10 dark:text-gray-100",
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
    {#if setting.link}
        <p class="mt-1.5 text-sm">
            <a href={setting.link.url} target="_blank" rel="noopener noreferrer" class="font-medium text-agent-600 hover:underline dark:text-agent-300">{setting.link.title}</a>
        </p>
    {/if}
</div>
