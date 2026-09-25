<script lang="ts">
    /**
     * A picture on a read-only surface (the references [[View]]), resolved and rendered the way
     * the editor's embed does it: remote urls straight into the `src`, an [[Asset Reference]]
     * through the active [[Asset Store]] (which on a synced graph is a download and a decrypt),
     * and the alt-text display-size hint honoured as a **maximum** so an image scales down to fit
     * but is never blown up.
     *
     * The actions are the editor's overlay, made to look the same: pinned to the picture's
     * top-right corner, hidden until the pointer is over the picture or a button has focus, and
     * moved BESIDE a picture too narrow to hold them — the editor measures the image for that,
     * and so does this (`bind:clientWidth`). Touch has no hover, so, as in the editor, the overlay
     * is not drawn there at all and a long press raises the same actions through the [[Context
     * Menu]]; right-click does too. Delete is on neither: the target carries no position.
     *
     * Three states, all of them reachable: resolving, shown, and gone. "Gone" is not a bug — a
     * reference outlives its bytes (ADR 0054) — so it renders the alt text in a marked box and
     * keeps the actions minus download, which is the same affordance the editor gives it.
     *
     * The `<img>` is in the DOM from the moment a `src` exists but stays `hidden` until it has
     * loaded, for the reason the editor's widget builds it detached: an image with a source it has
     * not fetched yet paints as the browser's broken-image icon.
     *
     * One thing differs from the editor on purpose: the picture is capped to a thumbnail height,
     * because a reference is a quotation rather than the document. See {@link THUMBNAIL_MAX_HEIGHT}.
     */
    import { assetNameFromRef, displayNameForRef } from "$lib/storage/fs/asset-store";
    import { attachContextMenu } from "$lib/surface";

    import { tryGetActiveAssetStore } from "../active-asset-store";
    import AssetActions from "./AssetActions.svelte";
    import { isDirectImageUrl } from "./augmentations/image-target";

    let {
        url,
        alt,
        maxWidth,
        maxHeight,
    }: { url: string; alt: string; maxWidth?: number; maxHeight?: number } = $props();

    /**
     * A reference is a quotation, and the panel is where you *recognise* a picture rather than
     * study it: one tall screenshot at full panel width pushes every other reference off screen.
     * So the panel applies its own maximum on top of the author's — the author's still wins where
     * it is tighter, because both are maxima and the smaller of two maxima is the one that binds.
     * Full size is one click away in the asset's own tab.
     */
    const THUMBNAIL_MAX_HEIGHT = 192;
    const cappedHeight = $derived(Math.min(maxHeight ?? THUMBNAIL_MAX_HEIGHT, THUMBNAIL_MAX_HEIGHT));

    /** How far the overlay is inset from the picture's corner — the editor's `OVERLAY_INSET`. */
    const OVERLAY_INSET = 6;

    /** Only a reference to this graph's own files has actions: a remote picture is not stored
     *  here, and the browser's own "Save image as" already covers saving it. */
    const ref = $derived(assetNameFromRef(url) === null ? null : url);
    /** What to call the image when it has no alt text of its own. */
    const label = $derived(alt || (ref ? displayNameForRef(ref) : url));

    let src = $state<string | null>(null);
    let loaded = $state(false);
    let broken = $state(false);

    // Measured live, as the editor does with a ResizeObserver: an overlay wider than its picture
    // would cover it completely — a 24px icon against two buttons — leaving nothing to hover or
    // click. Such a picture gets the overlay just beside it instead.
    let imageWidth = $state(0);
    let overlayWidth = $state(0);
    const narrow = $derived(overlayWidth + OVERLAY_INSET * 2 > imageWidth);

    // Resolving the bytes is a genuine external effect, and it has to re-run when the panel
    // re-points this slot at a different image.
    $effect(() => {
        const target = url;
        let live = true;
        src = null;
        loaded = false;
        broken = false;

        if (isDirectImageUrl(target)) {
            src = target;
            return;
        }
        const store = tryGetActiveAssetStore();
        if (!store) {
            broken = true;
            return;
        }
        void store
            .resolve(target)
            .then((resolved) => {
                if (!live) return;
                if (resolved) src = resolved.url;
                else broken = true;
            })
            .catch(() => {
                if (live) broken = true;
            });
        return () => {
            live = false;
        };
    });

    /** Right-click and long press raise the same actions the overlay shows — the touch route. */
    function assetMenu(node: HTMLElement) {
        const target = ref;
        if (!target) return;
        return attachContextMenu(node, () => ({ kind: "asset", ref: target }));
    }
</script>

{#if broken}
    <span class="figure figure--broken" data-testid="reference-image-broken" {@attach assetMenu}>
        <span class="broken-label">{label}</span>
        {#if ref}<AssetActions {ref} canDownload={false} size={16} />{/if}
    </span>
{:else}
    <span class="figure" class:figure--narrow={narrow} data-testid="reference-image" {@attach assetMenu}>
        {#if !loaded}
            <!-- Holds the row open while the bytes arrive, so the panel does not jump when they
                 do. No remembered footprint to reserve here: unlike the editor, nothing collapses
                 and re-renders this image mid-read. -->
            <span class="loading" role="status" aria-label="Loading image"
                ><span class="spinner"></span></span
            >
        {/if}
        {#if src}
            <img
                {src}
                alt={label}
                hidden={!loaded}
                bind:clientWidth={imageWidth}
                style:max-width={maxWidth === undefined ? null : `min(${maxWidth}px, 100%)`}
                style:max-height="{cappedHeight}px"
                onload={() => (loaded = true)}
                onerror={() => (broken = true)}
            />
        {/if}
        {#if ref && loaded}
            <span class="overlay" data-testid="reference-image-overlay" bind:clientWidth={overlayWidth}>
                <AssetActions {ref} size={18} />
            </span>
        {/if}
    </span>
{/if}

<style>
    /* Shrink-to-fit around the picture, so the overlay's corner is the picture's corner. The
       containing block is the reference card, which has a definite width, so the image's
       `max-width: 100%` resolves against that. `touch-action` / `user-select` are what the
       long-press contract asks for, or iOS Safari's callout takes the gesture first. */
    .figure {
        position: relative;
        display: inline-block;
        max-width: 100%;
        margin: 0.15rem 0;
        vertical-align: top;
        touch-action: manipulation;
        user-select: none;
    }
    .figure img {
        display: block;
        max-width: 100%;
        height: auto;
        border-radius: 4px;
    }
    /* Neutral translucent, not a surface token: the reference card is already `--gk-surface-2`.
       Grey over grey reads as a held space in both themes. */
    .loading {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 8em;
        min-height: 3em;
        border-radius: 4px;
        background: rgba(127, 127, 127, 0.18);
    }
    /* The escalation, not the first response: the tinted box alone is the answer for the sub-second
       case (a local file), and the spinner fades in only if the wait becomes one worth explaining —
       a synced asset being downloaded and decrypted. Fading in on a delay is what stops it
       flashing on every reference the panel draws. */
    .spinner {
        width: 1em;
        height: 1em;
        box-sizing: border-box;
        border-radius: 50%;
        border: 2px solid rgba(127, 127, 127, 0.25);
        border-top-color: rgba(127, 127, 127, 0.8);
        opacity: 0;
        animation:
            reference-image-appear 200ms ease 400ms forwards,
            reference-image-spin 0.9s linear 400ms infinite;
    }
    @keyframes reference-image-appear {
        to {
            opacity: 1;
        }
    }
    @keyframes reference-image-spin {
        to {
            transform: rotate(360deg);
        }
    }
    /* Rotation is the spatial motion the preference suppresses; a slow pulse still says "busy",
       and a static ring reads as broken (the editor's placeholder learned this the hard way). */
    @media (prefers-reduced-motion: reduce) {
        .spinner {
            animation:
                reference-image-appear 200ms ease 400ms forwards,
                reference-image-pulse 1.6s ease-in-out 400ms infinite;
        }
    }
    @keyframes reference-image-pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.3;
        }
    }

    /* The overlay: the editor's `.cm-md-image-actions`, value for value. Hidden until the pointer
       is over the picture or a button has focus, and the CONTAINER never takes pointer events —
       only its buttons do, once shown — so a picture is never impossible to hover under its own
       controls. */
    .overlay {
        position: absolute;
        top: 6px;
        right: 6px;
        display: flex;
        gap: 2px;
        padding: 2px;
        border-radius: 5px;
        background: var(--gk-surface-1, rgba(255, 255, 255, 0.92));
        border: 1px solid var(--gk-border-soft, rgba(0, 0, 0, 0.12));
        box-shadow: var(--gk-shadow, 0 1px 3px rgba(0, 0, 0, 0.25));
        opacity: 0;
        transition: opacity 120ms ease;
        pointer-events: none;
    }
    .figure:hover .overlay,
    .overlay:focus-within {
        opacity: 1;
    }
    .figure:hover .overlay :global(.action),
    .overlay:focus-within :global(.action) {
        pointer-events: auto;
    }
    /* Too narrow to hold the overlay: put it just beside the picture, as the editor does with a
       negative offset. The figure does not clip, so it simply sits in the margin. */
    .figure--narrow .overlay {
        right: auto;
        left: calc(100% + 6px);
    }
    /* Touch: no hover to reveal it, and a permanently invisible tap target over the picture would
       be worse than none. The Context Menu, raised by long press, is the route there. */
    @media (hover: none) {
        .overlay {
            display: none;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .overlay {
            transition: none;
        }
    }

    /* Gone, not failed: marked rather than coloured as an error, and still readable as the name
       of the thing that is missing. No picture to overlay, so the actions sit beside the name. */
    .figure--broken {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.15rem 0.35rem;
        border: 1px dashed var(--gk-border-soft, rgba(127, 127, 127, 0.5));
        border-radius: 4px;
        opacity: 0.75;
    }
    .broken-label {
        font-style: italic;
        word-break: break-word;
    }
</style>
