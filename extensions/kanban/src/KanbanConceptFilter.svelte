<script lang="ts">
    /**
     * The Graph Kanban's concept box, a part of its [[Board Filter]]: a [[Name Filter]] like the
     * [[Tasks View]]'s. Typing offers the graph's names (pages, journals, aliases and pageless
     * concepts, `rankNameFilter`), and choosing one shows only the tasks that answer to it, the cards
     * that concept's own board shows. Emptying the box, its clear button, or Escape with no list open
     * shows every concept's tasks again.
     *
     * A combobox: the keyboard stays in the input and the arrows move the highlighted name. A name
     * half typed is not a choice, so leaving the box puts back the name the board is filtered by.
     */
    import { createSubscriber } from "svelte/reactivity";

    import { getActiveGraphIndex } from "#lib/document/backlinks/index.js";
    import { nameFilterDetail, rankNameFilter } from "#lib/document/name-match.js";
    import FilterInput from "#lib/components/FilterInput.svelte";

    const {
        value,
        onchoose,
        desktop,
    }: {
        /** The concept the board is filtered by, or null for every concept. */
        value: string | null;
        /** A name chosen, or null when the box was cleared. */
        onchoose: (concept: string | null) => void;
        /** Desktop width: a phone's input is 16px, so iOS Safari does not zoom to it. */
        desktop: boolean;
    } = $props();

    const uid = $props.id();

    /** What the box shows: the chosen name, or what is being typed towards another. */
    let typed = $derived(value ?? "");
    /** Whether the list was asked for, by typing or the down arrow. It shows only with names in it. */
    let listWanted = $state(false);
    /** The highlighted name. The keyboard stays in the input; the arrows move this. */
    let highlighted = $state(0);
    let inputEl = $state<HTMLInputElement>();
    let listEl = $state<HTMLElement>();

    // The names are read again whenever the index updates, so a name typed before the index had
    // read a new page still offers that page.
    const watchIndex = createSubscriber((update) => getActiveGraphIndex()?.onUpdated(update) ?? (() => {}));
    const offers = $derived.by(() => {
        if (!listWanted || typed.trim() === "") return [];
        watchIndex();
        return rankNameFilter(getActiveGraphIndex()?.allConcepts() ?? [], typed);
    });
    const listOpen = $derived(offers.length > 0);

    // Keep the highlighted name in view: focus never leaves the input, so the list does not scroll by itself.
    $effect(() => {
        void highlighted;
        listEl?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    });

    function choose(name: string): void {
        listWanted = false;
        typed = name;
        if (name !== value) onchoose(name);
    }

    /** Empty the box and show every concept's tasks again, leaving the keyboard in the box. */
    function clear(): void {
        listWanted = false;
        typed = "";
        if (value !== null) onchoose(null);
        inputEl?.focus();
    }

    /** Typing re-ranks the names, so the highlight goes back to the best. Emptying the box clears the filter. */
    function onInput(text: string): void {
        typed = text;
        listWanted = true;
        highlighted = 0;
        if (text.trim() === "" && value !== null) onchoose(null);
    }

    /** The arrows stop at either end of the list rather than wrapping, as [[Search]]'s do. */
    function onKeydown(event: KeyboardEvent): void {
        if (event.key === "ArrowDown" && !listOpen) {
            event.preventDefault();
            listWanted = true;
            highlighted = 0;
        } else if (event.key === "ArrowDown") {
            event.preventDefault();
            highlighted = Math.min(highlighted + 1, offers.length - 1);
        } else if (event.key === "ArrowUp" && listOpen) {
            event.preventDefault();
            highlighted = Math.max(highlighted - 1, 0);
        } else if (event.key === "Enter" && listOpen) {
            event.preventDefault();
            choose(offers[highlighted].display);
        } else if (event.key === "Escape") {
            onEscape(event);
        }
    }

    /** Escape closes the list and keeps what was typed; with no list open it clears the box. */
    function onEscape(event: KeyboardEvent): void {
        if (listOpen) {
            event.preventDefault();
            listWanted = false;
        } else if (typed !== "" || value !== null) {
            event.preventDefault();
            clear();
        }
    }

    function onBlur(): void {
        listWanted = false;
        typed = value ?? "";
    }
</script>

<!-- As wide as the words box beside it, and drawn by the same filter box. -->
<FilterInput
    class="min-w-48 flex-1 sm:max-w-58"
    bind:input={inputEl}
    value={typed}
    ontext={onInput}
    onclear={clear}
    clearLabel="Clear the concept and show every concept's tasks"
    clearTestid="kanban-filter-concept-clear"
    phone={!desktop}
    role="combobox"
    aria-autocomplete="list"
    aria-expanded={listOpen}
    aria-controls="{uid}-names"
    aria-activedescendant={listOpen ? `${uid}-name-${highlighted}` : undefined}
    placeholder="Concept (Page / Journal)"
    aria-label="Show only the tasks of one page, journal entry or concept"
    data-testid="kanban-filter-concept-input"
    data-chosen={value ?? undefined}
    onkeydown={onKeydown}
    onblur={onBlur}
>
    {#if listOpen}
        <!-- Over the lanes, under the input. A press on a name keeps the keyboard in the input
             (pointerdown's default would blur it, and the blur put back the old name first). -->
        <ul
            bind:this={listEl}
            id="{uid}-names"
            role="listbox"
            aria-label="Concepts"
            class="absolute top-full left-0 z-(--z-menu) m-0 mt-1 max-h-60 w-full list-none overflow-y-auto rounded-md border border-(--gk-border-soft) bg-(--gk-surface-1) p-0 shadow-lg"
            data-testid="kanban-filter-concept-names"
        >
            {#each offers as candidate, i (candidate.key)}
                <!-- The keyboard reaches a name through the input, whose arrows and Enter drive
                     the list (aria-activedescendant), so a name takes no focus and no keys of its own. -->
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <li
                    id="{uid}-name-{i}"
                    role="option"
                    aria-selected={i === highlighted}
                    class={["flex cursor-pointer items-baseline gap-2 px-2 py-1.5 text-sm pointer-coarse:min-h-11", i === highlighted && "bg-(--gk-surface-2)"]}
                    data-testid="kanban-filter-concept-name"
                    onpointerdown={(event) => event.preventDefault()}
                    onpointermove={() => (highlighted = i)}
                    onclick={() => choose(candidate.display)}
                >
                    <span class="min-w-0 flex-1 truncate text-(--gk-text-strong)">{candidate.display}</span>
                    <span class="shrink-0 text-sm text-(--gk-text-subtle) uppercase">{nameFilterDetail(candidate)}</span>
                </li>
            {/each}
        </ul>
    {/if}
</FilterInput>
