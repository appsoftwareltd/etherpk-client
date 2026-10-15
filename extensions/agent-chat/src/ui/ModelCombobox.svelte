<script lang="ts" module>
    export interface ModelChoice {
        /** What `value` and `onChange` carry. */
        key: string;
        label: string;
        /** Said after the name, such as "text only". */
        note?: string;
        /** The id, matched by the filter as well as the name. */
        id: string;
    }

    export interface ModelGroup {
        key: string;
        /** Shown above the group's models; none for a single group. */
        label: string | null;
        status: "loading" | "ready" | "failed";
        models: readonly ModelChoice[];
    }
</script>

<script lang="ts">
    /**
     * Choosing a model from what may be hundreds (OpenRouter lists several hundred), drawn as the
     * app's own control: a field that shows the model chosen, and filters the list as the person
     * types, every word matching the model's name or id. The list opens in the top layer, so an
     * inline panel's edges never clip it (`floating.ts`), grouped by connection where there are
     * several. The keyboard stays in the field: the arrows move through the matches, Enter chooses,
     * Escape closes and keeps the model chosen before. With `allowCustom`, what was typed can be
     * used as a model ID the list does not name, such as a model the provider has not listed yet.
     */
    import { onDestroy } from "svelte";

    import { onPressOutside, placeAgainst, POPUP_CLASSES } from "./floating";

    const {
        groups,
        value,
        onChange,
        id,
        disabled = false,
        invalid = false,
        describedBy,
        placeholder = "Choose a model",
        allowCustom = false,
        testid,
        class: className = "",
    }: {
        groups: readonly ModelGroup[];
        value: string;
        onChange: (key: string) => void;
        /** The field's id, which its visible `<label for>` names. */
        id: string;
        disabled?: boolean;
        invalid?: boolean;
        describedBy?: string;
        placeholder?: string;
        /** Offer what was typed as a model ID of its own, carried as the key. */
        allowCustom?: boolean;
        testid?: string;
        class?: string;
    } = $props();

    const listId = $props.id();
    let open = $state(false);
    let query = $state("");
    let active = $state(0);
    let field = $state<HTMLInputElement | null>(null);
    let popup = $state<HTMLElement | null>(null);
    let placement: { stop(): void } | null = null;
    let stopOutside: (() => void) | null = null;

    const listed = $derived(groups.flatMap((group) => group.models));
    /** The model chosen: one of the list, or with `allowCustom` an ID the list does not name. */
    const selected = $derived(listed.find((model) => model.key === value) ?? (allowCustom && value !== "" ? { key: value, label: value, id: value } : null));

    /** The connection a model is reached through, named where there are several. */
    const groupOf = $derived(new Map(groups.flatMap((group) => group.models.map((model) => [model.key, group.label] as const))));
    /** The field's text while closed: the model, and its connection where there are several. */
    const shownLabel = $derived(selected ? (groupOf.get(selected.key) ? `${selected.label} (${groupOf.get(selected.key)})` : selected.label) : "");

    /** Every word of the filter is in the model's name or id, or its connection's name, ignoring case. */
    const words = $derived(query.toLowerCase().split(/\s+/).filter(Boolean));
    const shown = $derived(
        groups.map((group) => ({
            ...group,
            models: group.models.filter((model) => words.every((word) => model.label.toLowerCase().includes(word) || model.id.toLowerCase().includes(word) || (group.label?.toLowerCase().includes(word) ?? false))),
        })),
    );
    /** What was typed, offered as a model ID when no listed model has that ID. */
    const custom = $derived.by<ModelChoice | null>(() => {
        const typed = query.trim();
        if (!allowCustom || typed === "" || listed.some((model) => model.id === typed)) return null;
        return { key: typed, label: `Use "${typed}" as the model ID`, id: typed };
    });
    /** The matches in order, then the typed ID, which the arrows move through. */
    const flat = $derived([...shown.flatMap((group) => group.models), ...(custom ? [custom] : [])]);
    const loading = $derived(groups.some((group) => group.status === "loading"));

    function show() {
        if (disabled || open || !popup || !field) return;
        query = "";
        open = true;
        active = Math.max(0, flat.findIndex((model) => model.key === value));
        popup.showPopover();
        placement = placeAgainst(field, popup);
        stopOutside = onPressOutside(() => [field, popup], () => hide());
        scrollActive();
    }

    function hide() {
        if (!open) return;
        open = false;
        query = "";
        placement?.stop();
        stopOutside?.();
        placement = stopOutside = null;
        if (popup?.matches(":popover-open")) popup.hidePopover();
    }

    function choose(model: ModelChoice) {
        if (model.key !== value) onChange(model.key);
        hide();
        field?.focus();
    }

    function scrollActive() {
        requestAnimationFrame(() => popup?.querySelector(`#${CSS.escape(`${listId}-${active}`)}`)?.scrollIntoView({ block: "nearest" }));
    }

    function move(to: number) {
        if (flat.length === 0) return;
        active = Math.max(0, Math.min(flat.length - 1, to));
        scrollActive();
    }

    function onInput(event: Event) {
        query = (event.currentTarget as HTMLInputElement).value;
        if (!open) show();
        active = 0;
        // Placed again: the list is shorter or longer now.
        requestAnimationFrame(() => field && popup && open && placement && (placement.stop(), (placement = placeAgainst(field, popup))));
    }

    function onKeydown(event: KeyboardEvent) {
        if (disabled) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) show();
            else move(active + (event.key === "ArrowDown" ? 1 : -1));
        } else if (event.key === "Enter" && open) {
            event.preventDefault();
            const model = flat[active];
            if (model) choose(model);
        } else if (event.key === "Escape" && open) {
            // The list closes, and nothing around it (a dialog, a form) hears the key.
            event.preventDefault();
            event.stopPropagation();
            hide();
        } else if (event.key === "Tab") hide();
    }

    onDestroy(() => hide());

    /** The index in `flat` of a group's model, for its id and the active highlight. */
    function indexOf(model: ModelChoice): number {
        return flat.indexOf(model);
    }
</script>

<div class="relative min-w-0 {className}" data-testid={testid} data-value={value}>
    <input
        bind:this={field}
        {id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && flat.length > 0 ? `${listId}-${active}` : undefined}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        aria-disabled={disabled}
        readonly={disabled}
        autocomplete="off"
        spellcheck="false"
        value={open ? query : shownLabel}
        title={open ? undefined : shownLabel}
        placeholder={open ? (allowCustom ? "Type to filter, or type a model ID" : "Type to filter models") : placeholder}
        onclick={show}
        oninput={onInput}
        onkeydown={onKeydown}
        class="w-full min-w-0 truncate rounded-md border border-(--gk-border-soft) bg-(--gk-surface-0) py-1 pr-7 pl-2.5 text-sm text-(--gk-text-default) placeholder:text-(--gk-text-subtle) hover:border-(--gk-border-strong) focus:border-(--gk-border-strong) focus-visible:outline-2 focus-visible:outline-(--gk-accent) aria-disabled:cursor-not-allowed aria-disabled:text-(--gk-text-subtle) aria-invalid:border-(--gk-text-danger) pointer-coarse:min-h-11"
        data-testid={testid ? `${testid}-input` : undefined}
    />
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="pointer-events-none absolute top-1/2 right-1.5 size-4 -translate-y-1/2 text-(--gk-text-muted)">
        <path
            fill-rule="evenodd"
            d="M10.53 3.47a.75.75 0 0 0-1.06 0L6.22 6.72a.75.75 0 0 0 1.06 1.06L10 5.06l2.72 2.72a.75.75 0 1 0 1.06-1.06l-3.25-3.25Zm-4.31 9.81 3.25 3.25a.75.75 0 0 0 1.06 0l3.25-3.25a.75.75 0 1 0-1.06-1.06L10 14.94l-2.72-2.72a.75.75 0 0 0-1.06 1.06Z"
            clip-rule="evenodd"
        />
    </svg>
    <!-- The press that chooses never takes the keyboard from the field. -->
    <div bind:this={popup} popover="manual" id={listId} role="listbox" tabindex="-1" aria-label="Models" class={POPUP_CLASSES} onpointerdown={(event) => event.preventDefault()} data-testid={testid ? `${testid}-list` : undefined}>
        {#each shown as group (group.key)}
            {#if group.models.length > 0 || group.status !== "ready"}
                <div role="group" aria-label={group.label ?? "Models"}>
                    {#if group.label}
                        <!-- Kept in view while the group scrolls, so the connection a model is reached through is always named. -->
                        <p class="sticky -top-1 z-10 -mx-1 bg-(--gk-surface-1) px-3 pt-2 pb-1 text-sm font-medium text-(--gk-text-muted)" aria-hidden="true">{group.label}</p>
                    {/if}
                    {#each group.models as model (model.key)}
                        {@const index = indexOf(model)}
                        <button
                            type="button"
                            tabindex="-1"
                            id={`${listId}-${index}`}
                            role="option"
                            aria-selected={model.key === value}
                            onclick={() => choose(model)}
                            onpointermove={() => (active = index)}
                            class={[
                                "flex w-full items-center gap-2 rounded-md py-1.5 pr-2 pl-2 text-left text-sm pointer-coarse:min-h-11",
                                index === active && "bg-(--gk-surface-2)",
                                model.key === value ? "font-medium text-(--gk-text-strong)" : "text-(--gk-text-default)",
                            ]}
                            data-testid="model-option"
                        >
                            <span class="min-w-0 flex-1 truncate">{model.label}{#if model.note}<span class="text-(--gk-text-muted)"> ({model.note})</span>{/if}</span>
                            {#if model.key === value}
                                <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="size-4 shrink-0 text-(--gk-accent)">
                                    <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clip-rule="evenodd" />
                                </svg>
                            {/if}
                        </button>
                    {/each}
                    {#if group.status === "loading" && group.models.length === 0}
                        <p class="px-2 py-1.5 text-sm text-(--gk-text-muted)" role="presentation">Loading models…</p>
                    {:else if group.status === "failed" && group.models.length === 0}
                        <p class="px-2 py-1.5 text-sm text-(--gk-text-muted)" role="presentation">The models could not be listed.</p>
                    {/if}
                </div>
            {/if}
        {/each}
        {#if custom}
            {@const index = flat.length - 1}
            <button
                type="button"
                tabindex="-1"
                id={`${listId}-${index}`}
                role="option"
                aria-selected="false"
                onclick={() => choose(custom)}
                onpointermove={() => (active = index)}
                class={["flex w-full items-center gap-2 rounded-md py-1.5 pr-2 pl-2 text-left text-sm text-(--gk-text-default) pointer-coarse:min-h-11", index === active && "bg-(--gk-surface-2)"]}
                data-testid="model-option-custom"
            >
                <span class="min-w-0 flex-1 truncate">{custom.label}</span>
            </button>
        {/if}
        {#if listed.length === 0 && !loading && query.trim() === ""}
            <p class="px-2 py-1.5 text-sm text-(--gk-text-muted)" role="presentation">No models listed yet.{allowCustom ? " Type a model ID." : ""}</p>
        {/if}
        {#if flat.length === 0 && !loading && query.trim() !== ""}
            <p class="px-2 py-1.5 text-sm text-(--gk-text-muted)" role="presentation" data-testid="model-no-match">No model matches "{query.trim()}".</p>
        {/if}
    </div>
</div>
