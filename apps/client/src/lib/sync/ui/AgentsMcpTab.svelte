<script lang="ts">
    /**
     * The MCP Server part of the Agents tab: how an agent outside EtherPK reaches one graph (ADR
     * 0070, ADR 0072). A graph's Settings shows it for the open graph, and the Graphs page's Agents
     * tab shows it for the graph chosen in its picker (ADR 0147), so the two never say different
     * things. What it is about comes in `agents` (agents-tab.ts):
     *
     * - a synced graph: the numbered steps, with this graph's id in the registration;
     * - a folder on disk: its AGENTS.md, and the optional MCP server over the folder;
     * - a graph kept in the browser: why no agent can reach it;
     * - on the Graphs page only, a synced graph whose commands would not work yet (its keys are
     *   locked here, or its server is signed out), with the reason and the step that changes it;
     * - on the Graphs page only, no graph at all: logging an agent in, and the Agent Skill.
     *
     * Nothing here is a setting. The one secret is the Agent Setup Code, which lives in
     * `HeadlessClientSignIn` and nowhere else.
     */
    import type { Snippet } from "svelte";

    import { iconSvg } from "#lib/surface/icons.js";

    import AgentCommandRow from "./AgentCommandRow.svelte";
    import {
        AGENT_SKILL_ROW,
        AGENT_TOOLS,
        type AgentsBlocked,
        type AgentsReachableProps,
        type AgentsTabProps,
        type AgentTool,
        diagramsSetupCommand,
        publishCommand,
        registerCommand,
        registerFolderCommand,
        registerNote,
        semanticSetupCommand,
        tokensPageUrl,
    } from "./agents-tab";
    import HeadlessClientSignIn from "./HeadlessClientSignIn.svelte";

    const {
        agents,
        inGraph = true,
        picker,
    }: {
        agents: AgentsTabProps;
        /**
         * Shown inside the open graph's Settings, where the General tab is beside this one. False
         * on the Graphs page, which says to open the graph first.
         */
        inGraph?: boolean;
        /** The Graphs page's graph picker, drawn under the heading. */
        picker?: Snippet;
    } = $props();

    /** Which agent the register command is spelled for; the serve command is the same for all. */
    let agentTool = $state<AgentTool>("claude");
    let copied = $state(false);
    /** A failed copy, said beside the command it was for. */
    let copyError = $state<string | null>(null);

    async function copyRegistration(text: string) {
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

    const LINK = "underline decoration-neutral-400 underline-offset-2 hover:decoration-neutral-950 dark:hover:decoration-neutral-100";
    const GUIDE_URL = "https://docs.etherpk.com/using-ai-agents-with-your-notes";
</script>

<!-- The heading over the MCP Server sub-tab, which also stands alone when no extension adds a sub-tab. -->
{#snippet heading()}
    <h3 class="flex items-center gap-2 text-base font-semibold text-neutral-950 dark:text-neutral-100">
        <span class="text-neutral-600 dark:text-neutral-400">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- the Client's own icon markup (icons.ts) -->
            {@html iconSvg("headless-client", { size: 20 })}
        </span>MCP Server
    </h3>
    {@render picker?.()}
{/snippet}

<!-- What the MCP server is for. `subject`: this graph, or the person's notes where no graph is chosen. -->
{#snippet intro(subject: string)}
    <p class="text-sm text-neutral-600 dark:text-neutral-400">
        Use to allow an AI agent on your device, such as Claude Code, Codex or VS Code, to read and modify {subject}. The agent connects to the MCP server that
        the EtherPK Headless Client runs.
    </p>
{/snippet}

<!-- Which agent the registration is spelled for. -->
{#snippet toolSelect()}
    <label class="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
        for
        <select
            bind:value={agentTool}
            class="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-neutral-950 dark:text-neutral-100"
            data-testid="agents-tool"
        >
            {#each AGENT_TOOLS as toolOption (toolOption.id)}
                <option value={toolOption.id}>{toolOption.label}</option>
            {/each}
        </select>
    </label>
{/snippet}

<!-- The registration for the chosen agent, with its copy button and where it goes. -->
{#snippet registration(text: string, commandTestId: string, copyTestId: string)}
    <div class="flex items-start gap-2">
        <pre
            class="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md border border-neutral-900/10 dark:border-neutral-100/15 bg-neutral-50 dark:bg-white/5 p-3 font-mono text-sm"
            data-testid={commandTestId}>{text}</pre>
        <button
            type="button"
            onclick={() => copyRegistration(text)}
            class="shrink-0 rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-950 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            data-testid={copyTestId}>{copied ? "Copied" : "Copy"}</button
        >
    </div>
    <p class="text-sm text-neutral-600 dark:text-neutral-400" data-testid="agents-register-note">{registerNote(agentTool)}</p>
    {#if copyError}
        <p role="status" class="text-sm text-red-700 dark:text-red-400">{copyError}</p>
    {/if}
{/snippet}

<!-- What an agent can do without, on the agent's machine: the once-per-device setups and the
     publish command, which an agent's tools name in a refusal, spelled here so a person can copy
     them. The Agent Skill needs nothing from a graph, so it stays when the rest does not apply:
     pass null for those. The Optional Steps heading says what these are, so they carry no step
     number. -->
{#snippet optional(props: AgentsReachableProps | null)}
    {@const publish = props ? publishCommand(props) : null}
    {@const rows = [
        ...(props
            ? [
                  { key: "semantic", label: "Search by meaning", text: semanticSetupCommand(props.headlessClient), note: "Installs the embedding model, once per device. The agent's search then gains mode: semantic." },
                  { key: "diagrams", label: "Publish diagrams", text: diagramsSetupCommand(props.headlessClient), note: "Installs the browser a publish draws Mermaid diagrams with. A publish with diagrams refuses until this has run." },
              ]
            : []),
        AGENT_SKILL_ROW,
        ...(publish ? [{ key: "publish", label: "Publish from the agent's machine", text: publish, note: "Publishes once and remembers the folder. The agent's publish tool then writes there and cannot choose another folder." }] : []),
    ]}
    <div class="space-y-3 border-t border-neutral-900/10 dark:border-neutral-100/15 pt-4" data-testid="agents-optional">
        <!-- As large as the MCP Server heading, so the tab reads as two parts: what an agent needs,
             and what it can do without. -->
        <h3 class="text-base font-semibold text-neutral-950 dark:text-neutral-100">Optional Steps</h3>
        <ul class="space-y-3">
            {#each rows as row (row.key)}
                <li class="space-y-1"><AgentCommandRow key={row.key} label={row.label} text={row.text} note={row.note} /></li>
            {/each}
        </ul>
    </div>
{/snippet}

<!-- Why there are no commands, and the one step that changes it. -->
{#snippet blockedStep(blocked: AgentsBlocked)}
    <div class="space-y-3 rounded-xl border border-neutral-900/15 bg-white p-4 dark:border-neutral-100/20 dark:bg-white/5" data-testid="agents-blocked">
        <p class="text-sm text-neutral-950 dark:text-neutral-100" data-testid="agents-blocked-reason">{blocked.reason}</p>
        {#if blocked.step}
            <button
                type="button"
                onclick={blocked.step.run}
                class="inline-flex items-center justify-center rounded-lg bg-neutral-950 dark:bg-white px-4 py-2 text-sm font-medium text-white dark:text-neutral-950 hover:bg-neutral-800 dark:hover:bg-neutral-200 pointer-coarse:min-h-11"
                data-testid="agents-blocked-step">{blocked.step.label}</button
            >
        {/if}
    </div>
{/snippet}

{#if agents.kind === "browser"}
    <!-- An agent instruction copied from this graph sends the person here, so this says
         what to do instead rather than showing commands that cannot work. -->
    <div class="space-y-4" data-testid="agents-tab-browser">
        {@render heading()}
        <p class="text-sm text-neutral-600 dark:text-neutral-400">
            Use to allow an AI agent on your device to read and modify a graph. This graph is kept inside this browser, so an agent cannot reach it.
        </p>
        <p class="text-sm text-neutral-950 dark:text-neutral-100">
            To work with an agent, open a local graph, which is a folder of plain files an agent can open like any other project, or a synced graph, which an
            agent reaches through the EtherPK Headless Client. You can do either from the
            <a href="/graphs" class={LINK}>Graphs page</a>.
        </p>
        {@render optional(null)}
    </div>
{:else if agents.kind === "local"}
    <!-- The folder is the integration, so nothing has to be connected. The MCP server is
         the one extra, and comes before what the folder's AGENTS.md covers. -->
    <div class="space-y-4" data-testid="agents-tab-local">
        {@render heading()}
        {@render intro("this graph")}
        <p class="text-sm text-neutral-600 dark:text-neutral-400">
            The MCP server is optional on a local graph. The graph is a folder, so the agent can open its files like any other project, and the MCP server adds
            search, backlinks and task tools. The MCP can see a count of protected documents, but no names or text.
        </p>
        <p class="text-sm text-neutral-950 dark:text-neutral-100">
            To hand the agent a task or a Kanban lane, use
            <span class="font-medium">Copy agent instruction</span>
            on it and paste the text into the agent's chat.
        </p>
        {#if agents.folderPath}
            <!-- The same Headless Client that serves a synced graph serves a folder, with no
                 sign-in: search, backlinks, tasks and format-safe edits over the files, alongside
                 the files themselves. A person reads this, never an agent; AGENTS.md stays about
                 the file format on purpose. -->
            <div class="space-y-1 border-t border-neutral-900/10 dark:border-neutral-100/15 pt-4">
                <div class="flex flex-wrap items-center gap-2">
                    <span class="text-sm font-medium text-neutral-950 dark:text-neutral-100">Optional: add the MCP server</span>
                    {@render toolSelect()}
                </div>
                <p class="text-sm text-neutral-600 dark:text-neutral-400">
                    It needs no sign-in. It keeps an index of the notes, so the agent can search them, follow links and list tasks, and its edits keep the format.
                    Edits the agent makes to the files directly still show up.
                </p>
                {@render registration(
                    registerFolderCommand(agentTool, agents.folderPath, agents.headlessClient, agents.folderName),
                    "agents-register-folder-command",
                    "agents-copy-register-folder",
                )}
            </div>
        {:else}
            <p class="text-sm text-neutral-600 dark:text-neutral-400" data-testid="agents-local-no-path">
                To hand an agent a full path, or to serve the folder to an agent over MCP with search, backlinks and tasks,
                {inGraph ? "set" : "open this graph and set"}
                <span class="font-medium">Folder path on this device</span>
                on the General tab{inGraph ? "" : " of its Settings"}, or use
                <span class="font-medium">Copy full file path</span>
                on a document's tab.
            </p>
        {/if}
        <p class="text-sm text-neutral-950 dark:text-neutral-100">
            EtherPK keeps an <code class="font-mono">AGENTS.md</code>
            at the top of the folder (<code class="font-mono" data-testid="agents-local-folder">{agents.folderName}</code>), beside
            <code class="font-mono">journals/</code>,
            <code class="font-mono">pages/</code> and
            <code class="font-mono">assets/</code>. Agents read a file of that name before they touch anything, and this one tells them how the notes are
            written (bullets and indenting, <code class="font-mono">[[links]]</code>, tasks and their tags, images and files) and what to leave alone: the
            scrambled body of a protected document and the <code class="font-mono">etherpk/</code> folder. A <code class="font-mono">CLAUDE.md</code> beside
            it just points Claude Code at the same file.
        </p>
        <p class="text-sm text-neutral-950 dark:text-neutral-100">
            Both files are yours to add to. Anything you write outside the part between the
            <code class="font-mono">&lt;!-- BEGIN ETHERPK --&gt;</code>
            and <code class="font-mono">&lt;!-- END ETHERPK --&gt;</code>
            lines is kept. EtherPK rewrites that part each time the graph opens, so it always matches this version.
        </p>
        {#if agents.folderPath}
            <p class="text-sm text-neutral-600 dark:text-neutral-400">
                Path on this device:
                <code class="font-mono" data-testid="agents-local-path">{agents.folderPath}/AGENTS.md</code>
            </p>
        {/if}
        {@render optional(agents.folderPath ? agents : null)}
        <p class="text-sm text-neutral-600 dark:text-neutral-400">
            <a href={GUIDE_URL} target="_blank" rel="noreferrer" class={LINK}>Read the guide</a>, including what to do when the notes folder sits inside a
            bigger project.
        </p>
    </div>
{:else if agents.kind === "synced"}
    <div class="space-y-4" data-testid="agents-tab">
        {@render heading()}
        {@render intro("this graph")}
        <p class="text-sm text-neutral-600 dark:text-neutral-400">
            The Headless Client signs in and acts as one of your devices. Your notes are encrypted before sending to the Sync Server. The MCP can see a count of
            protected documents, but no names or text.
        </p>
        <ol class="space-y-3 text-sm text-neutral-950 dark:text-neutral-100">
            <li class="space-y-2">
                <!-- One sign-in for each server: a code made for one graph's server is not offered for another's. -->
                {#key agents.serverBaseUrl}
                    <HeadlessClientSignIn serverBaseUrl={agents.serverBaseUrl} headlessClient={agents.headlessClient} createSetupCode={agents.createSetupCode} numbered />
                {/key}
            </li>
            <li class="space-y-1">
                <div class="flex flex-wrap items-center gap-2">
                    <span class="font-medium">2. Tell the agent about this graph</span>
                    {@render toolSelect()}
                </div>
                {@render registration(
                    registerCommand(agentTool, agents.graphId, agents.serverBaseUrl, agents.headlessClient, agents.graphName),
                    "agents-register-command",
                    "agents-copy-register",
                )}
            </li>
            <li class="space-y-1" data-testid="agents-hand-task">
                <span class="font-medium">3. Hand the agent a task</span>
                <p class="text-neutral-600 dark:text-neutral-400">
                    Use <span class="font-medium">Copy agent instruction</span>
                    on a task or a Kanban lane, and paste the text into the agent's chat.
                </p>
            </li>
        </ol>
        {@render optional(agents)}
        <p class="text-sm text-neutral-600 dark:text-neutral-400">
            This graph's id is <code class="font-mono" data-testid="agents-graph-id">{agents.graphId}</code>. Each agent's token is listed as "Agent on" its
            device's name on
            <a href={tokensPageUrl(agents.serverBaseUrl)} target="_blank" rel="noreferrer" class={LINK} data-testid="agents-tokens-link"
                >the Sync Server's Access tokens page</a
            >. Revoke it there to cut the agent off.
            <a href={GUIDE_URL} target="_blank" rel="noreferrer" class={LINK}>Read the guide</a>.
        </p>
    </div>
{:else if agents.kind === "blocked"}
    <!-- A synced graph on the Graphs page whose commands would not work yet. -->
    <div class="space-y-4" data-testid="agents-tab-blocked">
        {@render heading()}
        {@render intro("this graph")}
        {@render blockedStep(agents)}
        {@render optional(null)}
        <p class="text-sm text-neutral-600 dark:text-neutral-400">
            <a href={GUIDE_URL} target="_blank" rel="noreferrer" class={LINK}>Read the guide</a>.
        </p>
    </div>
{:else}
    <!-- No graph yet, on the Graphs page: what belongs to the account and not to one graph. -->
    <div class="space-y-4" data-testid="agents-tab-none">
        {@render heading()}
        {@render intro("your notes")}
        {#if agents.signIn}
            <div class="space-y-2 text-sm text-neutral-950 dark:text-neutral-100">
                {#key agents.signIn.serverBaseUrl}
                    <HeadlessClientSignIn
                        serverBaseUrl={agents.signIn.serverBaseUrl}
                        headlessClient={agents.signIn.headlessClient}
                        createSetupCode={agents.signIn.createSetupCode}
                    />
                {/key}
            </div>
        {:else if agents.blocked}
            {@render blockedStep(agents.blocked)}
        {/if}
        <p class="text-sm text-neutral-600 dark:text-neutral-400" data-testid="agents-none-next">
            The steps for a graph show here once you have one.
        </p>
        {@render optional(null)}
        <p class="text-sm text-neutral-600 dark:text-neutral-400">
            <a href={GUIDE_URL} target="_blank" rel="noreferrer" class={LINK}>Read the guide</a>.
        </p>
    </div>
{/if}
