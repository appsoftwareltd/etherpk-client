<script lang="ts">
    import { page } from "$app/state";
    import type { Snippet } from "svelte";
    import {
        CLIENT_REPOSITORY_URL,
        COMMUNITY_DISCORD_URL,
        PUBLIC_BLOG_URL,
    } from "../deployment-navigation";
    import TypedWord from "./TypedWord.svelte";

    /**
     * The public landing page, served by Corporate (www) and by the Client (app) so the two
     * never drift. Only the destinations differ, which is why they are props: a standalone
     * Client has no Corporate, so pricing is simply absent there, and the button row shrinks
     * to what is offered rather than leaving a gap. `belowHero` is the one place an app adds
     * content of its own.
     *
     * `canonicalUrl` is Corporate's copy of this page: Corporate names its own, a managed
     * Client names Corporate's so search engines index one copy, and a standalone Client has
     * none to name. Images are served by whichever origin rendered the page, so every app ships
     * `static/marketing/` (the corporate e2e suite checks both), and Open Graph needs the
     * absolute URL.
     *
     * `managed` is false on a self-hosted Client, which runs beside a team's own Sync Server
     * rather than EtherPK's: the page then offers that server instead of Sync+, which such an
     * install cannot sell, and asks search engines not to index a copy with no canonical page.
     *
     * `supportEmail` is the managed service's support address, given at the foot of the page. A
     * self-hosted Client passes none, because the people who run it support its users, not
     * EtherPK. The Client's repository, the blog and the Discord community are the same for every
     * copy, so they are constants rather than props.
     *
     * The feature copy is a condensed reading of the user docs' own feature list, and every
     * group links to the page it summarises so a claim can be checked. Nothing here should say
     * more than the docs do.
     */
    let {
        appHref = "/graphs",
        demoHref = null,
        pricingHref = "/pricing",
        docsHref = "https://docs.etherpk.com",
        canonicalUrl = null,
        managed = true,
        syncServerHref = null,
        supportEmail = null,
        belowHero,
    }: {
        appHref?: string;
        demoHref?: string | null;
        pricingHref?: string | null;
        docsHref?: string;
        canonicalUrl?: string | null;
        /** Whether EtherPK's Managed Sync (Sync+) is on offer; false on a self-hosted Client. */
        managed?: boolean;
        /** The team's Sync Server, which a self-hosted page offers in place of Sync+. */
        syncServerHref?: string | null;
        /** Where to write for support, given at the foot of the page. None on a self-hosted Client. */
        supportEmail?: string | null;
        /** A section of the app's own, shown between the hero and the features. */
        belowHero?: Snippet;
    } = $props();

    const socialImageUrl = $derived(
        new URL("/marketing/social-card.png", page.url.origin).href,
    );

    // The screenshot's own pixel size, declared on the element so the page reserves the space
    // before the bytes arrive rather than jumping when they do.
    const SCREENSHOT = {
        src: "/marketing/graph-view-dark.webp",
        width: 2317,
        height: 1309,
    };

    type Action = {
        id: string;
        label: string;
        href: string;
        icon: "app" | "demo" | "pricing";
    };

    // One row, equal weight, in the order a first visit reads them: use it, look at it, price it.
    const actions = $derived<Action[]>([
        { id: "app", label: "Open the app", href: appHref, icon: "app" },
        ...(demoHref
            ? [
                  {
                      id: "demo",
                      label: "Try the demo",
                      href: demoHref,
                      icon: "demo" as const,
                  },
              ]
            : []),
        ...(pricingHref
            ? [
                  {
                      id: "pricing",
                      label: "See pricing",
                      href: pricingHref,
                      icon: "pricing" as const,
                  },
              ]
            : []),
    ]);

    /** The synced choice beside a folder graph: Sync+, or a self-hosted Client's own server. */
    const syncOption = $derived(managed ? "Sync+" : "your Sync Server");

    // The headline's last word, typed over by each of the others in turn and then restored. Each
    // must fit on one line of the headline on a phone.
    const headlineWords = [
        "Everything",
        "Notes",
        "Journalling",
        "Docs",
        "Blogging",
        "Your Agents",
        "Desktop",
        "Mobile",
        "Tasks",
        "Kanban Boards",
    ];

    /** Where EtherPK runs and how it keeps notes, as short labels beneath the hero's tagline. */
    const highlights = [
        "Markdown + [[Wikilinks]]",
        "Mobile and Desktop",
        "All Platforms",
        "Local + Sync",
        "E2E Encryption",
    ];

    /** What EtherPK offers, as one run of text separated by bullets beneath the hero's labels. */
    const offers = $derived([
        "Long-form prose and outliner features in the same documents",
        "Robust wikilinking and aliasing",
        `Plain local markdown files, or ${syncOption} with export`,
        "Task management and Kanban boards",
        "Real-time collaboration",
        "Quick Notes, with sharing from other apps",
        "End-to-end encryption",
        "Static site publishing",
        "AI agent integration",
        "Source-available Client",
    ]);

    type FeatureGroup = {
        id: string;
        label: string;
        heading: string;
        intro: string;
        items: { lead: string; text: string }[];
        docs: { title: string; slug: string }[];
    };

    // Each entry restates a bullet from the docs' "Features" list in fewer words. Backticks mark
    // code, rendered by the `inline` snippet below; keep them balanced.
    const allFeatureGroups: FeatureGroup[] = [
        {
            id: "writing",
            label: "Writing",
            heading:
                "An outliner over plain markdown, not a database with an export",
            intro: "Structure is read from the indentation and headings in the file, so what you see is what is on disk, and the file opens unchanged in any other editor.",
            items: [
                {
                    lead: "A journal entry a day",
                    text: ", one file per day, and pages for the things that outlive a day.",
                },
                {
                    lead: "Wikilinks that nest",
                    text: ": `[[[[Physics]] Quantum Mechanics]]` names a topic within a topic and is a page in its own right.",
                },
                {
                    lead: "Aliases",
                    text: ", so a page answers to more than one name - names are case-insensitive, so `[[physics]]` and `[[Physics]]` are one page.",
                },
                {
                    lead: "Backlinks on every page",
                    text: ", grouped by the heading and bullet the link sits under, with the linking line shown in place.",
                },
                {
                    lead: "Drafts",
                    text: ": follow a link to a page that does not exist and you get an editable surface. Nothing is written until the first keystroke.",
                },
                {
                    lead: "Rename",
                    text: " rewrites every link, or keeps the old name as an alias. Renaming onto an existing name merges the two.",
                },
                {
                    lead: "Outliner keys",
                    text: " to indent, outdent, move and fold blocks and select whole branches.",
                },
                {
                    lead: "Formatting",
                    text: " by keyboard or by wrapping a selection, tables with editing commands, `==highlight==`, dates by picker.",
                },
                {
                    lead: "Code blocks",
                    text: " with live syntax highlighting, in place rather than swapped for a preview.",
                },
                {
                    lead: "Mermaid diagrams and KaTeX maths",
                    text: ", inline and display, rendered over the source without changing it.",
                },
                {
                    lead: "Frontmatter as real text",
                    text: ": title, aliases, publishing keys and your own keys.",
                },
            ],
            docs: [
                { title: "Formatting Text", slug: "formatting-text" },
                {
                    title: "Titles, Aliases and Frontmatter",
                    slug: "titles-aliases-and-frontmatter",
                },
                {
                    title: "Code, Maths and Diagrams",
                    slug: "code-maths-and-diagrams",
                },
                { title: "Tables", slug: "tables" },
            ],
        },
        {
            id: "files",
            label: "Files and images",
            heading: "Paste it in - the bytes are stored once",
            intro: "Images and files are stored beside the markdown as ordinary files, referenced from the text like any other link.",
            items: [
                {
                    lead: "Images and files",
                    text: " by paste, drag and drop or a slash command, embedded inline with a display-size hint.",
                },
                {
                    lead: "Identical bytes stored once",
                    text: ", however often they are added.",
                },
                {
                    lead: "WebP conversion on upload",
                    text: " when it saves at least a tenth, with a per-upload opt-out.",
                },
                {
                    lead: "Links to files on your computer",
                    text: ", with the path copied on click.",
                },
                {
                    lead: "Orphaned-asset scan",
                    text: " to find and delete files nothing refers to any more.",
                },
            ],
            docs: [
                { title: "Images and Files", slug: "images-and-files" },
                {
                    title: "Links to Websites and Files",
                    slug: "links-to-websites-and-files",
                },
            ],
        },
        {
            id: "tasks",
            label: "Tasks and quick notes",
            heading: "Tasks stay in the note that gave rise to them",
            intro: "A task is a markdown checkbox where you wrote it. The Tasks view collects them across the graph and ticks one off in the document that contains it.",
            items: [
                {
                    lead: "Ordinary checkboxes",
                    text: ", with priority, due, scheduled, waiting, doing and done carried as tags in the text.",
                },
                {
                    lead: "A Tasks view across the whole graph",
                    text: ", filtered by concept and state.",
                },
                {
                    lead: "Quick notes",
                    text: ": a scratch list in the sidebar for the thought you do not want to lose, filed into the journal under the day it was written.",
                },
            ],
            docs: [
                { title: "Tasks", slug: "tasks" },
                { title: "Quick Notes", slug: "quick-notes" },
            ],
        },
        {
            id: "finding",
            label: "Finding things",
            heading: "By name, by text, by what links where",
            intro: "The sidebar is a short list of ways back in, and each view remembers its reading position.",
            items: [
                {
                    lead: "Quick find by name",
                    text: " (a typo offers a new page instead) and search by text across the graph.",
                },
                {
                    lead: "All documents",
                    text: " to browse, favourites shared with everyone in the graph, recents per device.",
                },
                {
                    lead: "Back and Forward",
                    text: " through the documents you visited, each reopening where you left it.",
                },
                {
                    lead: "Today's journal and a calendar",
                    text: " of the days that have an entry.",
                },
            ],
            docs: [
                { title: "The Graph Sidebar", slug: "the-graph-sidebar" },
                { title: "Search", slug: "search" },
            ],
        },
        {
            id: "workspace",
            label: "Workspace",
            heading: "Lay the screen out once per graph, per device",
            intro: "A desktop gets tabs and panes - a phone gets a presenter with a command bar above the keyboard. Both are the same editor over the same files.",
            items: [
                {
                    lead: "Tabs and panes",
                    text: ": split, resize, dock, float and pin. Sidebars collapse rather than close.",
                },
                {
                    lead: "A layout per graph and per device",
                    text: ", and a keyboard shortcut per sidebar view.",
                },
                {
                    lead: "Command menu on `/`",
                    text: ", context menus on a right-click or long-press, and a shortcuts card on `Ctrl+/`.",
                },
                {
                    lead: "Dark mode",
                    text: ", a colour per graph on the toolbar, and installable as an app.",
                },
                {
                    lead: "Several graphs",
                    text: " side by side in one picker, local and synced.",
                },
            ],
            docs: [{ title: "Tabs and Panes", slug: "tabs-and-panes" }],
        },
        {
            id: "files-yours",
            label: "Your files",
            heading: "A folder of markdown is a complete graph",
            intro: "Journals, pages, assets and a small settings folder, and nothing else. Back it up, put it in git, edit it with other tools while EtherPK has it open.",
            items: [
                {
                    lead: "Import",
                    text: " from Logseq, Obsidian, another EtherPK graph or AS Notes into a new graph, with a report of anything that could not be carried.",
                },
                {
                    lead: "A local copy of a synced graph",
                    text: ", kept up to date on disk as the same plain files.",
                },
                {
                    lead: "Export",
                    text: " any graph as a folder of markdown, any time.",
                },
                {
                    lead: "A plain statement of what is stored where",
                    text: ", and what ever leaves your device.",
                },
            ],
            docs: [
                { title: "Local Graphs", slug: "local-graphs" },
                { title: "Importing", slug: "importing-a-knowledge-base" },
                {
                    title: "Where Your Data Is Stored",
                    slug: "where-your-data-is-stored",
                },
            ],
        },
        {
            id: "sync",
            label: "Sync and collaboration",
            heading: "Encrypted on your device before anything is sent",
            intro: "The Sync Server stores your content only as ciphertext, filed under ids that carry none of it: not your text, not your titles, not the graph's name, not your images. It enforces limits by counting bytes it cannot read.",
            items: [
                {
                    lead: "Every device, live",
                    text: ": real-time co-editing with collaborators' cursors. Edits made while the connection drops are kept, and merge when you are back in the order you made them.",
                },
                {
                    lead: "Sharing by invitation",
                    text: ", with a short key fingerprint to compare, so you know the key you share with is theirs.",
                },
                {
                    lead: "A Recovery Code",
                    text: " per account, stored nowhere, plus device approval, so a new device is usually let in by an existing one with a short code.",
                },
                {
                    lead: "Phones, tablets, Safari and Firefox",
                    text: " all work with a synced graph.",
                },
            ],
            docs: [
                { title: "Synced Graphs", slug: "synced-graphs" },
                { title: "Managed Sync", slug: "managed-sync" },
            ],
        },
        {
            id: "protection",
            label: "Protection",
            heading:
                "For the pages nobody else should read, even with your files in hand",
            intro: "Sync encryption protects your notes from the service. Protection is the layer for your own machine: a stolen laptop, a shared folder, a graph you export.",
            items: [
                {
                    lead: "Protected documents",
                    text: " are encrypted with a personal key behind a passphrase or a passkey, on folder graphs as well as synced ones.",
                },
                {
                    lead: "Locked again",
                    text: " on a timer, or when you look away.",
                },
                {
                    lead: "Never searched",
                    text: ", never synced in the clear, never published, never shown to an agent.",
                },
                {
                    lead: "No recovery",
                    text: ": forget the passphrase and the contents are gone, by design.",
                },
            ],
            docs: [
                { title: "Protected Documents", slug: "protected-documents" },
            ],
        },
        {
            id: "publishing",
            label: "Publishing",
            heading: "Pick the pages that are public and get a website",
            intro: "The docs site itself is an EtherPK graph published this way.",
            items: [
                {
                    lead: "Publications",
                    text: ": choose the public pages, group them into as many sites as you like, and write the menu as an outline.",
                },
                {
                    lead: "A complete static site",
                    text: " with search, a sitemap, a feed, maths, diagrams and code, into a folder or a zip, seeded for GitHub Pages and Cloudflare.",
                },
                {
                    lead: "Themes",
                    text: " you copy into the graph and edit in a built-in editor with a live preview, with include slots for a footer, analytics or a banner.",
                },
                {
                    lead: "A publish report",
                    text: " that says exactly what was and was not published.",
                },
            ],
            docs: [
                {
                    title: "Publishing Your Notes as a Website",
                    slug: "publishing-your-notes-as-a-website",
                },
                {
                    title: "Hosting a Published Site",
                    slug: "hosting-a-published-site",
                },
                {
                    title: "Theming a Published Site",
                    slug: "theming-a-published-site",
                },
            ],
        },
        {
            id: "agents",
            label: "AI agents",
            heading: "Agents work on the same files you do",
            intro: "There is no separate export for them to read and no format to translate.",
            items: [
                {
                    lead: "On a folder graph",
                    text: ", an agent reads the `AGENTS.md` EtherPK writes into it and works on the files directly.",
                },
                {
                    lead: "On a synced graph",
                    text: ", it goes through the Headless Client: a device of your account that keeps the graph in sync and serves it over MCP.",
                },
                {
                    lead: "Semantic search",
                    text: " by meaning, on top of search by text.",
                },
                {
                    lead: "Protected documents stay closed",
                    text: " to agents, whichever route they take.",
                },
            ],
            docs: [
                {
                    title: "Using AI Agents with Your Notes",
                    slug: "using-ai-agents-with-your-notes",
                },
            ],
        },
        {
            id: "running",
            label: "Running it",
            heading: "Managed sync, or just your own machine",
            intro: "The same Client in each case. What changes is where the graph is stored and who keeps it in sync.",
            items: [
                {
                    lead: "Managed Sync",
                    text: " with an EtherPK Account: sign in once and every managed app follows, with passkeys, two-factor and social sign-in, and a plan page that shows exact limits and usage.",
                },
                {
                    lead: "The Client on your own machine",
                    text: ", as a plain Node bundle or a Docker image, for a folder graph with no server and no account.",
                },
            ],
            docs: [
                { title: "Managed Sync", slug: "managed-sync" },
                {
                    title: "Running EtherPK on Your Own Computer",
                    slug: "running-etherpk-on-your-own-computer",
                },
            ],
        },
    ];

    // What to know before choosing between a folder graph and a synced one. A self-hosted Client's
    // server is run by its team, not by EtherPK, so that copy names the server rather than "we".
    const usageNotes = $derived([
        "Folder graphs need the File System Access API, which today means a Chromium desktop browser (Chrome, Edge, Brave). Phones, Safari and Firefox work with synced graphs.",
        `End-to-end encryption protects your data and privacy. An unlocked device or your Recovery Code is needed to decrypt your synced notes. ${managed ? "We cannot" : "Your Sync Server cannot"} decrypt or recover your notes for you. Keep a copy of your code safe and backed up.`,
    ]);

    /**
     * A self-hosted Client's copy leaves out what only EtherPK's managed service offers: the
     * Managed Sync item and the links to its page.
     */
    const featureGroups = $derived(
        managed
            ? allFeatureGroups
            : allFeatureGroups.map((group) => ({
                  ...group,
                  heading:
                      group.id === "running"
                          ? "Synced through a server, or just your own machine"
                          : group.heading,
                  items: group.items.filter(
                      (item) => item.lead !== "Managed Sync",
                  ),
                  docs: group.docs.filter((doc) => doc.slug !== "managed-sync"),
              })),
    );

    /** Splits text on backticks; the odd-numbered pieces were inside them. */
    function segments(text: string): { code: boolean; text: string }[] {
        return text
            .split("`")
            .map((piece, index) => ({ code: index % 2 === 1, text: piece }));
    }

    const actionClass =
        "inline-flex h-12 w-full items-center justify-center gap-2.5 rounded-xl bg-gray-950 px-6 text-base font-semibold text-white shadow-sm transition-colors hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-950 sm:flex-1 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-100 dark:focus-visible:outline-white";

    // Every text link on the page looks the same. The links beneath the hero add an icon, and
    // share one class list so the repository, the docs, the blog and the Discord community match.
    const textLinkClass =
        "font-medium text-gray-700 underline decoration-gray-400 underline-offset-2 transition-colors hover:text-gray-950 dark:text-gray-300 dark:hover:text-white";
    const iconLinkClass = `inline-flex items-center gap-1.5 ${textLinkClass}`;
</script>

<svelte:head>
    <title>EtherPK - A personal knowledge base in plain markdown</title>
    <meta
        name="description"
        content="EtherPK is a personal knowledge base in plain markdown files you own: a daily journal, wikilinks and backlinks, tasks, an outliner, code, diagrams and maths. Free on your own machine - {managed
            ? 'Sync+ keeps it'
            : 'a Sync Server keeps it'} end-to-end encrypted across your devices, with live collaboration, protected documents, publishing to a static site and access for AI agents. Imports from Logseq, Obsidian and AS Notes."
    />
    {#if canonicalUrl}
        <link rel="canonical" href={canonicalUrl} />
        <meta property="og:url" content={canonicalUrl} />
    {:else}
        <!-- A copy with no canonical page, on a self-hosted Client: one of many, not for search. -->
        <meta name="robots" content="noindex" />
    {/if}
    <meta property="og:site_name" content="EtherPK" />
    <meta property="og:type" content="website" />
    <meta
        property="og:title"
        content="EtherPK - A personal knowledge base in plain markdown"
    />
    <meta
        property="og:description"
        content="A journal a day, pages for what outlives it and wikilinks between them, as plain markdown files you own. Free on your own machine - {managed
            ? 'Sync+ keeps it'
            : 'a Sync Server keeps it'} end-to-end encrypted across your devices."
    />
    <meta property="og:image" content={socialImageUrl} />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta
        property="og:image:alt"
        content="EtherPK: a personal knowledge base in plain markdown, beside a screenshot of the editor"
    />
    <meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<!-- Backticks in copy become code; keeps the data plain strings and the template free of @html. -->
{#snippet inline(text: string)}
    {#each segments(text) as segment, index (index)}
        {#if segment.code}<code
                class="rounded bg-gray-950/6 px-1 py-0.5 font-mono text-gray-800 dark:bg-white/10 dark:text-gray-100"
                >{segment.text}</code
            >{:else}{segment.text}{/if}
    {/each}
{/snippet}

{#snippet actionIcon(kind: Action["icon"])}
    {#if kind === "app"}
        <svg
            class="size-[1.125rem] shrink-0 opacity-70"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2" />
            <path
                d="M2.75 7.25h14.5M6 5.5h.01M8.25 5.5h.01"
                stroke-linecap="round"
            />
        </svg>
    {:else if kind === "demo"}
        <svg
            class="size-[1.125rem] shrink-0 opacity-70"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            <circle cx="10" cy="10" r="7.25" />
            <path
                d="M8.25 7.25v5.5l4.5-2.75-4.5-2.75Z"
                fill="currentColor"
                stroke="none"
            />
        </svg>
    {:else}
        <svg
            class="size-[1.125rem] shrink-0 opacity-70"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            <path
                d="M3.25 3.25h6.2a1.5 1.5 0 0 1 1.06.44l6.05 6.05a1.5 1.5 0 0 1 0 2.12l-4.69 4.69a1.5 1.5 0 0 1-2.12 0L3.69 10.5a1.5 1.5 0 0 1-.44-1.06v-6.2Z"
            />
            <circle
                cx="6.75"
                cy="6.75"
                r="1"
                fill="currentColor"
                stroke="none"
            />
        </svg>
    {/if}
{/snippet}

<!-- The same row opens and closes the page. -->
{#snippet actionRow(testId: string)}
    <div
        data-testid={testId}
        class="mx-auto flex w-full max-w-2xl flex-col gap-3 sm:flex-row"
    >
        {#each actions as action (action.id)}
            <a
                href={action.href}
                class={actionClass}
                data-testid={testId === "marketing-hero-actions" &&
                action.id === "demo"
                    ? "marketing-try-demo"
                    : undefined}
            >
                {@render actionIcon(action.icon)}
                {action.label}
            </a>
        {/each}
    </div>
{/snippet}

<!-- ── Hero ───────────────────────────────────────────────────────── -->
<section aria-labelledby="hero-heading">
    <div class="mx-auto max-w-7xl px-4 pt-16 text-center sm:px-6 sm:pt-24">
        <p
            class="text-sm font-semibold uppercase tracking-[0.2em] text-gray-950 dark:text-white"
        >
            Ether Personal Knowledge
        </p>
        <h1
            id="hero-heading"
            class="mx-auto mt-5 max-w-4xl text-balance text-4xl font-semibold leading-[1.1] tracking-tight text-gray-950 sm:text-6xl dark:text-white"
        >
            One Markdown PKMS For
            <TypedWord words={headlineWords} testId="marketing-headline-word" />
        </h1>
        <p
            class="mx-auto mt-5 max-w-3xl text-balance text-xl font-medium leading-8 text-gray-800 sm:text-2xl sm:leading-9 dark:text-gray-100"
        >
            Journal, Link Thoughts and Ideas, Manage Tasks and Projects,
            Publish, Own Your Data
        </p>
        <ul
            data-testid="marketing-hero-highlights"
            class="mx-auto mt-6 flex max-w-4xl flex-wrap justify-center gap-x-6 gap-y-2"
        >
            {#each highlights as highlight (highlight)}
                <li
                    class="inline-flex items-center gap-1.5 text-sm font-medium leading-6 text-gray-700 dark:text-gray-300"
                >
                    <svg
                        class="size-4 shrink-0 text-gray-950 dark:text-white"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.75"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <path d="m3.5 8.5 3 3 6-7" />
                    </svg>
                    {highlight}
                </li>
            {/each}
        </ul>

        <div class="mt-10">
            {@render actionRow("marketing-hero-actions")}
        </div>
        <p
            data-testid="marketing-hero-note"
            class="mx-auto mt-4 max-w-2xl text-pretty text-sm leading-6 text-gray-500 dark:text-gray-400"
        >
            EtherPK is free to use for folder-based graphs. {#if managed}Use our
                Sync+ service for access to your graphs across devices, or bring
                your own (e.g. Git or Syncthing).{:else}Use your team's Sync
                Server for access to your graphs across devices, or bring your
                own sync (e.g. Git or Syncthing).{/if}
        </p>
    </div>

    <!-- The app as it is, rather than an illustration of it: the demo graph in the whole Graph View. -->
    <figure class="mx-auto mt-14 max-w-6xl px-4 sm:mt-20 sm:px-6">
        <div
            class="overflow-hidden rounded-xl bg-gray-950 shadow-2xl shadow-gray-950/15 ring-1 ring-gray-950/10 sm:rounded-2xl dark:shadow-black/40 dark:ring-white/10"
        >
            <img
                src={SCREENSHOT.src}
                width={SCREENSHOT.width}
                height={SCREENSHOT.height}
                alt="The EtherPK Client in the dark theme, showing the demo graph in the whole Graph View: each page is a dot, each wikilink a line, and each cluster of closely linked pages has its own colour, with place names drawn as rings. Beside it is the list of Hubs, and the Backlinks pane on the right lists everything that mentions the Plant page."
                fetchpriority="high"
                decoding="async"
                class="block h-auto w-full"
            />
        </div>
        <figcaption
            class="mx-auto mt-4 max-w-3xl text-center text-sm leading-6 text-gray-500 dark:text-gray-400"
        >
            The EtherPK demo graph (dark mode).
        </figcaption>
    </figure>

    <!-- What EtherPK offers, then where to read more and talk about it, beneath the screenshot. -->
    <div class="mx-auto max-w-7xl px-4 pt-12 text-center sm:px-6 sm:pt-16">
        <p
            class="mx-auto max-w-3xl text-balance text-xl font-medium leading-8 text-gray-800 sm:text-2xl sm:leading-9 dark:text-gray-100"
        >
            EtherPK is a notes app and <abbr
                class="no-underline"
                title="personal knowledge management system">PKMS</abbr
            > with a lot to offer.
        </p>
        <!-- A list that wraps like a sentence. Each bullet touches the item after it with no space
             either side (the gap is padding), so a line never starts or ends on a bullet. Keep
             the {#if} and {offer} on one line: a line break between them would be a space. -->
        <ul
            data-testid="marketing-hero-offers"
            class="mx-auto mt-4 max-w-5xl text-pretty text-base leading-7 text-gray-600 sm:text-lg sm:leading-8 dark:text-gray-300"
        >
            {#each offers as offer, index (offer)}
                <li class="inline">
                    {#if index > 0}<span
                            class="px-2 text-gray-950 dark:text-white"
                            aria-hidden="true">•</span
                        >{/if}{offer}
                </li>
            {/each}
        </ul>

        <!-- Where the source is, the docs and the blog side by side, then where people talk about
             the app. A full-width item takes a line of its own, so the two in between share one. -->
        <ul
            class="mt-10 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm leading-6"
        >
            <li class="flex w-full justify-center">
                <a href={CLIENT_REPOSITORY_URL} class={iconLinkClass}>
                    <svg
                        class="size-4 shrink-0"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        aria-hidden="true"
                    >
                        <path
                            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
                        />
                    </svg>
                    Source-available EtherPK Client on GitHub
                </a>
            </li>
            <li>
                <a href={docsHref} class={iconLinkClass}>
                    <!-- An open book. -->
                    <svg
                        class="size-4 shrink-0"
                        viewBox="0 0 20 20"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <path
                            d="M10 5.5C8.5 4.25 6.25 3.75 3.25 4v11.25c3-.25 5.25.25 6.75 1.5 1.5-1.25 3.75-1.75 6.75-1.5V4c-3-.25-5.25.25-6.75 1.5Z"
                        />
                        <path d="M10 5.5v11.25" />
                    </svg>
                    Read the docs
                </a>
            </li>
            <li>
                <a href={PUBLIC_BLOG_URL} class={iconLinkClass}>
                    <!-- A pencil over a line of writing. -->
                    <svg
                        class="size-4 shrink-0"
                        viewBox="0 0 20 20"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                    >
                        <path d="M3.25 16.75h13.5" />
                        <path
                            d="M12.6 3.65a1.6 1.6 0 0 1 2.26 2.26L7.5 13.25l-3 .75.75-3 7.35-7.35Z"
                        />
                    </svg>
                    EtherPK Blog
                </a>
            </li>
            <li class="flex w-full justify-center">
                <a href={COMMUNITY_DISCORD_URL} class={iconLinkClass}>
                    <!-- Discord's mark, from Simple Icons (CC0). -->
                    <svg
                        class="size-4 shrink-0"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                    >
                        <path
                            d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"
                        />
                    </svg>
                    Join the EtherPK community on Discord
                </a>
            </li>
        </ul>
    </div>
</section>

<!-- ── The app's own section, if it passes one ───────────────────── -->
{@render belowHero?.()}

<!-- ── Features ──────────────────────────────────────────────────── -->
<section
    class="mx-auto max-w-7xl px-4 pt-24 sm:px-6 sm:pt-32"
    aria-labelledby="features-heading"
>
    <div class="max-w-3xl">
        <h2
            id="features-heading"
            class="text-3xl font-semibold tracking-tight text-gray-950 sm:text-4xl dark:text-white"
        >
            Features at a glance
        </h2>
        <p
            class="mt-4 text-pretty text-base leading-7 text-gray-600 dark:text-gray-300"
        >
            A list of EtherPK features.{#if demoHref}
                To get a feel for EtherPK, <a
                    href={demoHref}
                    class={textLinkClass}>try the demo</a
                >.{/if}
        </p>
    </div>

    <div class="mt-12 grid gap-y-14 sm:mt-16 sm:gap-y-16">
        {#each featureGroups as group (group.id)}
            <section
                id={group.id}
                data-testid="marketing-feature-group"
                aria-labelledby="feature-{group.id}"
                class="grid grid-cols-1 border-t border-gray-950/10 sm:grid-cols-4 sm:gap-x-8 dark:border-white/10"
            >
                <!-- Compass's section label: the rule darkens for the width of the word. -->
                <div class="sm:col-span-1">
                    <div
                        class="-mt-px inline-flex border-t border-gray-950 pt-px dark:border-white"
                    >
                        <p
                            class="pt-4 text-sm font-semibold leading-7 text-gray-950 sm:pt-8 dark:text-white"
                        >
                            {group.label}
                        </p>
                    </div>
                </div>
                <div class="pt-5 sm:col-span-3 sm:pt-8">
                    <h3
                        id="feature-{group.id}"
                        class="text-pretty text-xl font-semibold tracking-tight text-gray-950 dark:text-white"
                    >
                        {group.heading}
                    </h3>
                    <p
                        class="mt-3 max-w-2xl text-pretty text-sm leading-6 text-gray-600 dark:text-gray-400"
                    >
                        {group.intro}
                    </p>
                    <!-- Columns rather than a grid: items read down then across, and pack without
                         the empty half-rows a grid leaves beside a short item. Margins rather
                         than space-y, which would put a stray gap at the top of column two. -->
                    <ul class="-mb-3 mt-6 md:columns-2 md:gap-x-8">
                        {#each group.items as item (item.lead)}
                            <li
                                class="mb-3 flex items-start gap-3 break-inside-avoid text-sm leading-6 text-gray-600 dark:text-gray-400"
                            >
                                <span
                                    class="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gray-950 dark:bg-white"
                                    aria-hidden="true"
                                ></span>
                                <span
                                    ><span
                                        class="font-medium text-gray-950 dark:text-white"
                                        >{@render inline(item.lead)}</span
                                    >{@render inline(item.text)}</span
                                >
                            </li>
                        {/each}
                    </ul>
                    <p
                        class="mt-6 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm leading-6 text-gray-500 dark:text-gray-400"
                    >
                        <span>In the docs:</span>
                        {#each group.docs as doc, index (doc.slug)}
                            {#if index > 0}<span
                                    class="text-gray-500 dark:text-gray-400"
                                    aria-hidden="true">&middot;</span
                                >{/if}
                            <a
                                href="{docsHref}/{doc.slug}"
                                class={textLinkClass}
                                aria-label="{doc.title} in the docs"
                                >{doc.title}</a
                            >
                        {/each}
                    </p>
                </div>
            </section>
        {/each}
    </div>
</section>

<!-- ── Two ways to use EtherPK ────────────────────────────────────── -->
<section
    class="mx-auto max-w-7xl px-4 pt-24 sm:px-6 sm:pt-32"
    aria-labelledby="run-heading"
>
    <div class="mb-10 text-center">
        <h2
            id="run-heading"
            class="text-3xl font-semibold tracking-tight text-gray-950 sm:text-4xl dark:text-white"
        >
            Two ways to use EtherPK
        </h2>
        <p
            class="mx-auto mt-4 max-w-xl text-pretty text-base leading-7 text-gray-600 dark:text-gray-300"
        >
            Same editor, same format. Choose local or {syncOption}. We will
            always ensure your data is yours.
        </p>
    </div>
    <div class="grid gap-6 lg:grid-cols-2">
        <article
            class="flex flex-col rounded-3xl border border-gray-200/80 bg-white p-8 shadow-sm dark:border-white/10 dark:bg-zinc-900/85"
        >
            <p
                class="text-sm font-semibold uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400"
            >
                Free
            </p>
            <h3
                class="mt-3 text-xl font-semibold text-gray-950 dark:text-white"
            >
                Your files, your machine
            </h3>
            <p class="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">
                Point EtherPK at a folder and your graph is a directory of
                markdown files and images. Back it up, put it in git, open it
                elsewhere. Or run the source-available Client on your own
                computer, with no EtherPK account or service involved.
            </p>
            <ul
                class="mt-5 flex-1 space-y-2 text-sm leading-6 text-gray-700 dark:text-gray-200"
            >
                <li class="flex items-start gap-3">
                    <span
                        class="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gray-950 dark:bg-white"
                        aria-hidden="true"
                    ></span>The whole editor, with no limit on what you write
                </li>
                <li class="flex items-start gap-3">
                    <span
                        class="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gray-950 dark:bg-white"
                        aria-hidden="true"
                    ></span>Folder graphs in a Chromium desktop browser, or the
                    Client on your own machine
                </li>
                <li class="flex items-start gap-3">
                    <span
                        class="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gray-950 dark:bg-white"
                        aria-hidden="true"
                    ></span>Run the source-available Client yourself, as a Node
                    bundle or a Docker image
                </li>
                <li class="flex items-start gap-3">
                    <span
                        class="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gray-950 dark:bg-white"
                        aria-hidden="true"
                    ></span>{managed
                        ? "Join synced graphs shared with you by a Sync+ subscriber"
                        : "Join synced graphs shared with you on your Sync Server"}
                </li>
            </ul>
            <a
                href={appHref}
                class="mt-6 inline-flex h-11 items-center justify-center rounded-xl border border-gray-300 px-5 text-sm font-semibold text-gray-800 transition-colors hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-950 dark:border-white/15 dark:text-gray-100 dark:hover:bg-white/5 dark:focus-visible:outline-white"
                >Open the app</a
            >
        </article>
        {#if managed}
            <article
                class="flex flex-col rounded-3xl border border-gray-950 bg-gray-950 p-8 text-white shadow-xl dark:border-white/10"
            >
                <p
                    class="text-sm font-semibold uppercase tracking-[0.2em] text-gray-300"
                >
                    Sync+
                </p>
                <h3 class="mt-3 text-xl font-semibold">
                    Every device, end-to-end encrypted
                </h3>
                <p class="mt-3 text-sm leading-6 text-gray-300">
                    We run the sync service for you. Your graph is encrypted on
                    your device with keys only you hold, then synced to your
                    phone, tablet and laptop, and to the people you choose to
                    share it with. A live markdown copy on your disk keeps the
                    files yours.
                </p>
                <ul
                    class="mt-5 flex-1 space-y-2 text-sm leading-6 text-gray-100"
                >
                    <li class="flex items-start gap-3">
                        <span
                            class="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-white"
                            aria-hidden="true"
                        ></span>Works on phones, Safari and Firefox too
                    </li>
                    <li class="flex items-start gap-3">
                        <span
                            class="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-white"
                            aria-hidden="true"
                        ></span>Share a graph and edit it together, live
                    </li>
                    <li class="flex items-start gap-3">
                        <span
                            class="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-white"
                            aria-hidden="true"
                        ></span>Managed storage for images and files
                    </li>
                    <li class="flex items-start gap-3">
                        <span
                            class="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-white"
                            aria-hidden="true"
                        ></span>One flat monthly price, with a free trial
                    </li>
                </ul>
                {#if pricingHref}
                    <a
                        href={pricingHref}
                        class="mt-6 inline-flex h-11 items-center justify-center rounded-xl bg-white px-5 text-sm font-semibold text-gray-950 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                        >See Sync+ pricing</a
                    >
                {/if}
            </article>
        {:else}
            <article
                data-testid="home-sync-server"
                class="flex flex-col rounded-3xl border border-gray-950 bg-gray-950 p-8 text-white shadow-xl dark:border-white/10"
            >
                <p
                    class="text-sm font-semibold uppercase tracking-[0.2em] text-gray-300"
                >
                    Sync Server
                </p>
                <h3 class="mt-3 text-xl font-semibold">
                    Your team's Sync Server
                </h3>
                <p class="mt-3 text-sm leading-6 text-gray-300">
                    Your team runs the sync service. Your graph is encrypted on
                    your device with keys only you hold, then synced to your
                    phone, tablet and laptop, and to the people you choose to
                    share it with. The server stores what it cannot read.
                </p>
                <ul
                    class="mt-5 flex-1 space-y-2 text-sm leading-6 text-gray-100"
                >
                    <li class="flex items-start gap-3">
                        <span
                            class="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-white"
                            aria-hidden="true"
                        ></span>Works on phones, Safari and Firefox too
                    </li>
                    <li class="flex items-start gap-3">
                        <span
                            class="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-white"
                            aria-hidden="true"
                        ></span>Share a graph and edit it together, live
                    </li>
                    <li class="flex items-start gap-3">
                        <span
                            class="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-white"
                            aria-hidden="true"
                        ></span>An account on the server, and an access token
                        for each device
                    </li>
                </ul>
                {#if syncServerHref}
                    <a
                        href={syncServerHref}
                        class="mt-6 inline-flex h-11 items-center justify-center rounded-xl bg-white px-5 text-sm font-semibold text-gray-950 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                        >Go to your Sync Server</a
                    >
                {/if}
            </article>
        {/if}
    </div>
</section>

<!-- ── Using EtherPK ──────────────────────────────────────────────── -->
<section
    class="mx-auto max-w-3xl px-4 pt-24 sm:px-6 sm:pt-32"
    aria-labelledby="using-heading"
>
    <h2
        id="using-heading"
        class="text-xl font-semibold tracking-tight text-gray-950 dark:text-white"
    >
        Using EtherPK
    </h2>
    <ul class="mt-5 space-y-4">
        {#each usageNotes as note (note)}
            <li
                class="flex items-start gap-3 text-sm leading-6 text-gray-600 dark:text-gray-300"
            >
                <span
                    class="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gray-400"
                    aria-hidden="true"
                ></span>
                <span>{note}</span>
            </li>
        {/each}
    </ul>
</section>

<!-- ── Close ──────────────────────────────────────────────────────── -->
<section
    class="mx-auto max-w-7xl px-4 pb-8 pt-24 text-center sm:px-6 sm:pt-32"
    aria-labelledby="close-heading"
>
    <h2
        id="close-heading"
        class="text-3xl font-semibold tracking-tight text-gray-950 sm:text-4xl dark:text-white"
    >
        Start with today's journal
    </h2>
    <p
        class="mx-auto mt-4 max-w-xl text-pretty text-base leading-7 text-gray-600 dark:text-gray-300"
    >
        Open EtherPK, choose a folder, and write the day. When something in it
        deserves a page of its own, wrap the words in double brackets and follow
        the link.
    </p>
    <div class="mt-10">
        {@render actionRow("marketing-closing-actions")}
    </div>
    {#if supportEmail}
        <p class="mt-4 text-sm leading-6 text-gray-500 dark:text-gray-400">
            Need support? Email us at <a
                href="mailto:{supportEmail}"
                class={textLinkClass}>{supportEmail}</a
            >.
        </p>
    {/if}
</section>
