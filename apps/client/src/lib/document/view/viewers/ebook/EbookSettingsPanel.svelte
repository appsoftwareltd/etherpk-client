<script lang="ts">
    /** The text settings of an EBook: one set for this device, which every EBook takes. Changes show at once. */
    import { DEFAULT_EBOOK_SETTINGS, LINE_HEIGHT_RANGE, MARGIN_RANGE, type EbookFont, type EbookPageTheme } from "#lib/document/ebook/ebook-settings.js";
    import { iconSvg } from "#lib/surface/icons.js";

    import type { EbookReader } from "./ebook-reader.svelte";

    let { reader, above, onclose }: { reader: EbookReader; above: boolean; onclose: () => void } = $props();

    const settings = $derived(reader.settings);

    const FONTS: { value: EbookFont; label: string }[] = [
        { value: "original", label: "Original" },
        { value: "serif", label: "Serif" },
        { value: "sans", label: "Sans" },
        { value: "literata", label: "Literata" },
        { value: "atkinson", label: "Atkinson" },
    ];
    const THEMES: { value: EbookPageTheme; label: string }[] = [
        { value: "app", label: "As the app" },
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
    ];

    const stepped = (value: number, step: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round((value + step) * 100) / 100));
    const segment = (on: boolean) => `flex-1 rounded-md px-2 py-1 text-sm ${on ? "bg-(--gk-surface-2) font-medium text-(--gk-text-strong)" : "text-(--gk-text-default) hover:bg-(--gk-surface-2)"}`;
    const dirty = $derived(JSON.stringify(settings) !== JSON.stringify(DEFAULT_EBOOK_SETTINGS));
</script>

{#snippet stepper(label: string, shown: string, testId: string, lower: () => void, raise: () => void)}
    <div class="flex items-center gap-2 px-2 py-1 text-sm text-(--gk-text-default)" data-testid={testId}>
        <span class="flex-1">{label}</span>
        <button type="button" class="ebook-tool" aria-label={`${label}: less`} onclick={lower} data-testid={`${testId}-less`}>
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
            {@html iconSvg("zoom-out")}
        </button>
        <span class="w-12 text-center text-(--gk-text-muted)" aria-live="polite" data-testid={`${testId}-value`}>{shown}</span>
        <button type="button" class="ebook-tool" aria-label={`${label}: more`} onclick={raise} data-testid={`${testId}-more`}>
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
            {@html iconSvg("zoom-in")}
        </button>
    </div>
{/snippet}

{#snippet check(label: string, checked: boolean, testId: string, onchange: (next: boolean) => void)}
    <label class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)">
        <input type="checkbox" {checked} onchange={(event) => onchange(event.currentTarget.checked)} data-testid={testId} />
        {label}
    </label>
{/snippet}

<div class="relative h-0 shrink-0">
    <div class={["etherpk-ebook-menu flex flex-col gap-0.5 rounded-lg border border-(--gk-surface-2) bg-(--gk-surface-0) p-1 shadow-lg", above && "etherpk-ebook-menu--above"]} role="group" aria-label="Text settings" data-testid="ebook-settings">
        <div class="flex items-center justify-between">
            <span class="px-2 text-sm font-medium text-(--gk-text-muted)">Text</span>
            <button type="button" class="ebook-tool" aria-label="Close text settings" title="Close text settings" onclick={onclose} data-testid="ebook-settings-close">
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                {@html iconSvg("close")}
            </button>
        </div>
        {#if reader.fixedLayout}
            <!-- A fixed-layout EBook's pages are pictures of pages, so size is all there is to set. -->
            {@render stepper("Zoom", reader.fixedZoom === "fit-page" ? "Fit" : `${Math.round(reader.fixedZoom * 100)}%`, "ebook-zoom", () => reader.textSmaller(), () => reader.textLarger())}
            <button type="button" class="rounded-lg px-2 py-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)" onclick={() => reader.zoomToFit()} data-testid="ebook-zoom-fit">Fit the page</button>
        {:else}
        {@render stepper("Size", `${settings.fontSize}px`, "ebook-font-size", () => reader.textSmaller(), () => reader.textLarger())}
        {@render stepper(
            "Line spacing",
            settings.lineHeight.toFixed(1),
            "ebook-line-height",
            () => reader.updateSettings({ lineHeight: stepped(settings.lineHeight, -LINE_HEIGHT_RANGE.step, LINE_HEIGHT_RANGE.min, LINE_HEIGHT_RANGE.max) }),
            () => reader.updateSettings({ lineHeight: stepped(settings.lineHeight, LINE_HEIGHT_RANGE.step, LINE_HEIGHT_RANGE.min, LINE_HEIGHT_RANGE.max) }),
        )}
        {@render stepper(
            "Margins",
            `${settings.margin}px`,
            "ebook-margin",
            () => reader.updateSettings({ margin: stepped(settings.margin, -MARGIN_RANGE.step, MARGIN_RANGE.min, MARGIN_RANGE.max) }),
            () => reader.updateSettings({ margin: stepped(settings.margin, MARGIN_RANGE.step, MARGIN_RANGE.min, MARGIN_RANGE.max) }),
        )}
        <div class="px-2 py-1" role="group" aria-label="Font">
            <span class="text-sm text-(--gk-text-default)">Font</span>
            <div class="mt-1 grid grid-cols-3 gap-1">
                {#each FONTS as { value, label } (value)}
                    <button type="button" class={segment(settings.font === value)} aria-pressed={settings.font === value} onclick={() => reader.updateSettings({ font: value })} data-testid={`ebook-font-${value}`}>{label}</button>
                {/each}
            </div>
        </div>
        {/if}
        <div class="px-2 py-1" role="group" aria-label="Page colour">
            <span class="text-sm text-(--gk-text-default)">Pages</span>
            <div class="mt-1 flex gap-1">
                {#each THEMES as { value, label } (value)}
                    <button type="button" class={segment(settings.theme === value)} aria-pressed={settings.theme === value} onclick={() => reader.updateSettings({ theme: value })} data-testid={`ebook-theme-${value}`}>{label}</button>
                {/each}
            </div>
        </div>
        {#if !reader.fixedLayout}
            {@render check("Justify the text", settings.justify, "ebook-justify", (next) => reader.updateSettings({ justify: next }))}
            {@render check("Break long words", settings.hyphenate, "ebook-hyphenate", (next) => reader.updateSettings({ hyphenate: next }))}
        {/if}
        {@render check("Two pages where there is room", settings.twoPages, "ebook-two-pages", (next) => reader.updateSettings({ twoPages: next }))}
        <button type="button" class="rounded-lg px-2 py-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2) disabled:text-(--gk-text-muted)" disabled={!dirty} onclick={() => reader.updateSettings(DEFAULT_EBOOK_SETTINGS)} data-testid="ebook-settings-reset">Back to the defaults</button>
    </div>
</div>

<style>
    /* Over the pages, so changing a setting moves only the text. */
    .etherpk-ebook-menu {
        position: absolute;
        top: 0.25rem;
        right: 0.5rem;
        z-index: 20;
        width: min(20rem, calc(100% - 1rem));
        max-height: 70dvh;
        overflow-y: auto;
    }
    .etherpk-ebook-menu--above {
        top: auto;
        bottom: 0.25rem;
    }
</style>
