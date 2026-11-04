<script lang="ts">
    /**
     * Make a signature: drawn on a pad that takes a finger, typed, or from a picture. It places a picture
     * on the page, with no certificate behind it, and the dialog says so. The last one made is always
     * remembered, in the person's own settings and never in the graph (`signature-store.ts`).
     */
    import Dialog from "@appsoftwareltd/etherpk-shared/dialog";

    import { createStreamline, pressureWidth, type Streamline } from "#lib/document/pdf/pdf-geometry.js";
    import { loadRememberedSignature, rememberSignature, forgetSignature } from "#lib/document/pdf/signature-store.js";
    import { iconSvg } from "#lib/surface/icons.js";

    let {
        open,
        usePressure,
        onclose,
        onplace,
    }: { open: boolean; usePressure: boolean; onclose: () => void; onplace: (blob: Blob, aspect: number) => void } = $props();

    type Mode = "draw" | "type" | "image";
    let mode = $state<Mode>("draw");
    let typed = $state("");
    let remembered = $state<{ url: string; blob: Blob } | null>(null);
    let error = $state("");
    let hasInk = $state(false);
    let canvas = $state<HTMLCanvasElement>();
    let imageBlob = $state<Blob | null>(null);
    /** The chosen picture's file name, shown beside the button. */
    const imageName = $derived(imageBlob instanceof File ? imageBlob.name : "");

    $effect(() => {
        if (!open) return;
        let live = true;
        void loadRememberedSignature().then((blob) => {
            if (live && blob) remembered = { blob, url: URL.createObjectURL(blob) };
        });
        return () => {
            live = false;
            if (remembered) URL.revokeObjectURL(remembered.url);
            remembered = null;
        };
    });

    /** A line's width on screen. The bitmap's own width follows from the pad's scale. */
    const INK_WIDTH_PX = 2.5;
    /** At least twice the screen's pixels, because a signature is printed far finer than it is drawn. */
    const MIN_PAD_SCALE = 2;
    /** Above this, the picture is too large to remember (signature-store.ts) without looking any better. */
    const MAX_PAD_SCALE = 3;

    let drawing = false;
    /** The last point the pointer reached, which steers the next curve. */
    let last: [number, number] | null = null;
    /** Where the ink has been drawn up to: halfway to `last`. */
    let inkEnd: [number, number] | null = null;
    /** Where the pointer really is, which the steadied line trails. */
    let reached: [number, number] | null = null;
    let steady: Streamline | null = null;
    let lastPressure: number | null = null;

    /** Sized when it appears, because a bitmap stretched to fit is what makes a line look rough. */
    const fitPad = (pad: HTMLCanvasElement) => {
        const scale = Math.min(MAX_PAD_SCALE, Math.max(MIN_PAD_SCALE, window.devicePixelRatio || 1));
        if (pad.clientWidth > 0 && pad.clientHeight > 0) {
            pad.width = Math.round(pad.clientWidth * scale);
            pad.height = Math.round(pad.clientHeight * scale);
        }
        // Coming back to this tab starts a new, empty pad.
        hasInk = false;
    };

    const pointOf = (event: PointerEvent): [number, number] => {
        const box = canvas!.getBoundingClientRect();
        return [((event.clientX - box.left) / box.width) * canvas!.width, ((event.clientY - box.top) / box.height) * canvas!.height];
    };

    function inkOf(pad: HTMLCanvasElement, pressure: number | null): CanvasRenderingContext2D | null {
        const ctx = pad.getContext("2d");
        if (!ctx) return null;
        const scale = pad.width / (pad.clientWidth || pad.width);
        ctx.lineWidth = (pressure === null ? INK_WIDTH_PX : pressureWidth(INK_WIDTH_PX, pressure)) * scale;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#111827";
        return ctx;
    }

    /** The stylus's pressure at this point, when it has one and the person wants it. */
    const pressureOf = (event: PointerEvent) => (usePressure && event.pointerType === "pen" ? event.pressure : null);

    function padDown(event: PointerEvent) {
        event.preventDefault();
        canvas?.setPointerCapture(event.pointerId);
        drawing = true;
        // About one pixel on screen.
        steady = createStreamline(canvas ? canvas.width / (canvas.clientWidth || canvas.width) : 1);
        last = inkEnd = reached = steady.next(...pointOf(event));
        lastPressure = pressureOf(event);
    }

    function padMove(event: PointerEvent) {
        if (!drawing || !canvas) return;
        const events = event.getCoalescedEvents?.() ?? [];
        for (const each of events.length > 0 ? events : [event]) addInk(canvas, each);
        hasInk = true;
    }

    function addInk(pad: HTMLCanvasElement, event: PointerEvent) {
        reached = pointOf(event);
        const next = steady?.next(reached[0], reached[1]);
        if (!next) return;
        const pressure = pressureOf(event);
        lastPressure = pressure === null || lastPressure === null ? pressure : lastPressure + (pressure - lastPressure) * 0.3;
        const ctx = inkOf(pad, lastPressure);
        if (!ctx) return;
        // A curve through the point halfway to each new one, so the line has no corners to show.
        const middle: [number, number] = [(last![0] + next[0]) / 2, (last![1] + next[1]) / 2];
        ctx.beginPath();
        ctx.moveTo(inkEnd![0], inkEnd![1]);
        ctx.quadraticCurveTo(last![0], last![1], middle[0], middle[1]);
        ctx.stroke();
        last = [next[0], next[1]];
        inkEnd = middle;
    }

    function padUp() {
        // The stretch from the last curve's end to where the pointer stopped, which is a dot on a tap.
        const ctx = drawing && canvas && reached && inkEnd ? inkOf(canvas, lastPressure) : null;
        if (ctx) {
            ctx.beginPath();
            ctx.moveTo(inkEnd![0], inkEnd![1]);
            ctx.lineTo(reached![0], reached![1]);
            ctx.stroke();
            hasInk = true;
        }
        drawing = false;
        last = inkEnd = reached = null;
    }

    function clearPad() {
        canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
        hasInk = false;
    }

    function toBlob(source: HTMLCanvasElement): Promise<Blob> {
        return new Promise((resolve, reject) => source.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no picture"))), "image/png"));
    }

    /** A typed name, drawn large on a transparent picture. */
    async function typedPicture(): Promise<Blob> {
        const picture = document.createElement("canvas");
        const size = 72;
        const ctx = picture.getContext("2d")!;
        const font = `italic ${size}px Georgia, "Times New Roman", serif`;
        ctx.font = font;
        picture.width = Math.ceil(ctx.measureText(typed).width) + 24;
        picture.height = Math.ceil(size * 1.5);
        ctx.font = font;
        ctx.fillStyle = "#111827";
        ctx.textBaseline = "middle";
        ctx.fillText(typed, 12, picture.height / 2);
        return toBlob(picture);
    }

    /** Any picture to PNG, because the saved copy can embed PNG. */
    async function toPng(source: Blob): Promise<Blob> {
        const bitmap = await createImageBitmap(source);
        const picture = document.createElement("canvas");
        // Large enough to print sharply, and small enough to remember.
        const fit = Math.min(1, 600 / bitmap.width);
        picture.width = Math.round(bitmap.width * fit);
        picture.height = Math.round(bitmap.height * fit);
        picture.getContext("2d")!.drawImage(bitmap, 0, 0, picture.width, picture.height);
        bitmap.close();
        return toBlob(picture);
    }

    async function pictureFor(): Promise<Blob | null> {
        if (mode === "draw") return hasInk && canvas ? toBlob(canvas) : null;
        if (mode === "type") return typed.trim() === "" ? null : typedPicture();
        return imageBlob ? toPng(imageBlob) : null;
    }

    async function place(blob: Blob) {
        const bitmap = await createImageBitmap(blob);
        const aspect = bitmap.width / Math.max(1, bitmap.height);
        bitmap.close();
        onplace(blob, aspect);
    }

    async function submit() {
        error = "";
        try {
            const blob = await pictureFor();
            if (!blob) {
                error = mode === "draw" ? "Draw your signature first." : mode === "type" ? "Type your name first." : "Choose a picture first.";
                return;
            }
            await rememberSignature(blob);
            await place(blob);
        } catch {
            error = "That could not be used as a signature. Try another picture.";
        }
    }

    async function forget() {
        await forgetSignature();
        if (remembered) URL.revokeObjectURL(remembered.url);
        remembered = null;
    }

    const tabClass = (on: boolean) =>
        `rounded-lg px-2.5 py-1 text-sm ${on ? "bg-(--gk-surface-2) font-medium text-(--gk-text-strong)" : "text-(--gk-text-default) hover:bg-(--gk-surface-1)"}`;
</script>

<Dialog {open} title="Add your signature" {onclose} size="md" testId="pdf-signature-dialog">
    {#snippet body()}
    <div class="flex flex-col gap-3">
        <p class="text-sm text-(--gk-text-muted)">
            This places a picture of your signature on the page. It has no certificate behind it, so it does not prove who signed.
        </p>
        {#if remembered}
            <div class="flex items-center gap-3 rounded-lg border border-(--gk-surface-2) p-2">
                <img src={remembered.url} alt="Your remembered signature" class="h-12 max-w-40 object-contain" />
                <button type="button" class="rounded-lg border border-gray-300 px-2.5 py-1 text-sm dark:border-gray-700" onclick={() => place(remembered!.blob)} data-testid="pdf-signature-use-remembered">Use this</button>
                <button type="button" class="rounded-lg px-2.5 py-1 text-sm text-(--gk-text-default) hover:bg-(--gk-surface-1)" onclick={forget} data-testid="pdf-signature-forget">Forget it</button>
            </div>
        {/if}
        <div class="flex gap-1" role="group" aria-label="How to make your signature">
            <button type="button" class={tabClass(mode === "draw")} aria-pressed={mode === "draw"} onclick={() => (mode = "draw")}>Draw</button>
            <button type="button" class={tabClass(mode === "type")} aria-pressed={mode === "type"} onclick={() => (mode = "type")} data-testid="pdf-signature-type-tab">Type</button>
            <button type="button" class={tabClass(mode === "image")} aria-pressed={mode === "image"} onclick={() => (mode = "image")}>Picture</button>
        </div>
        {#if mode === "draw"}
            <canvas
                bind:this={canvas}
                {@attach fitPad}
                class="h-36 w-full touch-none rounded-lg border border-gray-300 dark:border-gray-700"
                style:background-color="#ffffff"
                aria-label="Draw your signature here"
                onpointerdown={padDown}
                onpointermove={padMove}
                onpointerup={padUp}
                onpointercancel={padUp}
                data-testid="pdf-signature-pad"
            ></canvas>
            <div><button type="button" class="rounded-lg px-2.5 py-1 text-sm text-(--gk-text-default) hover:bg-(--gk-surface-1)" onclick={clearPad}>Clear</button></div>
        {:else if mode === "type"}
            <label class="flex flex-col gap-1 text-sm font-medium text-(--gk-text-default)">
                Your name
                <input type="text" autocomplete="off" class="rounded-lg border border-gray-300 bg-(--gk-surface-0) px-2 py-1.5 text-sm font-normal dark:border-gray-700" bind:value={typed} data-testid="pdf-signature-typed" />
            </label>
        {:else}
            <div class="flex flex-wrap items-center gap-3">
                <!-- The native control's own button reads as plain text in the dark theme. -->
                <label class="etherpk-pdf-picture-button inline-flex cursor-pointer items-center gap-2 rounded-lg bg-(--gk-text-strong) px-3 py-1.5 text-sm font-medium text-(--gk-surface-0)">
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                    {@html iconSvg("image", { size: 16 })}
                    Choose a picture
                    <input type="file" accept="image/png,image/jpeg,image/webp" class="sr-only" onchange={(event) => (imageBlob = event.currentTarget.files?.[0] ?? null)} data-testid="pdf-signature-file" />
                </label>
                <span class="text-sm text-(--gk-text-muted)" data-testid="pdf-signature-file-name">{imageName || "No picture chosen"}</span>
            </div>
        {/if}
        <p class="text-sm text-(--gk-text-muted)" data-testid="pdf-signature-kept">EtherPK remembers your signature in your own settings, not in the graph, so other members are not shown it.</p>
        {#if error}<p class="text-sm text-red-700 dark:text-red-400" role="alert" data-testid="pdf-signature-error">{error}</p>{/if}
    </div>
    {/snippet}
    {#snippet footer()}
        <div class="flex justify-end gap-2">
            <button type="button" class="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium dark:border-gray-700" onclick={onclose}>Cancel</button>
            <button type="button" class="rounded-lg bg-(--gk-accent) px-3 py-1.5 text-sm font-medium text-(--gk-surface-0) hover:bg-(--gk-accent-hover)" onclick={submit} data-testid="pdf-signature-place">Place on the page</button>
        </div>
    {/snippet}
</Dialog>

<style>
    .etherpk-pdf-picture-button:focus-within {
        outline: 2px solid var(--gk-accent);
        outline-offset: 2px;
    }
</style>
