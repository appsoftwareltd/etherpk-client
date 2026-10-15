<script lang="ts">
    /**
     * A fence an extension draws, quoted read-only in a reference list (the Backlinks panel, and the
     * backlinks beneath a document), ADR 0146: what its registration's `quote` answers
     * (`quoted-fences.ts`), where the editor would draw its widget. A drawing is its picture, in the
     * app's theme, and a video a link card to its page.
     *
     * - **Its states.** A box while the first answer is asked for, which says so if that takes a
     *   moment; the picture or the link card; and, where the extension answers nothing or fails, what
     *   shows without it. Without it an ordinary fence (`video`) is its text as code, as before, and
     *   an [[Extension Fence]] (`excalidraw.drawing`) is a note naming the extension, never its data
     *   (ADR 0138): "isn't running here" when nothing draws it, "open the document" when the
     *   extension runs but quotes nothing.
     * - **Heard again.** Extensions start after the graph opens and can be switched off and on, so the
     *   registration is read again whenever one comes or goes. The answer is asked for again when
     *   the fence's text, the theme or the extension's own settings change, and the one shown stays
     *   until the next arrives, so nothing below it moves. An answer is only ever shown under the
     *   registration and the fence it was given for.
     * - **No taller than {@link MAX_HEIGHT_REM}rem.** A picture is shown at its own size, scaled down
     *   to the card's width and to that height, its shape kept.
     *
     * A click on a picture is a click on the reference: it opens the source document at the
     * reference's line, where the live widget is. A link card is a link of its own, which opens its
     * page in a new tab and does not open the document.
     */
    import type { PublishedFence } from "@appsoftwareltd/etherpk-extension-api";
    import { type Snippet, untrack } from "svelte";
    import { createSubscriber } from "svelte/reactivity";

    import { tryGetActiveContributionRegistry } from "$lib/surface";

    import { extensionOfFence, isExtensionFenceInfo } from "../extension-fence";
    import { appIsDark } from "./app-theme.svelte";
    import { type InteractiveFence, INTERACTIVE_FENCE_KIND, lookupInteractiveFence } from "./augmentations/interactive-fence-contract";
    import { quotedFences } from "./quoted-fences";

    let {
        info,
        code,
        sourceConcept,
        children,
    }: {
        /** The fence's info word. */
        info: string;
        /** The fence's body, its lines joined, as the quote reads it (`quote-segments.ts`). */
        code: string;
        /** The document the fence is in. */
        sourceConcept: string;
        /** What an ordinary fence shows where no extension quotes it: its text as code. */
        children: Snippet;
    } = $props();

    /** The tallest a picture is shown: a drawing several screens tall is scaled to it. */
    const MAX_HEIGHT_REM = 30;

    const watchRegistrations = createSubscriber((update) => tryGetActiveContributionRegistry()?.subscribe(INTERACTIVE_FENCE_KIND, update));

    /** The registration that draws this word now, if any. */
    const fence = $derived.by(() => {
        watchRegistrations();
        return lookupInteractiveFence(info);
    });
    /** Heard when the registration says its quotes may have changed: its extension's settings did. */
    const watchQuotes = $derived.by(() => {
        const current = fence;
        return createSubscriber((update) => current?.quotesChanged?.(update));
    });
    const extensionFence = $derived(isExtensionFenceInfo(info));
    const extension = $derived(extensionFence ? extensionOfFence(info) : info);
    const dark = $derived(appIsDark());
    const body = $derived(code === "" ? [] : code.split("\n"));

    /** The last answer, with the registration and the fence it was given for: kept while the next is asked for. */
    let given = $state.raw<{ fence: InteractiveFence; info: string; answer: PublishedFence | null } | null>(null);
    /** The answer to show: only one given for this registration and this fence. */
    const current = $derived(given && given.fence === fence && given.info === info ? given : null);
    const answer = $derived(current?.answer ?? null);
    /** Whether an answer is still to come, or the last one asked for showed nothing. */
    const phase = $derived(current === null ? "asking" : current.answer ? "answered" : "unanswered");
    /** A link card's picture that would not load (offline, refused): the card shows its text alone. */
    let failedImage = $state<string | null>(null);

    // Asks for the answer the quote wants now, and drops it once the quote wants another. An effect
    // because the answer comes from outside Svelte: it is asked for and waited on, never derived.
    $effect(() => {
        const asked = fence;
        if (!asked?.quote) return;
        watchQuotes();
        const request = { info, body, document: sourceConcept, dark };
        let wanted = true;
        // The extension's own code runs here: nothing it reads becomes something this effect follows.
        untrack(() => quotedFences.quote(asked, request)).then(
            (out) => {
                if (wanted) given = { fence: asked, info: request.info, answer: out };
            },
            (error: unknown) => {
                if (!wanted) return;
                console.error(`[extensions] ${request.info}: the quote of a fence in "${request.document}" could not be shown`, error);
                given = { fence: asked, info: request.info, answer: null };
            },
        );
        return () => {
            wanted = false;
        };
    });

    /** The picture's bytes at an address the image can load, given back when the picture changes. */
    function showPicture(picture: Extract<PublishedFence, { kind: "picture" }>) {
        return (image: HTMLImageElement) => {
            const url = URL.createObjectURL(new Blob([picture.bytes as Uint8Array<ArrayBuffer>], { type: picture.type }));
            image.src = url;
            return () => URL.revokeObjectURL(url);
        };
    }
</script>

{#if fence?.quote && phase !== "unanswered"}
    {#if answer?.kind === "picture"}
        <img
            class="quoted-fence__picture"
            alt={answer.alt}
            width={answer.width}
            height={answer.height}
            style:width={`min(100%, ${answer.width}px, ${((MAX_HEIGHT_REM * answer.width) / answer.height).toFixed(4)}rem)`}
            style:aspect-ratio={`${answer.width} / ${answer.height}`}
            data-testid="reference-fence-picture"
            data-info={info}
            {@attach showPicture(answer)}
        />
    {:else if answer?.kind === "link"}
        <a
            class="quoted-fence__link"
            href={answer.href}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="reference-fence-link"
            data-info={info}
            onclick={(event) => event.stopPropagation()}
        >
            {#if answer.image && answer.image.src !== failedImage}
                {@const image = answer.image}
                <img
                    class="quoted-fence__link-picture"
                    src={image.src}
                    alt={image.alt}
                    width={image.width}
                    height={image.height}
                    loading="lazy"
                    referrerpolicy="no-referrer"
                    style:aspect-ratio={image.width && image.height ? `${image.width} / ${image.height}` : undefined}
                    onerror={() => (failedImage = image.src)}
                />
            {/if}
            <span class="quoted-fence__link-text">{answer.text}</span>
        </a>
    {:else}
        <div class="quoted-fence__waiting" aria-busy="true" data-testid="reference-fence-waiting">
            <span class="quoted-fence__note quoted-fence__loading">Loading…</span>
        </div>
    {/if}
{:else if extensionFence}
    <!-- Never the data an Extension Fence holds (ADR 0138): a note naming its extension, as the
         editor's placeholder does. -->
    <p class="quoted-fence__note quoted-fence__placeholder" data-testid="reference-fence-note" data-extension={extension}>
        {#if fence}
            Content from the <code>{extension}</code> extension. Open the document to see it.
        {:else}
            Content from the <code>{extension}</code> extension, which isn't running here.
        {/if}
    </p>
{:else}
    {@render children()}
{/if}

<style>
    /* At its own size, scaled down to the card's width and MAX_HEIGHT_REM (its inline width). */
    .quoted-fence__picture {
        display: block;
        height: auto;
        margin: 0.2rem 0;
        border-radius: 5px;
    }
    /* The code panel's shade and corners (QuotedCode.svelte), where the picture is coming. */
    .quoted-fence__waiting {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 4rem;
        margin: 0.2rem 0;
        border-radius: 5px;
        background: var(--gk-code-bg, rgba(127, 127, 127, 0.1));
    }
    /* Wait before saying anything, so a quick answer never flashes a message. */
    .quoted-fence__loading {
        animation: quoted-fence-appear 160ms ease-out 400ms both;
    }
    @keyframes quoted-fence-appear {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .quoted-fence__loading {
            animation-duration: 0ms;
        }
    }
    .quoted-fence__note {
        color: var(--gk-text-muted, #6b7280);
    }
    /* The editor's placeholder (interactive-fence.ts, `.gk-extension-fence-placeholder`): a quiet
       line in a dashed box. */
    .quoted-fence__placeholder {
        margin: 0.2rem 0;
        padding: 0.5rem 0.75rem;
        border: 1px dashed var(--gk-border-strong, rgba(127, 127, 127, 0.4));
        border-radius: 0.5rem;
        font-size: max(0.875rem, 0.85em);
        line-height: 1.5;
    }
    /* A published site's link card (publish/markdown/render.ts): the picture over its caption. */
    .quoted-fence__link {
        display: inline-flex;
        flex-direction: column;
        gap: 0.35rem;
        max-width: min(100%, 22rem);
        margin: 0.2rem 0;
        color: var(--gk-accent, #2563eb);
    }
    /* Underlined, as a quoted hyperlink is (InlineMarkdown.svelte). */
    .quoted-fence__link-text {
        text-decoration: underline;
    }
    @media (hover: hover) {
        .quoted-fence__link:hover {
            color: var(--gk-accent-hover, #1d4ed8);
        }
    }
    .quoted-fence__link-picture {
        display: block;
        width: 100%;
        height: auto;
        /* A picture from the web whose size the extension did not give: a video's shape, cropped. */
        aspect-ratio: 16 / 9;
        max-height: 30rem;
        object-fit: cover;
        border-radius: 5px;
        background: var(--gk-code-bg, rgba(127, 127, 127, 0.1));
    }
</style>
