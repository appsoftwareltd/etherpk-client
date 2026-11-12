<script lang="ts" module>
    /**
     * A button of the home page, named by the row it is in and what it opens: the row under the
     * headline ("hero") or the row that closes the page.
     */
    export type MarketingActionId = `${"hero" | "closing"}_${"try_demo" | "open_app" | "pricing"}`;
</script>

<script lang="ts">
    import { page } from "$app/state";
    import type { Snippet } from "svelte";
    import {
        CLIENT_REPOSITORY_URL,
        COMMUNITY_DISCORD_URL,
        PUBLIC_BLOG_URL,
    } from "../deployment-navigation";
    import MarketingHeadline from "./MarketingHeadline.svelte";
    import MarketingScreenshots from "./MarketingScreenshots.svelte";

    /**
     * The public landing page, served by Corporate (www) and by the Client (app) so the two
     * never drift. Only the destinations differ, which is why they are props: a standalone
     * Client has no Corporate, so pricing is simply absent there, and the button row shrinks
     * to what is offered rather than leaving a gap. `belowHero` is the one place an app adds
     * content of its own. `onAction` tells the app that rendered the page which button of the
     * two rows was pressed; the page itself records nothing, and the Client passes no listener.
     *
     * `canonicalUrl` is Corporate's copy of this page: Corporate names its own, a managed
     * Client names Corporate's so search engines index one copy, and a standalone Client has
     * none to name. Images are served by whichever origin rendered the page, so every app ships
     * `static/marketing/` (the corporate e2e suite checks both), and Open Graph needs the
     * absolute URL.
     *
     * `managed` is false on a self-hosted Client, which runs beside a team's own Sync Server
     * rather than EtherPK's: the page then offers that server instead of Sync+, which such an
     * install cannot sell, links it from the note beneath the actions, and asks search engines
     * not to index a copy with no canonical page.
     *
     * `supportEmail` is the managed service's support address, given at the foot of the page. A
     * self-hosted Client passes none, because the people who run it support its users, not
     * EtherPK. The Client's repository, the blog and the Discord community are the same for every
     * copy, so they are constants rather than props.
     *
     * The list of what EtherPK offers is a condensed reading of the user docs' own feature
     * list. Nothing here should say more than the docs do.
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
        onAction,
    }: {
        appHref?: string;
        demoHref?: string | null;
        pricingHref?: string | null;
        docsHref?: string;
        canonicalUrl?: string | null;
        /** Whether EtherPK's Managed Sync (Sync+) is on offer; false on a self-hosted Client. */
        managed?: boolean;
        /** The team's Sync Server, which a self-hosted page links in place of Sync+. */
        syncServerHref?: string | null;
        /** Where to write for support, given at the foot of the page. None on a self-hosted Client. */
        supportEmail?: string | null;
        /**
         * A section of the app's own, shown straight after the headline, the actions and the note
         * beneath them, so it is the second screen of the page, above the screenshots.
         */
        belowHero?: Snippet;
        /**
         * Called when a button in the row under the headline or in the row that closes the page
         * is pressed, before the browser follows the link. It must return at once: the link is
         * followed whatever it does.
         */
        onAction?: (id: MarketingActionId) => void;
    } = $props();

    const socialImageUrl = $derived(
        new URL("/marketing/social-card.png", page.url.origin).href,
    );

    type Action = {
        id: "try_demo" | "open_app" | "pricing";
        label: string;
        href: string;
        icon: "app" | "demo" | "pricing";
        /** How much the row makes of it: the filled button, the outlined one, or a text link. */
        variant: "primary" | "secondary" | "link";
    };

    // One row, ranked in the order a first visit needs them: look at it, use it, price it. The
    // demo asks nothing of a visitor, so it is the filled button; the app is the outlined one
    // beside it; pricing is a text link. Where there is no demo to offer, the app leads.
    const actions = $derived<Action[]>([
        ...(demoHref
            ? [
                  {
                      id: "try_demo" as const,
                      label: "Try The Demo",
                      href: demoHref,
                      icon: "demo" as const,
                      variant: "primary" as const,
                  },
              ]
            : []),
        {
            id: "open_app",
            label: "Open The App",
            href: appHref,
            icon: "app",
            variant: demoHref ? "secondary" : "primary",
        },
        ...(pricingHref
            ? [
                  {
                      id: "pricing" as const,
                      label: "Sync+ Pricing",
                      href: pricingHref,
                      icon: "pricing" as const,
                      variant: "link" as const,
                  },
              ]
            : []),
    ]);

    /** The synced choice beside a folder graph: Sync+, or a self-hosted Client's own server. */
    const syncOption = $derived(managed ? "Sync+" : "your Sync Server");

    /** Where EtherPK runs and how it keeps notes, as short labels beneath the hero's tagline. */
    const highlights = [
        "Markdown + [[Wikilinks]]",
        "Mobile and Desktop",
        "Agent MCP Server",
        "Local + Sync",
        "E2E Encryption",
    ];

    /** What EtherPK offers, as one run of text separated by bullets beneath the hero's labels. */
    const offers = $derived([
        "Long-form prose and outliner features in the same documents",
        "Robust wikilinking and aliasing",
        `Plain local markdown files, or ${syncOption} with export`,
        "Task management and Kanban boards",
        "PDF and EBook Reader",
        "Document Versioning",
        "Real-time collaboration",
        "Quick Notes, with sharing from other apps",
        "End-to-end encryption",
        "Static site publishing",
        "AI agent integration",
        "Source-available Client",
    ]);

    // What to know before choosing a synced graph. A self-hosted Client's server is run by its
    // team, not by EtherPK, so that copy names the server rather than "we". Which browsers run
    // which graphs is in "Ways to run EtherPK".
    const usageNotes = $derived([
        `End-to-end encryption protects your data and privacy. An unlocked device or your Recovery Code is needed to decrypt your synced notes. ${managed ? "We cannot" : "Your Sync Server cannot"} decrypt or recover your notes for you. Keep a copy of your code safe and backed up.`,
    ]);

    /**
     * "Ways to run EtherPK": the app in a browser, the Node bundle and the Docker image, then
     * which browsers run which graphs. Facts only, in the docs' own words, each with its docs
     * page. A managed page names the hosted Client's address; a self-hosted one has no address
     * to name but its own.
     */
    const waysToRun = $derived([
        {
            id: "browser",
            lead: "Browser",
            source: managed ? { label: new URL(appHref, page.url.origin).host, href: appHref } : null,
            text: managed
                ? "Install it from the browser for its own window and a start with no network."
                : "This Client, in a browser. Install it from the browser for its own window and a start with no network.",
            docs: { label: "Install steps", slug: "installing-etherpk-as-an-app" },
        },
        {
            id: "node",
            lead: "Node.js 24+",
            source: { label: "GitHub releases", href: `${CLIENT_REPOSITORY_URL}/releases` },
            text: "Download `etherpk-client-<version>.tar.gz`, unpack it and run `node build`.",
            docs: { label: "Setup", slug: "running-etherpk-on-your-own-computer" },
        },
        {
            id: "docker",
            lead: "Docker",
            source: { label: "ghcr.io/appsoftwareltd/etherpk-client", href: `${CLIENT_REPOSITORY_URL}/pkgs/container/etherpk-client` },
            text: "Listens on port 3000.",
            docs: { label: "Setup", slug: "running-etherpk-on-your-own-computer" },
        },
    ]);
    const browserSupport = [
        {
            lead: "Synced graphs",
            text: "All platforms. Current Chrome, Edge, Firefox, Safari and Samsung Internet, phones and tablets included.",
        },
        {
            lead: "Folder graphs",
            text: "Chrome and Edge on a computer, and Chrome on Android. (Note: Firefox, all iOS browsers not supported. Brave requires folder access to be enabled)",
        },
    ];

    /** Splits text on backticks; the odd-numbered pieces were inside them. */
    function segments(text: string): { code: boolean; text: string }[] {
        return text
            .split("`")
            .map((piece, index) => ({ code: index % 2 === 1, text: piece }));
    }

    // The two buttons are the same size and differ only in their fill; the link beside them is as
    // tall, so it is as easy to hit, and takes a line of its own on a phone.
    const actionBase =
        "inline-flex h-12 items-center justify-center gap-2.5 text-base font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-950 dark:focus-visible:outline-white";
    const buttonBase = `${actionBase} w-full rounded-xl px-6 shadow-sm sm:w-56`;
    const actionClasses: Record<Action["variant"], string> = {
        primary: `${buttonBase} bg-neutral-950 text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-100`,
        secondary: `${buttonBase} bg-white text-neutral-950 ring-1 ring-inset ring-neutral-950/15 hover:bg-neutral-50 dark:bg-white/5 dark:text-white dark:ring-white/15 dark:hover:bg-white/10`,
        link: `${actionBase} rounded-lg px-3 text-neutral-700 underline decoration-neutral-400 underline-offset-4 hover:text-neutral-950 dark:text-neutral-300 dark:hover:text-white`,
    };

    // Every text link on the page looks the same. The links beneath the hero add an icon, and
    // share one class list so the repository, the docs, the blog and the Discord community match.
    const textLinkClass =
        "font-medium text-neutral-700 underline decoration-neutral-400 underline-offset-2 transition-colors hover:text-neutral-950 dark:text-neutral-300 dark:hover:text-white";
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
        content="EtherPK: one Markdown notes app for everything, beside a screenshot of the editor"
    />
    <meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<!-- Backticks in copy become code; keeps the data plain strings and the template free of @html. -->
{#snippet inline(text: string)}
    {#each segments(text) as segment, index (index)}
        {#if segment.code}<code
                class="rounded bg-neutral-950/6 px-1 py-0.5 font-mono text-neutral-800 dark:bg-white/10 dark:text-neutral-100"
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

<!-- The same row opens and closes the page. A press is reported to the app that rendered the
     page, if it listens, and the link is followed as it would be without a listener. -->
{#snippet actionRow(placement: "hero" | "closing")}
    <div
        data-testid="marketing-{placement}-actions"
        class="mx-auto flex w-full max-w-3xl flex-col items-center justify-center gap-3 sm:flex-row"
    >
        {#each actions as action (action.id)}
            <a
                href={action.href}
                class={actionClasses[action.variant]}
                data-variant={action.variant}
                data-testid={placement === "hero" && action.id === "try_demo"
                    ? "marketing-try-demo"
                    : undefined}
                onclick={onAction && (() => onAction(`${placement}_${action.id}`))}
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
        <MarketingHeadline id="hero-heading" />
        <!-- What EtherPK is, straight under the headline; then what it is for, a step quieter. -->
        <p
            data-testid="marketing-hero-subline"
            class="mx-auto mt-5 max-w-3xl text-balance text-xl font-medium leading-8 text-neutral-800 sm:text-2xl sm:leading-9 dark:text-neutral-100"
        >
            Fast, Private, Secure Knowledge Management
        </p>
        <p
            data-testid="marketing-hero-tagline"
            class="mx-auto mt-3 max-w-2xl text-pretty text-base leading-7 text-neutral-600 sm:text-lg sm:leading-8 dark:text-neutral-300"
        >
            Write, think, link your ideas, manage tasks, hand work to AI agents,
            publish to the web. Your data stays yours.
        </p>
        <ul
            data-testid="marketing-hero-highlights"
            class="mx-auto mt-6 flex max-w-4xl flex-wrap justify-center gap-x-6 gap-y-2"
        >
            {#each highlights as highlight (highlight)}
                <li
                    class="inline-flex items-center gap-1.5 text-sm font-medium leading-6 text-neutral-700 dark:text-neutral-300"
                >
                    <svg
                        class="size-4 shrink-0 text-neutral-950 dark:text-white"
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
            {@render actionRow("hero")}
        </div>
        <p
            data-testid="marketing-hero-note"
            class="mx-auto mt-4 max-w-2xl text-pretty text-sm leading-6 text-neutral-500 dark:text-neutral-400"
        >
            <!-- A self-hosted page links the team's server here, where Sync+ is named on a managed one. -->
            Free for folder graphs in Chrome or Edge. {#if managed}Sync+{:else if syncServerHref}<a
                    href={syncServerHref}
                    class={textLinkClass}>Your team's Sync Server</a
                >{:else}Your team's Sync Server{/if} works in every browser and on your phone,
            or bring your own sync (Git, Syncthing).
        </p>
    </div>

    <!-- The app's own section, if it passes one: the second screen of the page. -->
    {@render belowHero?.()}

    <!-- The app as it is, rather than an illustration of it: the demo graph in four views. -->
    <MarketingScreenshots />

    <!-- What EtherPK offers, then where to read more and talk about it, beneath the screenshots. -->
    <div class="mx-auto max-w-7xl px-4 pt-12 text-center sm:px-6 sm:pt-16">
        <p
            class="mx-auto max-w-3xl text-balance text-xl font-medium leading-8 text-neutral-800 sm:text-2xl sm:leading-9 dark:text-neutral-100"
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
            class="mx-auto mt-4 max-w-5xl text-pretty text-base leading-7 text-neutral-600 sm:text-lg sm:leading-8 dark:text-neutral-300"
        >
            {#each offers as offer, index (offer)}
                <li class="inline">
                    {#if index > 0}<span
                            class="px-2 text-neutral-950 dark:text-white"
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

<!-- ── Ways to run EtherPK ────────────────────────────────────────── -->
<section
    class="mx-auto max-w-3xl px-4 pt-24 sm:px-6 sm:pt-32"
    aria-labelledby="ways-heading"
    data-testid="marketing-ways-to-run"
>
    <h2
        id="ways-heading"
        class="text-xl font-semibold tracking-tight text-neutral-950 dark:text-white"
    >
        Ways to run EtherPK
    </h2>
    <dl class="mt-5 space-y-3 text-sm leading-6 text-neutral-600 dark:text-neutral-300">
        {#each waysToRun as way (way.id)}
            <div class="sm:flex sm:gap-4" data-testid="marketing-way-{way.id}">
                <dt class="shrink-0 font-semibold text-neutral-950 sm:w-32 dark:text-white">{way.lead}</dt>
                <dd>
                    <!-- The space sits between the blocks on one line: whitespace at the end of an
                         {#if} block is dropped. -->
                    {#if way.source}<a href={way.source.href} class={textLinkClass}>{way.source.label}</a>.{/if} {@render inline(way.text)}
                    <a href="{docsHref}/{way.docs.slug}" class={textLinkClass}>{way.docs.label}</a>
                </dd>
            </div>
        {/each}
    </dl>
    <dl class="mt-5 space-y-2 border-t border-neutral-950/5 pt-5 text-sm leading-6 text-neutral-600 dark:border-white/10 dark:text-neutral-300">
        {#each browserSupport as support (support.lead)}
            <div class="sm:flex sm:gap-4">
                <dt class="shrink-0 font-semibold text-neutral-950 sm:w-32 dark:text-white">{support.lead}</dt>
                <dd>{support.text}</dd>
            </div>
        {/each}
    </dl>
</section>

<!-- ── Using EtherPK ──────────────────────────────────────────────── -->
<section
    class="mx-auto max-w-3xl px-4 pt-24 sm:px-6 sm:pt-32"
    aria-labelledby="using-heading"
>
    <h2
        id="using-heading"
        class="text-xl font-semibold tracking-tight text-neutral-950 dark:text-white"
    >
        Using EtherPK
    </h2>
    <ul class="mt-5 space-y-4">
        {#each usageNotes as note (note)}
            <li
                class="flex items-start gap-3 text-sm leading-6 text-neutral-600 dark:text-neutral-300"
            >
                <span
                    class="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-400"
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
        class="text-3xl font-semibold tracking-tight text-neutral-950 sm:text-4xl dark:text-white"
    >
        Start with today's journal
    </h2>
    <p
        class="mx-auto mt-4 max-w-xl text-pretty text-base leading-7 text-neutral-600 dark:text-neutral-300"
    >
        Open EtherPK, choose a folder, and write the day. When something in it
        deserves a page of its own, wrap the words in double brackets and follow
        the link.
    </p>
    <div class="mt-10">
        {@render actionRow("closing")}
    </div>
    {#if supportEmail}
        <p class="mt-4 text-sm leading-6 text-neutral-500 dark:text-neutral-400">
            Need support? Email us at <a
                href="mailto:{supportEmail}"
                class={textLinkClass}>{supportEmail}</a
            >.
        </p>
    {/if}
</section>
