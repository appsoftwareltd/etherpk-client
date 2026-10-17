<script lang="ts">
    /**
     * The sections switched-on extensions add to one of the Client's settings tabs (ADR 0134,
     * amended 2026-10-15 and 2026-10-17), each mounted into an element of its own with a context
     * that belongs to the person. Used with no graph open (the Graphs page) and inside a graph's
     * settings alike: given the open graph's extension host, it draws the sections of the loaded
     * extensions running there as well as the compiled-in ones'. With `extensionId`, it draws one
     * extension's sections, under that extension's entry in Extensions. Draws nothing when no
     * extension adds a section.
     */
    import type { SettingsSectionTab } from "@appsoftwareltd/etherpk-extension-api";
    import { getAppliedResolvedTheme } from "@appsoftwareltd/etherpk-shared/theme";
    import type { Attachment } from "svelte/attachments";
    import { createSubscriber } from "svelte/reactivity";

    import { showNotice } from "$lib/activity/notices";
    import { personSettings } from "$lib/person-settings/person-settings";

    import { builtInCatalogue } from "./built-ins";
    import type { ExtensionHost } from "./host";
    import { type ExtensionSettingsSection, settingsSectionsFor } from "./settings-sections";
    import { browserSignIn } from "./sign-in";
    import { createExtensionSwitches, type ExtensionSwitches } from "./switches";

    const {
        tab,
        host = null,
        extensionId,
        switches = host ?? createExtensionSwitches(),
    }: {
        tab: SettingsSectionTab;
        /** The open graph's extension host, whose running extensions' sections are drawn too. */
        host?: ExtensionHost | null;
        /** Only this extension's sections. */
        extensionId?: string;
        /**
         * The switches to follow: the open graph's extension host, so a switch thrown in Extensions
         * shows here at once, or this device's switches where no graph is open.
         */
        switches?: Pick<ExtensionSwitches, "isOn" | "subscribe">;
    } = $props();

    const switchesChanged = $derived(createSubscriber((update) => switches.subscribe(update)));
    // An extension starting or stopping in the open graph brings its sections or takes them away.
    const hostChanged = $derived(createSubscriber((update) => host?.subscribe(update) ?? (() => {})));
    /**
     * The sections drawn, by extension and section id, kept while they are still offered: the host
     * reports every status change, and a section must not be drawn again under the person's pointer
     * for another extension's.
     */
    const kept = new Map<string, ExtensionSettingsSection>();
    const sections = $derived.by(() => {
        switchesChanged();
        hostChanged();
        const found = settingsSectionsFor(tab, {
            catalogue: host?.catalogue ?? builtInCatalogue,
            switches,
            loadedModule: host ? (id) => host.runningModule(id) : undefined,
            extensionId,
            client: { settings: personSettings(), signIn: browserSignIn(), isDark: () => getAppliedResolvedTheme() === "dark" },
            notify: (text) => showNotice({ id: "extension-settings", text, tone: "info" }),
        });
        const offered = new Set<string>();
        const drawnNow = found.map((entry) => {
            const key = `${entry.extensionId}:${entry.section.id}`;
            offered.add(key);
            const before = kept.get(key);
            if (before && before.section === entry.section) {
                entry.dispose();
                return before;
            }
            kept.set(key, entry);
            return entry;
        });
        for (const key of [...kept.keys()]) if (!offered.has(key)) kept.delete(key);
        return drawnNow;
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
