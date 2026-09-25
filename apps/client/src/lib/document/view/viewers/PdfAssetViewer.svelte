<script lang="ts">
    /**
     * The first-party PDF viewer: every page rendered to a canvas, scrolled continuously.
     *
     * Drawn by the app rather than framed — see ADR 0055. `object-src: 'none'` blocks
     * `<embed>`/`<object>` outright, frames fall back to `default-src: 'self'` so a `blob:` is
     * refused, and widening that would let a content-sniffed blob run as this app's origin.
     *
     * Pages are rendered once at the width the tab happens to be, and re-rendered when that
     * width changes. Nothing is virtualised: a knowledge-base PDF is a report, not a book, and
     * the complexity of windowing is not yet earned. If very long documents turn up, this is
     * where paging would go.
     */
    import type { AssetViewerProps } from "$lib/surface";

    import { fitScale, openPdf, renderPage, type PdfDocument } from "./pdf-render";

    let { url, name }: AssetViewerProps = $props();

    let container = $state<HTMLDivElement>();
    let width = $state(0);
    let pdf = $state<PdfDocument | null>(null);
    let error = $state<string | null>(null);
    /** Bumped after each render pass, purely so the page count can be announced once ready. */
    let rendered = $state(0);

    // Opening the document is an external effect (a worker starts, bytes are parsed) and must
    // re-run when the tab is pointed at a different file.
    $effect(() => {
        const source = url;
        let live = true;
        pdf = null;
        error = null;
        void openPdf(source)
            .then((document) => {
                if (live) pdf = document;
                else void document.destroy();
            })
            .catch(() => {
                if (live) error = "This file could not be opened as a PDF.";
            });
        return () => {
            live = false;
        };
    });

    // Destroy the document when the tab goes, so pdf.js releases its worker and buffers.
    $effect(() => {
        const open = pdf;
        return () => {
            void open?.destroy();
        };
    });

    // Draw every page at the current width. Re-runs when the document or the width changes;
    // `generation` lets a superseded pass abandon its canvases mid-render rather than paint
    // over a newer one.
    let generation = 0;
    $effect(() => {
        const document = pdf;
        const available = width;
        const host = container;
        if (!document || !host || available <= 0) return;
        const mine = ++generation;

        void (async () => {
            const canvases: HTMLCanvasElement[] = [];
            for (let n = 1; n <= document.numPages; n++) {
                const page = await document.getPage(n);
                if (mine !== generation) return;
                const canvas = window.document.createElement("canvas");
                canvas.className = "pdf-page";
                canvas.setAttribute("data-page", String(n));
                canvases.push(canvas);
                // Padding either side, so a page is not flush against the tab edges.
                await renderPage(page, canvas, fitScale(page.getViewport({ scale: 1 }).width, available - 32));
                if (mine !== generation) return;
                // Swap in only once the first page is drawn, so the tab never flashes empty.
                if (n === 1) host.replaceChildren();
                host.appendChild(canvas);
            }
            if (mine === generation) rendered = document.numPages;
        })();

        return () => {
            if (mine === generation) generation++;
        };
    });
</script>

<div class="flex h-full flex-col" data-testid="pdf-asset-viewer" data-pages={rendered || undefined}>
    {#if error}
        <div class="flex flex-1 items-center justify-center p-6 text-center">
            <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="pdf-asset-error">{error}</p>
        </div>
    {:else}
        {#if !pdf}
            <p class="p-6 text-center text-sm text-gray-500 dark:text-gray-400" role="status">
                Opening {name}…
            </p>
        {/if}
        <div
            class="flex flex-1 flex-col items-center gap-4 overflow-auto p-4"
            bind:this={container}
            bind:clientWidth={width}
        ></div>
    {/if}
</div>

<style>
    /* The canvases are created imperatively by the render pass, so their rule is global. */
    div :global(.pdf-page) {
        max-width: 100%;
        border-radius: 3px;
        box-shadow: var(--gk-shadow, 0 1px 4px rgb(0 0 0 / 0.25));
        background: white;
    }
</style>
