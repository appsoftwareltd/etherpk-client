<script lang="ts">
    /**
     * A [[Map Block]] quoted read-only in the Backlinks panel (ADR 0118, amended 2026-10-10): a
     * picture of the map, framed on every place and route as the Map Block frames them when it
     * opens, at the card's width and 16:9, in the app's theme, over the deployment's basemap. The
     * maps extension draws it (`quoted-map-pictures.ts`); this component asks for it and shows it.
     *
     * - **Drawn once in sight.** A picture is asked for once the map is in the panel's view, or
     *   about to scroll into it, and the card has a width. A map scrolled away before its turn is
     *   not drawn, and nothing is drawn while the page is hidden, where a map cannot draw at all.
     * - **Drawn again at a new width once it holds.** While the panel is being resized the picture
     *   shown stretches to the card, and one at the new width is asked for 300 ms after the width
     *   stops changing. A picture is never taken away to be drawn again: the old one stays until
     *   the new one arrives, so nothing below it moves.
     * - **Its states.** A box at the picture's size while it is drawn, which says so if that takes
     *   a moment; the picture, its alt text naming what is on the map; a line under it when the map
     *   has no places yet, or when the basemap could not be loaded, which is tried again as the
     *   browser comes back online; and the map's lines, as the panel quoted them before, when this
     *   browser cannot draw a map at all.
     *
     * A click on the picture is a click on the reference: it opens the source document at the
     * reference's line, where the live map is.
     */
    import type { Snippet } from "svelte";

    import { mapAltText, readMapBody } from "../map-text";
    import type { MapPicture } from "../publish/publish";
    import { appIsDark } from "./app-theme.svelte";
    import { type QuotedMapPicture, type QuotedMapPictures, quotedMapSize } from "./quoted-map-pictures";

    let {
        source,
        pictures,
        children,
    }: {
        /** The fence's body: the map's lines. */
        source: string;
        pictures: QuotedMapPictures;
        /** What stands in when the map cannot be drawn: its lines. */
        children: Snippet;
    } = $props();

    /** How long the card's width must hold before a picture is drawn at it. */
    const SETTLE_MS = 300;
    /** How long a first picture may take before the card says it is being drawn. */
    const SLOW_MS = 400;
    /** How far beyond the panel's view a map is drawn, so it is there as it scrolls in. */
    const AHEAD = "200px 0px";

    /** The card's width, once it has held still. */
    let cardWidth = $state(0);
    let inSight = $state(false);
    let pageShown = $state(typeof document === "undefined" || document.visibilityState === "visible");
    /** Counts each try at the basemap again, when the browser comes back online. */
    let tries = $state(0);
    let shown = $state.raw<QuotedMapPicture | null>(null);
    let failed = $state(false);
    let slow = $state(false);
    /** What the picture shown was drawn for. Only the effect reads it, so it is not reactive. */
    let shownFor = "";

    const lines = $derived(source.split("\n"));
    const empty = $derived(readMapBody(lines).items.length === 0);
    const alt = $derived(mapAltText(lines));
    const size = $derived(quotedMapSize(cardWidth));
    const dark = $derived(appIsDark());
    /** What the card shows: a picture with or without its basemap, the map's lines, or the box a picture is coming to. */
    const phase = $derived(shown ? (shown.basemap ? "drawn" : "plain") : failed ? "text" : "waiting");

    // Asks for the picture the card wants now, and stops waiting for it once the card wants another
    // or the map leaves the panel's view. An effect because the drawing is outside Svelte: it is
    // started, waited for and given up, never derived.
    $effect(() => {
        if (!inSight || !pageShown || !size) return;
        const wanted = `${tries} ${size.width}x${size.height} ${dark ? "dark" : "light"}\n${source}`;
        if (wanted === shownFor) return;
        const kept = pictures.kept(source, size, dark);
        if (kept) {
            show(kept, wanted);
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => (slow = true), SLOW_MS);
        const stopWaiting = () => {
            clearTimeout(timer);
            slow = false;
        };
        pictures.draw(source, size, dark, controller.signal).then(
            (drawn) => {
                stopWaiting();
                show(drawn, wanted);
            },
            () => {
                if (controller.signal.aborted) return;
                stopWaiting();
                failed = true;
            },
        );
        return () => {
            controller.abort();
            stopWaiting();
        };
    });

    function show(picture: QuotedMapPicture, drawnFor: string) {
        shown = picture;
        shownFor = drawnFor;
        failed = false;
    }

    function backOnline() {
        if (!shown || shown.basemap) return;
        pictures.basemapBack();
        tries++;
    }

    /** The card's width: the first at once, so the first picture waits for nothing, and later ones once they hold. */
    function watchWidth(element: HTMLElement) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const observer = new ResizeObserver(([entry]) => {
            const width = Math.round(entry.contentRect.width);
            clearTimeout(timer);
            if (cardWidth === 0) cardWidth = width;
            else timer = setTimeout(() => (cardWidth = width), SETTLE_MS);
        });
        observer.observe(element);
        return () => {
            clearTimeout(timer);
            observer.disconnect();
        };
    }

    /** The nearest ancestor that scrolls: the panel, whose view decides what is in sight. */
    function scroller(element: HTMLElement): Element | null {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const { overflowY } = getComputedStyle(parent);
            if (overflowY === "auto" || overflowY === "scroll") return parent;
        }
        return null;
    }

    function watchSight(element: HTMLElement) {
        const observer = new IntersectionObserver(([entry]) => (inSight = entry.isIntersecting), { root: scroller(element), rootMargin: AHEAD });
        observer.observe(element);
        return () => observer.disconnect();
    }

    /** The picture's bytes at an address the image can load, given back when the picture changes. */
    function showPicture(picture: MapPicture) {
        return (image: HTMLImageElement) => {
            const url = URL.createObjectURL(new Blob([picture.bytes as Uint8Array<ArrayBuffer>], { type: picture.type }));
            image.src = url;
            return () => URL.revokeObjectURL(url);
        };
    }
</script>

<svelte:window ononline={backOnline} />
<svelte:document onvisibilitychange={() => (pageShown = document.visibilityState === "visible")} />

<div class="quoted-map" data-testid="reference-map" data-state={phase} {@attach watchWidth} {@attach watchSight}>
    {#if phase === "text"}
        {@render children()}
    {:else}
        <!-- The picture's own shape, so the box the picture arrives in is the size it will be. -->
        <div class="quoted-map__frame" style:aspect-ratio={size ? `${size.width} / ${size.height}` : "16 / 9"}>
            {#if shown}
                <img class="quoted-map__picture" {alt} data-testid="reference-map-picture" {@attach showPicture(shown.picture)} />
            {:else if slow}
                <span class="quoted-map__note">Drawing map…</span>
            {/if}
        </div>
        {#if empty}
            <p class="quoted-map__note quoted-map__caption" data-testid="reference-map-note">No places yet</p>
        {:else if shown && !shown.basemap}
            <p class="quoted-map__note quoted-map__caption" data-testid="reference-map-note">The map's background couldn't be loaded.</p>
        {/if}
    {/if}
</div>

<style>
    .quoted-map {
        margin: 0.2rem 0;
    }
    /* The code panel's shade and corners (QuotedCode.svelte), behind a picture still being drawn. */
    .quoted-map__frame {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        overflow: hidden;
        border-radius: 5px;
        background: var(--gk-code-bg, rgba(127, 127, 127, 0.1));
    }
    /* Fills the frame: during a resize, until the picture at the new width arrives, it stretches
       with the card and is cropped to the frame's shape rather than squashed. */
    .quoted-map__picture {
        position: absolute;
        inset: 0;
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
    .quoted-map__note {
        color: var(--gk-text-muted, #6b7280);
    }
    .quoted-map__caption {
        margin: 0.25em 0 0;
    }
</style>
