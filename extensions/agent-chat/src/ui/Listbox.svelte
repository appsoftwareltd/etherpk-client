<script lang="ts" generics="T extends string">
    /**
     * A choice of a few options, drawn as the app's own control rather than the browser's: a button
     * showing the choice, and a list that opens beneath it in the top layer, so an inline panel's
     * edges never clip it (`floating.ts`). It follows the select-only combobox pattern: the keyboard
     * stays on the button, the arrows move through the list, Enter or Space chooses, Escape closes.
     */
    import { onDestroy } from "svelte";

    import { onPressOutside, placeAgainst, POPUP_CLASSES } from "./floating";

    interface Option {
        value: T;
        label: string;
    }

    const {
        options,
        value,
        onChange,
        labelledBy,
        disabled = false,
        testid,
        class: className = "",
    }: {
        options: readonly Option[];
        value: T;
        onChange: (value: T) => void;
        /** The id of the visible label that names the control. */
        labelledBy: string;
        disabled?: boolean;
        testid?: string;
        class?: string;
    } = $props();

    const listId = $props.id();
    let open = $state(false);
    let active = $state(0);
    let trigger = $state<HTMLButtonElement | null>(null);
    let popup = $state<HTMLElement | null>(null);
    let placement: { stop(): void } | null = null;
    let stopOutside: (() => void) | null = null;

    const selected = $derived(options.find((option) => option.value === value));

    function show() {
        if (disabled || open || !popup || !trigger) return;
        active = Math.max(0, options.findIndex((option) => option.value === value));
        open = true;
        popup.showPopover();
        placement = placeAgainst(trigger, popup);
        stopOutside = onPressOutside(() => [trigger, popup], () => hide(false));
        scrollActive();
    }

    function hide(refocus: boolean) {
        if (!open) return;
        open = false;
        placement?.stop();
        stopOutside?.();
        placement = stopOutside = null;
        if (popup?.matches(":popover-open")) popup.hidePopover();
        if (refocus) trigger?.focus();
    }

    function choose(index: number) {
        const option = options[index];
        if (option && option.value !== value) onChange(option.value);
        hide(true);
    }

    function scrollActive() {
        requestAnimationFrame(() => popup?.querySelector(`#${CSS.escape(`${listId}-${active}`)}`)?.scrollIntoView({ block: "nearest" }));
    }

    function move(to: number) {
        active = Math.max(0, Math.min(options.length - 1, to));
        scrollActive();
    }

    function onKeydown(event: KeyboardEvent) {
        if (disabled) return;
        if (!open) {
            if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
                event.preventDefault();
                show();
            }
            return;
        }
        if (event.key === "ArrowDown") move(active + 1);
        else if (event.key === "ArrowUp") move(active - 1);
        else if (event.key === "Home") move(0);
        else if (event.key === "End") move(options.length - 1);
        else if (event.key === "Enter" || event.key === " ") choose(active);
        else if (event.key === "Escape") {
            // The list closes, and nothing around it (a dialog, a form) hears the key.
            event.stopPropagation();
            hide(true);
        }
        else if (event.key === "Tab") hide(false);
        else return;
        if (event.key !== "Tab") event.preventDefault();
    }

    onDestroy(() => hide(false));
</script>

<div class="relative min-w-0 {className}" data-testid={testid} data-value={value}>
    <button
        bind:this={trigger}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={labelledBy}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-disabled={disabled}
        onclick={() => (open ? hide(true) : show())}
        onkeydown={onKeydown}
        class="flex w-full min-w-0 items-center gap-2 rounded-md border border-(--gk-border-soft) bg-(--gk-surface-0) py-1 pr-1.5 pl-2.5 text-left text-sm text-(--gk-text-default) hover:border-(--gk-border-strong) focus-visible:outline-2 focus-visible:outline-(--gk-accent) aria-disabled:cursor-not-allowed aria-disabled:text-(--gk-text-subtle) pointer-coarse:min-h-11"
        data-testid={testid ? `${testid}-button` : undefined}
    >
        <span class="min-w-0 flex-1 truncate">{selected?.label ?? ""}</span>
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="size-4 shrink-0 text-(--gk-text-muted)">
            <path
                fill-rule="evenodd"
                d="M10.53 3.47a.75.75 0 0 0-1.06 0L6.22 6.72a.75.75 0 0 0 1.06 1.06L10 5.06l2.72 2.72a.75.75 0 1 0 1.06-1.06l-3.25-3.25Zm-4.31 9.81 3.25 3.25a.75.75 0 0 0 1.06 0l3.25-3.25a.75.75 0 1 0-1.06-1.06L10 14.94l-2.72-2.72a.75.75 0 0 0-1.06 1.06Z"
                clip-rule="evenodd"
            />
        </svg>
    </button>
    <!-- The press that chooses never takes the keyboard from the button. -->
    <div bind:this={popup} popover="manual" id={listId} role="listbox" tabindex="-1" aria-labelledby={labelledBy} class={POPUP_CLASSES} onpointerdown={(event) => event.preventDefault()} data-testid={testid ? `${testid}-list` : undefined}>
        {#each options as option, index (option.value)}
            <button
                type="button"
                tabindex="-1"
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                onclick={() => choose(index)}
                onpointermove={() => (active = index)}
                class={[
                    "flex w-full items-center gap-2 rounded-md py-1.5 pr-2 pl-2 text-left text-sm whitespace-nowrap pointer-coarse:min-h-11",
                    index === active && "bg-(--gk-surface-2)",
                    option.value === value ? "font-medium text-(--gk-text-strong)" : "text-(--gk-text-default)",
                ]}
            >
                <span class="flex-1">{option.label}</span>
                {#if option.value === value}
                    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="size-4 shrink-0 text-(--gk-accent)">
                        <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clip-rule="evenodd" />
                    </svg>
                {/if}
            </button>
        {/each}
    </div>
</div>
