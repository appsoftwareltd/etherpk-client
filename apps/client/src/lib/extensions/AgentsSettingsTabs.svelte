<script lang="ts">
    /**
     * The Agents tab of Settings, on a graph and on the Graphs page alike, split into a sub-tab for
     * each kind of agent (ADR 0178): an agent outside EtherPK reaching the graph over MCP, and each
     * extension with a section here, such as Agent Chat. The MCP Server comes first, because an
     * [[Agent Instruction]] sends a person here to connect an agent. With no extension to show, the
     * MCP Server stands alone with no tabs.
     *
     * Both panels stay mounted, so a setup code or a half-filled connection form survives a look at
     * the other one.
     */
    import type { Snippet } from "svelte";
    import { createSubscriber } from "svelte/reactivity";

    import { builtInCatalogue } from "./built-ins";
    import ExtensionSettingsSections from "./ExtensionSettingsSections.svelte";
    import type { ExtensionHost } from "./host";
    import { extensionsWithSections } from "./settings-sections";
    import { createExtensionSwitches, type ExtensionSwitches } from "./switches";

    const MCP = "mcp";

    const {
        host = null,
        initial = MCP,
        switches = host ?? createExtensionSwitches(),
        mcp,
    }: {
        /** The open graph's extension host; null on the Graphs page. */
        host?: ExtensionHost | null;
        /** The sub-tab to open on: an extension's id. One that is not here falls back to the MCP Server. */
        initial?: string;
        /** The switches to follow: the open graph's extension host, or this device's switches. */
        switches?: Pick<ExtensionSwitches, "isOn" | "subscribe">;
        mcp: Snippet;
    } = $props();

    const switchesChanged = $derived(createSubscriber((update) => switches.subscribe(update)));
    const hostChanged = $derived(createSubscriber((update) => host?.subscribe(update) ?? (() => {})));
    const extensions = $derived.by(() => {
        switchesChanged();
        hostChanged();
        return extensionsWithSections("agents", {
            catalogue: host?.catalogue ?? builtInCatalogue,
            switches,
            loadedModule: host ? (id) => host.runningModule(id) : undefined,
        });
    });
    const tabs = $derived([{ id: MCP, label: "MCP Server" }, ...extensions.map((extension) => ({ id: extension.id, label: extension.displayName }))]);

    const uid = $props.id();
    // Mounted fresh for each open of Settings, so the first value is the one to start from.
    // svelte-ignore state_referenced_locally
    let chosen = $state(initial);
    // An extension switched off while its sub-tab is showing leaves the MCP Server showing.
    const active = $derived(tabs.some((tab) => tab.id === chosen) ? chosen : MCP);

    /** The arrow keys, Home and End move between the sub-tabs, and the Tab key leaves them. */
    function onkeydown(event: KeyboardEvent) {
        const current = tabs.findIndex((tab) => tab.id === active);
        const next =
            event.key === "ArrowRight"
                ? (current + 1) % tabs.length
                : event.key === "ArrowLeft"
                  ? (current - 1 + tabs.length) % tabs.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : null;
        if (next === null) return;
        event.preventDefault();
        chosen = tabs[next].id;
        (event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(`#${CSS.escape(`${uid}-tab-${tabs[next].id}`)}`)?.focus();
    }
</script>

{#if tabs.length > 1}
    <div role="tablist" aria-label="Kinds of agent" class="mb-4 flex flex-wrap gap-1" data-testid="agents-sub-tabs">
        {#each tabs as tab (tab.id)}
            <button
                type="button"
                role="tab"
                id="{uid}-tab-{tab.id}"
                aria-selected={active === tab.id}
                aria-controls="{uid}-panel-{tab.id}"
                tabindex={active === tab.id ? 0 : -1}
                onclick={() => (chosen = tab.id)}
                {onkeydown}
                class={[
                    "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors pointer-coarse:min-h-11",
                    active === tab.id
                        ? "bg-gray-100 text-gray-950 dark:bg-white/10 dark:text-gray-100"
                        : "text-gray-600 hover:text-gray-950 dark:text-gray-400 dark:hover:text-gray-100",
                ]}>{tab.label}</button
            >
        {/each}
    </div>
{/if}
<div
    id="{uid}-panel-{MCP}"
    role={tabs.length > 1 ? "tabpanel" : undefined}
    aria-labelledby={tabs.length > 1 ? `${uid}-tab-${MCP}` : undefined}
    hidden={active !== MCP}
>
    {@render mcp()}
</div>
{#each extensions as extension (extension.id)}
    <div id="{uid}-panel-{extension.id}" role="tabpanel" aria-labelledby="{uid}-tab-{extension.id}" hidden={active !== extension.id}>
        <ExtensionSettingsSections tab="agents" {host} extensionId={extension.id} />
    </div>
{/each}
