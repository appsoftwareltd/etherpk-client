<script lang="ts" generics="T">
    /**
     * A control that opens a list of options: any number of them (`multiple`, as checkboxes) or
     * exactly one (as radio buttons). A tick in a multiple list applies at once and the list stays
     * open for the next one, so it ends with a Done button: the visible way out, at the foot where
     * the ticking ends, and "Done" rather than a cross because the ticks have already applied and
     * a cross reads as throwing them away. A choice in a single list applies and closes it, as a
     * native select does. Either closes on a click elsewhere, Escape, Enter, Tab out of it, or the
     * control again.
     *
     * The closed control shows `summary`, what is chosen in words the owner picks. On a desktop
     * the field's `label` sits above it; the phone leaves that out for room, and the open list
     * names the field in its legend. The list is a native popover: it sits in the top layer, so
     * no Sidebar or drawer clips it, and the browser provides the light dismissal, Escape and the
     * return of focus.
     */
    let {
        label,
        summary,
        options,
        selected,
        multiple = false,
        changed = false,
        testid,
        onChoose,
    }: {
        /** The field, "Status": shown above the control, the list's legend, and its name. */
        label: string;
        /** What the closed control says, "Unfinished". */
        summary: string;
        options: ReadonlyArray<{ value: T; label: string }>;
        /** What is chosen; a single list holds one value. */
        selected: readonly T[];
        /** Checkboxes, any number chosen, rather than radio buttons and exactly one. */
        multiple?: boolean;
        /** Draw the control in the accent: the owner decides what counts as changed. */
        changed?: boolean;
        /** The control's test id; its list is `<testid>-menu`, its name `<testid>-label`. */
        testid: string;
        /** A multiple list's option was ticked or unticked, or a single list's was chosen. */
        onChoose: (value: T) => void;
    } = $props();

    const id = $props.id();
    const menuId = `${id}-menu`;
    const labelId = `${id}-label`;
    const summaryId = `${id}-summary`;

    let trigger = $state<HTMLButtonElement>();
    let menu = $state<HTMLDivElement>();
    let open = $state(false);

    /** Narrow controls still get a list wide enough for "Next 7 days" and its button. */
    const MIN_WIDTH = 176;
    const GUTTER = 8;
    /** Between the control and the list. */
    const GAP = 4;
    /** Roughly five touch-sized rows, the legend and Done: enough room below to open downwards. */
    const ROOM_BELOW = 340;

    /**
     * Put the list under its control, as wide as the control (never narrower than MIN_WIDTH),
     * clamped to the viewport. It opens upwards only when there is too little room below and more
     * above; either way `max-height` keeps it on screen and it scrolls if it has to.
     *
     * Run before the list shows, so its size cannot be measured; everything here comes from the
     * control's box, which is why the width is set rather than left to the content.
     */
    function place(): void {
        if (!trigger || !menu) return;
        const rect = trigger.getBoundingClientRect();
        const width = Math.min(Math.max(rect.width, MIN_WIDTH), window.innerWidth - GUTTER * 2);
        const left = Math.min(Math.max(rect.left, GUTTER), window.innerWidth - width - GUTTER);
        const below = window.innerHeight - rect.bottom - GAP - GUTTER;
        const above = rect.top - GAP - GUTTER;
        menu.style.width = `${width}px`;
        menu.style.left = `${left}px`;
        if (below >= ROOM_BELOW || below >= above) {
            menu.style.top = `${rect.bottom + GAP}px`;
            menu.style.bottom = "auto";
            menu.style.maxHeight = `${below}px`;
        } else {
            menu.style.top = "auto";
            menu.style.bottom = `${window.innerHeight - rect.top + GAP}px`;
            menu.style.maxHeight = `${above}px`;
        }
    }

    function onBeforeToggle(event: ToggleEvent): void {
        if (event.newState === "open") place();
    }

    const inputs = () => [...(menu?.querySelectorAll<HTMLInputElement>("input") ?? [])];

    /**
     * Focus lands where the choices are: a multiple list's first option, a single list's current
     * choice (as a native select opens on it).
     */
    function onMenuToggle(event: ToggleEvent): void {
        open = event.newState === "open";
        if (!open) return;
        const all = inputs();
        (all.find((input) => !multiple && input.checked) ?? all[0])?.focus();
    }

    function close(): void {
        menu?.hidePopover();
        trigger?.focus();
    }

    /**
     * An option was clicked, by pointer, by Space, or through its row's label: `click` covers all
     * three. It also fires on a radio that is already chosen, which `change` does not, and a
     * single list must close then too. The owner hears only about a real change there, since
     * choosing the current value again is not a new question.
     */
    function onOptionClick(value: T): void {
        if (multiple) {
            onChoose(value);
            return;
        }
        if (!selected.includes(value)) onChoose(value);
        close();
    }

    /**
     * Up and Down move between options, clamped rather than wrapped; Home and End jump to either
     * end. Moving never chooses (a radio's own arrow keys would), so a single list is not
     * re-queried at every step. Enter chooses the focused option in a single list, and in a
     * multiple list, whose ticks have already applied, only closes.
     */
    function onOptionKeydown(event: KeyboardEvent, index: number): void {
        const all = inputs();
        const target =
            event.key === "ArrowDown"
                ? Math.min(index + 1, all.length - 1)
                : event.key === "ArrowUp"
                  ? Math.max(index - 1, 0)
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? all.length - 1
                      : null;
        if (target !== null) {
            event.preventDefault();
            all[target]?.focus();
        } else if (event.key === "Enter") {
            event.preventDefault();
            if (multiple) close();
            else onOptionClick(options[index].value);
        }
    }

    /**
     * Tab (or Shift+Tab) out of the list closes it, so an open list is never left behind the
     * control focus has moved on to. Only when focus goes to a named element outside the list
     * and its control: pressing the control toggles the list itself, and a pressed mouse inside
     * the list moves focus to the list (it is focusable for exactly that reason; otherwise the
     * press would go to dockview's panel and close the list before the click arrived). Deferred
     * so focus has landed first, and the popover does not pull it back on its way out.
     */
    function onFocusOut(event: FocusEvent): void {
        const next = event.relatedTarget as Node | null;
        if (!next || next === trigger || menu?.contains(next)) return;
        setTimeout(() => {
            if (open && !menu?.contains(document.activeElement)) menu?.hidePopover();
        });
    }

    // While open, follow the control: if it is hidden (its View's tab left the front, say) the
    // list goes too rather than float over whatever took its place; if it resizes, the list
    // moves with it.
    $effect(() => {
        if (!open || !trigger) return;
        const control = trigger;
        const observer = new ResizeObserver(() => {
            if (control.getClientRects().length === 0) menu?.hidePopover();
            else place();
        });
        observer.observe(control);
        return () => observer.disconnect();
    });
</script>

<svelte:window onresize={() => open && place()} />

<div class="flex min-w-0 flex-col">
    <!-- Below the `lg` breakpoint, the phone presenter's side of LAYOUT_BREAKPOINT_PX, the name
         is left out: the room matters more there. The control's accessible name keeps it. -->
    <span id={labelId} data-testid="{testid}-label" class="mb-1 hidden text-sm text-(--gk-text-muted) lg:block">{label}</span>
    <button
        bind:this={trigger}
        type="button"
        popovertarget={menuId}
        data-testid={testid}
        data-changed={changed ? "true" : undefined}
        aria-labelledby="{labelId} {summaryId}"
        class={[
            "relative flex w-full min-w-0 items-center rounded-md border bg-(--gk-surface-1) py-1 pr-7 pl-2 text-left text-sm pointer-coarse:min-h-11",
            changed ? "border-(--gk-accent) text-(--gk-accent)" : "border-(--gk-border-soft) text-(--gk-text-default)",
        ]}
    >
        <span id={summaryId} class="min-w-0 truncate">{summary}</span>
        <!-- heroicons/outline chevron-down -->
        <svg
            class="pointer-events-none absolute top-1/2 right-2 h-4 w-4 -translate-y-1/2"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
        >
            <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
    </button>
</div>

<div
    bind:this={menu}
    id={menuId}
    popover="auto"
    tabindex="-1"
    data-testid="{testid}-menu"
    onbeforetoggle={onBeforeToggle}
    ontoggle={onMenuToggle}
    class="fixed inset-auto m-0 box-border overflow-y-auto rounded-md border border-(--gk-border-soft) bg-(--gk-surface-1) p-1 text-(--gk-text-default) shadow-lg outline-none"
>
    <fieldset class="m-0 min-w-0 border-0 p-0">
        <legend class="px-2 pt-1 pb-0.5 text-sm uppercase tracking-[0.04em] text-(--gk-text-muted)">{label}</legend>
        {#each options as option, i (option.label)}
            <label
                class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-(--gk-surface-2) has-[:focus-visible]:bg-(--gk-surface-2) pointer-coarse:min-h-11"
            >
                <input
                    type={multiple ? "checkbox" : "radio"}
                    name={multiple ? undefined : menuId}
                    class="accent-(--gk-accent)"
                    checked={selected.includes(option.value)}
                    onclick={() => onOptionClick(option.value)}
                    onkeydown={(event) => onOptionKeydown(event, i)}
                    onfocusout={onFocusOut}
                />
                <span>{option.label}</span>
            </label>
        {/each}
    </fieldset>
    {#if multiple}
        <!-- Last in the tab order too: Tab from the final option lands here, not outside. -->
        <div class="mt-1 border-t border-(--gk-border-soft) pt-1">
            <button
                type="button"
                data-testid="{testid}-done"
                onclick={close}
                onfocusout={onFocusOut}
                class="w-full rounded-md py-1.5 text-sm hover:bg-(--gk-surface-2) focus-visible:bg-(--gk-surface-2) pointer-coarse:min-h-11"
            >
                Done
            </button>
        </div>
    {/if}
</div>
