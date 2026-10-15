<script lang="ts">
    /**
     * The sections switched-on extensions add to one of the Client's settings tabs (ADR 0134,
     * amended 2026-10-15), each mounted into an element of its own with a context that belongs to
     * the person. Used with no graph open (the Graphs page) and inside a graph's settings alike.
     * Draws nothing when no extension adds a section to the tab.
     */
    import type { SettingsSectionTab } from "@appsoftwareltd/etherpk-extension-api";
    import { getAppliedResolvedTheme } from "@appsoftwareltd/etherpk-shared/theme";
    import type { Attachment } from "svelte/attachments";
    import { createSubscriber } from "svelte/reactivity";

    import { showNotice } from "$lib/activity/notices";
    import { personSettings } from "$lib/person-settings/person-settings";

    import { builtInCatalogue } from "./built-ins";
    import { type ExtensionSettingsSection, settingsSectionsFor } from "./settings-sections";
    import { browserSignIn } from "./sign-in";
    import { createExtensionSwitches, type ExtensionSwitches } from "./switches";

    const {
        tab,
        switches = createExtensionSwitches(),
    }: {
        tab: SettingsSectionTab;
        /**
         * The switches to follow: the open graph's extension host, so a switch thrown in Extensions
         * shows here at once, or this device's switches where no graph is open.
         */
        switches?: Pick<ExtensionSwitches, "isOn" | "subscribe">;
    } = $props();

    const switchesChanged = $derived(createSubscriber((update) => switches.subscribe(update)));
    const sections = $derived.by(() => {
        switchesChanged();
        return settingsSectionsFor(tab, {
            catalogue: builtInCatalogue,
            switches,
            client: { settings: personSettings(), signIn: browserSignIn(), isDark: () => getAppliedResolvedTheme() === "dark" },
            notify: (text) => showNotice({ id: "extension-settings", text, tone: "info" }),
        });
    });

    /** Draw one section; take it back, and its context's subscriptions, when it leaves. */
    function drawn(entry: ExtensionSettingsSection): Attachment<HTMLElement> {
        return (element) => {
            let mounted: { destroy(): void } | null = null;
            try {
                mounted = entry.section.mount(element, entry.context);
            } catch (error) {
                console.error(`[extensions] ${entry.extensionId}: its settings section failed to draw`, error);
            }
            return () => {
                mounted?.destroy();
                entry.dispose();
            };
        };
    }
</script>

{#each sections as entry (`${entry.extensionId}:${entry.section.id}`)}
    <div data-testid="extension-settings-section" data-extension={entry.extensionId} {@attach drawn(entry)}></div>
{/each}
