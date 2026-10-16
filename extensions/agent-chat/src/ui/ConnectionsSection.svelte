<script lang="ts">
    /**
     * Agent Chat's section of the Agents settings (ADR 0147, ADR 0134 amended 2026-10-15), drawn on
     * the Graphs page and in a graph's settings: the person's [[Model Connection]]s and whether a new
     * chat starts with web search on. They belong to the person, so they are the same on every graph and
     * device, and members of a shared graph never see them.
     *
     * Adding a connection asks only what its provider needs: a key, or OpenRouter's Connect, or the
     * address of a local server. The key is checked by listing the provider's models, and the model
     * a new chat starts on is picked from that list, or typed as a model ID. Nothing is kept until Save.
     */
    import type { SettingsSectionContext } from "@appsoftwareltd/etherpk-extension-api";
    import { createSubscriber } from "svelte/reactivity";

    import { addressProblem, PROVIDER_ORDER, PROVIDERS, type ProviderId } from "../providers/catalogue";
    import { listModels, type ModelInfo, ProviderError } from "../providers/models";
    import { connectOpenRouter } from "../providers/openrouter-connect";
    import { INSTRUCTION_LIMIT, type ModelConnection, newConnectionId, readSettings, withConnection, withInstruction, withoutConnection, withPrimary, writeSettings } from "../settings/connections";
    import { onEscape } from "./escape";
    import Listbox from "./Listbox.svelte";
    import ModelCombobox, { type ModelGroup } from "./ModelCombobox.svelte";
    import RobotIcon from "./RobotIcon.svelte";

    const { context }: { context: SettingsSectionContext } = $props();

    const changed = $derived(createSubscriber((update) => context.personStorage.subscribe(update)));
    const settings = $derived.by(() => {
        changed();
        return readSettings(context.personStorage);
    });

    /** The connection being added or edited, or null when the form is closed. */
    let form = $state<ModelConnection | null>(null);
    let editing = $state(false);
    let showKey = $state(false);
    let models = $state<ModelInfo[] | null>(null);
    let checking = $state(false);
    let connecting = $state<AbortController | null>(null);
    let errors = $state<{ key?: string; address?: string; model?: string; form?: string }>({});
    let removing = $state<string | null>(null);
    let notice = $state<string | null>(null);
    const fieldId = $props.id();

    const info = $derived(form ? PROVIDERS[form.provider] : null);

    function startAdd() {
        form = { id: newConnectionId(), provider: "anthropic", name: "", apiKey: "", address: "", defaultModel: "" };
        editing = false;
        reset();
    }

    function startEdit(connection: ModelConnection) {
        form = { ...connection };
        editing = true;
        reset();
    }

    function reset() {
        models = null;
        errors = {};
        showKey = false;
        notice = null;
    }

    function chooseProvider(provider: ProviderId) {
        if (!form) return;
        form = { ...form, provider, address: PROVIDERS[provider].defaultAddress ?? "", defaultModel: "" };
        models = null;
        errors = {};
    }

    /** What the form lacks, field by field, before its models can be listed. */
    function problems(connection: ModelConnection): typeof errors {
        const found: typeof errors = {};
        const provider = PROVIDERS[connection.provider];
        if (provider.key === "required" && connection.apiKey.trim() === "") found.key = `Enter your ${provider.label} key${provider.connect ? ", or connect" : ""}.`;
        const address = provider.address === "fixed" ? null : addressProblem(connection.provider, connection.address);
        if (address) found.address = address;
        return found;
    }

    function checkAddress() {
        if (!form || PROVIDERS[form.provider].address === "fixed") return;
        errors = { ...errors, address: addressProblem(form.provider, form.address) ?? undefined };
    }

    /** List the provider's models with the key given, which checks the key at the same time. */
    async function check() {
        if (!form || checking) return;
        const found = problems(form);
        errors = found;
        if (found.key || found.address) return;
        checking = true;
        try {
            models = await listModels({ ...form, apiKey: form.apiKey.trim(), address: form.address.trim() });
            if (models.length === 0) errors = { model: "The provider listed no models a chat can use. Type a model ID below." };
            else if (!form.defaultModel || !models.some((model) => model.id === form!.defaultModel)) form = { ...form, defaultModel: models[0].id };
        } catch (error) {
            errors = { form: error instanceof Error ? error.message : String(error) };
        } finally {
            checking = false;
        }
    }

    async function connect() {
        if (!form || connecting) return;
        const controller = new AbortController();
        connecting = controller;
        errors = {};
        try {
            const key = await connectOpenRouter(context.auth, { signal: controller.signal });
            form = { ...form, apiKey: key };
            await check();
        } catch (error) {
            if (!controller.signal.aborted) errors = { form: error instanceof ProviderError ? error.message : `OpenRouter did not connect: ${error instanceof Error ? error.message : String(error)}` };
        } finally {
            connecting = null;
        }
    }

    function save() {
        if (!form) return;
        const found = problems(form);
        if (!form.defaultModel.trim()) found.model = "Choose the model a new chat starts on, or type its model ID.";
        errors = found;
        if (Object.keys(found).length > 0) {
            // The first field that needs something takes the keyboard.
            const first = found.key ? "key" : found.address ? "address" : "model";
            document.getElementById(`${fieldId}-${first}`)?.focus();
            return;
        }
        const connection: ModelConnection = { ...form, name: form.name.trim() || PROVIDERS[form.provider].label, apiKey: form.apiKey.trim(), address: form.address.trim(), defaultModel: form.defaultModel.trim() };
        writeSettings(context.personStorage, withConnection(settings, connection));
        notice = `${connection.name} ${editing ? "updated" : "added"}.`;
        form = null;
    }

    function remove(id: string) {
        const name = settings.connections.find((connection) => connection.id === id)?.name ?? "The connection";
        writeSettings(context.personStorage, withoutConnection(settings, id));
        removing = null;
        notice = `${name} removed.`;
    }

    function makePrimary(id: string) {
        writeSettings(context.personStorage, withPrimary(settings, id));
        notice = `${settings.connections.find((connection) => connection.id === id)?.name ?? "The connection"} is now primary.`;
    }

    function setWebSearch(event: Event) {
        writeSettings(context.personStorage, { ...settings, webSearchByDefault: (event.currentTarget as HTMLInputElement).checked });
    }

    /** Kept as it is typed: the person's settings write at once on the device and sync a moment later. */
    function setInstruction(event: Event) {
        writeSettings(context.personStorage, withInstruction(settings, (event.currentTarget as HTMLTextAreaElement).value));
    }

    const providerOptions = PROVIDER_ORDER.map((id) => ({ value: id, label: PROVIDERS[id].label }));
    /** The listed models as the picker shows them: one group, with no heading. */
    const modelGroups = $derived<ModelGroup[]>([
        { key: "models", label: null, status: "ready", models: (models ?? []).map((model) => ({ key: model.id, label: model.label, id: model.id, note: model.images ? undefined : "text only" })) },
    ]);

    const button = "rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 aria-disabled:cursor-progress";
    const primary = "rounded-lg bg-gray-900 dark:bg-gray-100 px-3 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 aria-disabled:cursor-progress";
    const input = "w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm text-gray-950 dark:text-gray-100";
    const label = "block text-sm font-medium text-gray-950 dark:text-gray-100";
    const help = "text-sm text-gray-600 dark:text-gray-400";
    const fieldError = "text-sm text-red-700 dark:text-red-400";
</script>

<section class="space-y-4" aria-labelledby={`${fieldId}-heading`} data-testid="agent-chat-settings">
    <div class="space-y-2">
        <h3 id={`${fieldId}-heading`} class="flex items-center gap-2 text-base font-semibold text-gray-950 dark:text-gray-100"><RobotIcon class="size-5 text-gray-600 dark:text-gray-400" />Agent Chat</h3>
        <p class={help}>
            Ask a language model about your notes from inside EtherPK: type <kbd class="font-mono">/Agent</kbd> in a document. It can only read, and only what you allow in each chat.
            Chats stay on the device you had them on, and nothing goes into a document unless you save it there.
        </p>
        <p class={help}>
            The model is called from this browser with your own key: EtherPK's servers are not in the path. These connections are yours on every graph and device, and members of a shared
            graph don't see them. Set a spending limit on each key at your provider. Agents you sign in with the Headless Client cannot read these keys.
        </p>
    </div>

    {#if notice}<p class="text-sm text-gray-950 dark:text-gray-100" role="status" data-testid="agent-chat-settings-notice">{notice}</p>{/if}

    {#if settings.connections.length > 0}
        <ul class="divide-y divide-gray-200 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-800" data-testid="agent-chat-connections">
            {#each settings.connections as connection (connection.id)}
                {@const isDefault = (settings.defaultConnection ?? settings.connections[0]?.id) === connection.id}
                <li class="flex flex-wrap items-center gap-2 px-3 py-2" data-testid="agent-chat-connection">
                    <div class="min-w-0 flex-1">
                        <p class="text-sm font-medium text-gray-950 dark:text-gray-100">{connection.name}{isDefault && settings.connections.length > 1 ? " (primary)" : ""}</p>
                        <p class={help}>{PROVIDERS[connection.provider].label}, starts on {connection.defaultModel}</p>
                    </div>
                    {#if removing === connection.id}
                        <span class="text-sm text-gray-950 dark:text-gray-100">Remove {connection.name}? Chats that used it keep their answers.</span>
                        <button type="button" class={button} onclick={() => remove(connection.id)} data-testid="agent-chat-connection-remove-confirm">Remove</button>
                        <button type="button" class={button} onclick={() => (removing = null)}>Cancel</button>
                    {:else}
                        {#if !isDefault}<button type="button" class={button} onclick={() => makePrimary(connection.id)} data-testid="agent-chat-connection-primary">Make primary</button>{/if}
                        <button type="button" class={button} onclick={() => startEdit(connection)} data-testid="agent-chat-connection-edit">Edit</button>
                        <button type="button" class={button} onclick={() => (removing = connection.id)} data-testid="agent-chat-connection-remove">Remove</button>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}

    {#if form && info}
        <div class="space-y-3 rounded-lg border border-gray-200 dark:border-gray-800 p-3" role="group" aria-label={editing ? "Edit the model connection" : "Add a model connection"} data-testid="agent-chat-connection-form" {@attach onEscape(() => (form = null))}>
            <div class="space-y-1">
                <span class={label} id={`${fieldId}-provider`}>Provider</span>
                <Listbox options={providerOptions} value={form.provider} onChange={chooseProvider} labelledBy={`${fieldId}-provider`} disabled={editing} testid="agent-chat-provider" />
                {#if editing}<p class={help}>A connection keeps its provider. To use another, add a new connection.</p>{/if}
            </div>
            <div class="space-y-1">
                <label class={label} for={`${fieldId}-name`}>Name <span class="font-normal text-gray-600 dark:text-gray-400">(optional)</span></label>
                <input id={`${fieldId}-name`} class={input} bind:value={form.name} placeholder={info.label} autocomplete="off" />
            </div>
            {#if info.address !== "fixed"}
                <div class="space-y-1">
                    <label class={label} for={`${fieldId}-address`}>Server address</label>
                    <input
                        id={`${fieldId}-address`}
                        class={input}
                        bind:value={form.address}
                        onblur={checkAddress}
                        oninput={() => errors.address && checkAddress()}
                        aria-invalid={!!errors.address}
                        aria-describedby={`${fieldId}-address-help`}
                        autocomplete="off"
                        spellcheck="false"
                        data-testid="agent-chat-address"
                    />
                    <p id={`${fieldId}-address-help`} class={errors.address ? fieldError : help}>
                        {errors.address ??
                            (form.provider === "local"
                                ? "Ollama listens at http://localhost:11434/v1 and LM Studio at http://localhost:1234/v1. The server must allow requests from this page: for Ollama, set OLLAMA_ORIGINS to this page's address, and for LM Studio, switch on CORS. Your browser may ask whether this page may reach your computer's network."
                                : "The address of the server's OpenAI-compatible API, ending in /v1 for most servers.")}
                    </p>
                </div>
            {/if}
            <div class="space-y-1">
                <label class={label} for={`${fieldId}-key`}>Key {info.key === "optional" ? "(if the server needs one)" : ""}</label>
                <div class="flex gap-2">
                    <input
                        id={`${fieldId}-key`}
                        class={input}
                        type={showKey ? "text" : "password"}
                        bind:value={form.apiKey}
                        oninput={() => errors.key && (errors = { ...errors, key: undefined })}
                        placeholder={info.keyPlaceholder ?? ""}
                        aria-invalid={!!errors.key}
                        aria-describedby={`${fieldId}-key-help`}
                        autocomplete="off"
                        spellcheck="false"
                        data-testid="agent-chat-key"
                    />
                    <button type="button" class={button} onclick={() => (showKey = !showKey)} aria-pressed={showKey}>{showKey ? "Hide" : "Show"}</button>
                </div>
                <p id={`${fieldId}-key-help`} class={errors.key ? fieldError : help}>
                    {#if errors.key}{errors.key}{:else if info.keyUrl}Get a key at <a class="underline underline-offset-2" href={info.keyUrl} target="_blank" rel="noreferrer">{new URL(info.keyUrl).host}</a>.{/if}
                </p>
                {#if info.connect === "openrouter"}
                    <div class="flex flex-wrap items-center gap-2">
                        <button type="button" class={button} onclick={connect} aria-disabled={!!connecting} aria-busy={!!connecting} data-testid="agent-chat-connect-openrouter">
                            {connecting ? "Waiting for OpenRouter…" : "Connect with OpenRouter"}
                        </button>
                        {#if connecting}<button type="button" class={button} onclick={() => connecting?.abort()}>Cancel</button>{/if}
                        <span class={help}>Opens OpenRouter to make a key for EtherPK, which you can limit and revoke there.</span>
                    </div>
                {/if}
            </div>
            <div class="space-y-1">
                <div class="flex flex-wrap items-center gap-2">
                    <button type="button" class={button} onclick={check} aria-disabled={checking} aria-busy={checking} data-testid="agent-chat-check">{checking ? "Checking…" : models ? "Check again" : "Check and list models"}</button>
                    {#if models}<span class={help} role="status">{models.length} {models.length === 1 ? "model" : "models"} found.</span>{/if}
                </div>
                {#if errors.form}<p class={fieldError} role="alert" data-testid="agent-chat-connection-error">{errors.form}</p>{/if}
            </div>
            <div class="space-y-1">
                <label class={label} for={`${fieldId}-model`}>Model a new chat starts on</label>
                <ModelCombobox
                    id={`${fieldId}-model`}
                    groups={modelGroups}
                    value={form.defaultModel}
                    onChange={(key) => {
                        if (form) form = { ...form, defaultModel: key };
                        if (errors.model) errors = { ...errors, model: undefined };
                    }}
                    invalid={!!errors.model}
                    describedBy={`${fieldId}-model-help`}
                    placeholder="Choose or type a model ID"
                    allowCustom
                    testid="agent-chat-default-model"
                />
                <p id={`${fieldId}-model-help`} class={errors.model ? fieldError : help}>{errors.model ?? "Check and list models or add a model ID."}</p>
            </div>
            <div class="flex gap-2">
                <button type="button" class={primary} onclick={save} data-testid="agent-chat-connection-save">{editing ? "Save changes" : "Add connection"}</button>
                <button type="button" class={button} onclick={() => (form = null)}>Cancel</button>
            </div>
        </div>
    {:else}
        <button type="button" class={button} onclick={startAdd} data-testid="agent-chat-add-connection">Add a model connection</button>
    {/if}

    <div class="space-y-1">
        <label class="flex items-start gap-2 text-sm text-gray-950 dark:text-gray-100">
            <input type="checkbox" class="mt-0.5 accent-(--gk-accent)" checked={settings.webSearchByDefault} onchange={setWebSearch} data-testid="agent-chat-web-search-default" />
            <span>
                <span class="font-medium">Search the web by default</span><br />
                <span class={help}>
                    New chats start with Search the web on. Each chat can switch it on or off for itself. Anthropic, OpenAI and OpenRouter run the search while they answer, and
                    charge for it. The words searched for go to the provider's search, and text in a note the model reads can steer what it searches for.
                </span>
            </span>
        </label>
    </div>

    <div class="space-y-1">
        <label class={label} for={`${fieldId}-instruction`}>Agent instruction</label>
        <textarea
            id={`${fieldId}-instruction`}
            class="{input} min-h-24 resize-y"
            rows="4"
            maxlength={INSTRUCTION_LIMIT}
            value={settings.instruction}
            oninput={setInstruction}
            placeholder="Add instruction that will be sent to all agents along with other context in all sessions."
            aria-describedby={`${fieldId}-instruction-help`}
            data-testid="agent-chat-instruction"
        ></textarea>
        <p id={`${fieldId}-instruction-help`} class={help}>Sent to every model in every chat, before your notes. Kept as you type.</p>
    </div>
</section>
