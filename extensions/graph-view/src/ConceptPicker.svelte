<script lang="ts">
    /**
     * A box for naming a concept the [[Graph View]] shows: type part of a name, pick from what
     * matches. Names that start with what was typed come before names that only contain it, as in
     * Quick Find. Arrow keys move through the matches, Enter picks, Escape closes the list.
     *
     * It picks, it never navigates: the Graph View decides what picking means (centre on it, or
     * end a path there).
     */
    let {
        label,
        concepts,
        onPick,
        testid,
        placeholder = "",
        value = $bindable(""),
    }: {
        label: string;
        concepts: readonly { key: string; name: string }[];
        onPick: (key: string) => void;
        testid: string;
        placeholder?: string;
        value?: string;
    } = $props();

    const uid = $props.id();
    let open = $state(false);
    let active = $state(0);

    const MAX_MATCHES = 8;
    const matches = $derived.by(() => {
        const typed = value.trim().toLowerCase();
        if (!typed) return [];
        const starting: { key: string; name: string }[] = [];
        const containing: { key: string; name: string }[] = [];
        for (const concept of concepts) {
            const name = concept.name.toLowerCase();
            if (name.startsWith(typed)) starting.push(concept);
            else if (name.includes(typed)) containing.push(concept);
        }
        const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
        return [...starting.sort(byName), ...containing.sort(byName)].slice(0, MAX_MATCHES);
    });
    const listShown = $derived(open && matches.length > 0);

    function choose(concept: { key: string; name: string }) {
        value = concept.name;
        open = false;
        onPick(concept.key);
    }

    function onkeydown(event: KeyboardEvent) {
        if (event.key === "ArrowDown" && matches.length > 0) {
            event.preventDefault();
            open = true;
            active = (active + 1) % matches.length;
        } else if (event.key === "ArrowUp" && matches.length > 0) {
            event.preventDefault();
            open = true;
            active = (active - 1 + matches.length) % matches.length;
        } else if (event.key === "Enter" && listShown) {
            event.preventDefault();
            choose(matches[active] ?? matches[0]);
        } else if (event.key === "Escape" && listShown) {
            // Closes the list only; a second Escape belongs to whatever holds this box.
            event.preventDefault();
            event.stopPropagation();
            open = false;
        }
    }
</script>

<div class="relative">
    <label for="{uid}-input" class="mb-1 block text-sm font-medium text-(--gk-text-muted)">{label}</label>
    <input
        id="{uid}-input"
        type="text"
        role="combobox"
        autocomplete="off"
        spellcheck="false"
        aria-autocomplete="list"
        aria-expanded={listShown}
        aria-controls="{uid}-list"
        aria-activedescendant={listShown ? `${uid}-option-${active}` : undefined}
        {placeholder}
        bind:value
        oninput={() => {
            open = true;
            active = 0;
        }}
        onfocus={() => (open = true)}
        onblur={() => (open = false)}
        {onkeydown}
        class="w-full rounded-md border border-(--gk-border-strong) bg-(--gk-surface-0) px-2 py-1.5 text-sm text-(--gk-text-default) placeholder:text-(--gk-text-subtle) focus:border-(--gk-accent) focus:outline-none"
        data-testid={testid}
    />
    {#if listShown}
        <ul
            id="{uid}-list"
            role="listbox"
            aria-label={label}
            class="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-md border border-(--gk-border-strong) bg-(--gk-surface-0) py-1 shadow-(--gk-shadow)"
            data-testid="{testid}-options"
        >
            {#each matches as concept, index (concept.key)}
                <!-- mousedown, not click: picking must happen before the input's blur closes the list. -->
                <li
                    id="{uid}-option-{index}"
                    role="option"
                    aria-selected={index === active}
                    class={[
                        "cursor-pointer truncate px-2 py-1 text-sm text-(--gk-text-default)",
                        index === active && "bg-(--gk-selection)",
                    ]}
                    onmousedown={(event) => {
                        event.preventDefault();
                        choose(concept);
                    }}
                    onmouseenter={() => (active = index)}
                >
                    {concept.name}
                </li>
            {/each}
        </ul>
    {/if}
</div>
