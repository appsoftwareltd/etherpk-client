<script lang="ts">
    import TypedWord from "./TypedWord.svelte";

    /**
     * The top of every EtherPK home page: the product's name, over the headline whose last word is
     * typed over by the things EtherPK is for. The headline calls EtherPK a notes app, the words a
     * first visit knows. The Corporate and Client home page and the Sync
     * Server's own home page both open with it, so the three origins read as one product. What
     * follows it (a tagline, actions) is each page's own.
     */
    let {
        id,
    }: {
        /** The heading's id, so the page's hero section can name itself after it. */
        id: string;
    } = $props();

    // The headline's last word, typed over by each of the others in turn and then restored. Each
    // must fit on one line of the headline on a phone.
    const headlineWords = [
        "Everything",
        "Journalling",
        "Docs",
        "Blogging",
        "Your Agents",
        "Desktop",
        "Mobile",
        "Tasks",
        "Kanban Boards",
    ];
</script>

<p
    data-testid="marketing-hero-eyebrow"
    class="text-balance text-sm font-semibold uppercase tracking-[0.2em] text-neutral-950 dark:text-white"
>
    Ether Personal Knowledge
</p>
<h1
    {id}
    class="mx-auto mt-5 max-w-4xl text-balance text-4xl font-semibold leading-[1.1] tracking-tight text-neutral-950 sm:text-6xl dark:text-white"
>
    One Markdown Notes App For
    <TypedWord words={headlineWords} testId="marketing-headline-word" />
</h1>
