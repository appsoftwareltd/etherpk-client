<script lang="ts">
    /**
     * A filter box: a `gk-input` with the filter icon inside its start and, while it holds text, a
     * clear button inside its end. Every box that narrows a list of tasks draws with it, so they look
     * and behave alike: the Tasks View's concept and text boxes and a Kanban Board's.
     *
     * Any input attribute passes through to the input (`role`, `aria-*`, `placeholder`, `data-*`,
     * key and focus handlers), so a combobox is this box with its own attributes and its list given as
     * `children`, drawn under the input. The box reports typing through `ontext` and leaves what that
     * means to its owner, which also decides what clearing does (`onclear`).
     */
    import type { Snippet } from "svelte";
    import type { HTMLInputAttributes } from "svelte/elements";

    import { iconSvg } from "#lib/surface/icons.js";

    let {
        value,
        ontext,
        onclear,
        clearLabel,
        clearTestid,
        input = $bindable(),
        class: className,
        phone = false,
        children,
        ...attributes
    }: Omit<HTMLInputAttributes, "value" | "class" | "oninput" | "type"> & {
        /** What the box shows. */
        value: string;
        /** The text as typed, on every keystroke. */
        ontext: (text: string) => void;
        /** Clear the filter. With it, a clear button shows while the box holds text. */
        onclear?: () => void;
        /** The clear button's accessible name and tooltip. */
        clearLabel?: string;
        clearTestid?: string;
        /** The input element, for an owner that moves the keyboard to it. */
        input?: HTMLInputElement;
        /** Classes for the box's wrapper, which sizes it in its row. */
        class?: string;
        /** A phone's input is 16px, because iOS Safari zooms the page to a smaller field as it takes focus. */
        phone?: boolean;
        /** Drawn under the input, inside the box's wrapper: a combobox's list. */
        children?: Snippet;
    } = $props();

    const clearable = $derived(onclear !== undefined && value !== "");
</script>

<div class={["relative", className]}>
    <!-- In-repo constant markup from the icon table, never user content. -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- iconSvg returns trusted markup from the Client's icon table (ADR 0130) -->
    <span class="pointer-events-none absolute top-1/2 left-2.5 inline-flex size-4 -translate-y-1/2 text-(--gk-text-subtle)" data-icon="filter" aria-hidden="true">{@html iconSvg("filter")}</span>
    <input
        bind:this={input}
        type="text"
        autocomplete="off"
        {...attributes}
        class={["gk-input w-full pl-8", clearable && "pr-9", phone && "text-base"]}
        {value}
        oninput={(event) => ontext(event.currentTarget.value)}
    />
    {#if clearable}
        <button
            type="button"
            onclick={onclear}
            class="gk-icon-button absolute top-1/2 right-0.5 -translate-y-1/2"
            aria-label={clearLabel ?? "Clear the filter"}
            data-tooltip={clearLabel ?? "Clear the filter"}
            data-testid={clearTestid}
        >
            <!-- In-repo constant markup from the icon table, never user content. -->
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- iconSvg returns trusted markup from the Client's icon table (ADR 0130) -->
            {@html iconSvg("close")}
        </button>
    {/if}
    {@render children?.()}
</div>
