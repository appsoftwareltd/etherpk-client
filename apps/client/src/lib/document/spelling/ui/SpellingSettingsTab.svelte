<script lang="ts">
    /**
     * The **Spelling** tab of the Settings modal (ADR 0095): whether this device checks spelling,
     * the graph's [[Spelling Languages]] on this device, and the graph's shared
     * [[Graph Dictionary]].
     *
     * Everything applies the moment it changes, like the Protected Documents tab: the preference
     * and the languages are this device's, and the dictionary is its own container, so there is
     * nothing for the dialog's Save to commit. Renders into someone else's form, so every button
     * declares `type="button"` (an untyped one would submit and close the dialog).
     */
    import { createSubscriber } from "svelte/reactivity";

    import { formatBytes } from "$lib/format-bytes";

    import { isSpellCheckEnabled, setSpellCheckEnabled, subscribeSpellCheck } from "../../spell-check-preference";
    import { getGraphDictionary, removeDictionaryWords, subscribeGraphDictionary } from "../graph-dictionary";
    import type { SpellingTabProps } from "./spelling-tab";

    let { service, dictionaryHost }: SpellingTabProps = $props();

    // The three sources are module stores and a service outside Svelte; each read below
    // subscribes, so the tab follows an Alt+S, a download finishing or a peer's new word.
    const watchService = createSubscriber((update) => service.subscribe(update));
    const watchPreference = createSubscriber((update) => subscribeSpellCheck(update));
    const watchDictionary = createSubscriber((update) => subscribeGraphDictionary(update));

    const enabled = $derived.by(() => {
        watchPreference();
        return isSpellCheckEnabled();
    });
    const spell = $derived.by(() => {
        watchService();
        return {
            state: service.state,
            error: service.error,
            languages: service.languages(),
            available: service.available(),
            followsBrowser: service.followsBrowser(),
        };
    });
    const words = $derived.by(() => {
        watchDictionary();
        return [...getGraphDictionary()].sort((a, b) => a.localeCompare(b));
    });

    /** Languages not already in the list, for Add. */
    const addable = $derived(spell.available.filter((d) => !spell.languages.some((l) => l.tag === d.tag)));
    // The first addable language by default; the select writes the user's choice over it, and a
    // change to the list (a language added or removed) starts again from the first.
    let toAdd = $derived(addable[0]?.tag ?? "");

    /** Past three languages a phone starts to feel the memory; a desktop does not. */
    const coarsePointer = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

    let search = $state("");
    /** How many matching words to render at once; a search finds the rest. */
    const WORD_LIMIT = 200;
    const matching = $derived(
        search.trim() === "" ? words : words.filter((w) => w.toLowerCase().includes(search.trim().toLowerCase())),
    );
    let removeError = $state<string | null>(null);

    async function removeWord(word: string) {
        removeError = null;
        try {
            await removeDictionaryWords([word]);
        } catch (e) {
            removeError = `"${word}" could not be removed: ${(e as Error).message}`;
        }
    }

    function stateLabel(state: string): string {
        switch (state) {
            case "ready":
                return "Downloaded";
            case "downloading":
                return "Downloading…";
            case "offline":
                return "Downloads when you're back online";
            default:
                return "Could not be downloaded";
        }
    }
</script>

<div class="space-y-5" data-testid="spelling-tab">
    <div>
        <label class="flex items-start gap-2 text-sm text-gray-950 dark:text-gray-100">
            <input
                type="checkbox"
                checked={enabled}
                onchange={(e) => setSpellCheckEnabled((e.currentTarget as HTMLInputElement).checked)}
                data-testid="spelling-enabled"
                class="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-700"
            />
            <span>Check spelling as I type</span>
        </label>
        <p class="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
            On <strong>this device</strong>, in every graph. <kbd>Alt+S</kbd> turns it on or off too. Code, links,
            tags and protected documents are never checked.
        </p>
    </div>

    <div class="border-t border-gray-100 dark:border-gray-800 pt-4">
        <h3 class="text-sm font-medium text-gray-950 dark:text-gray-100">Languages on this device</h3>

        {#if spell.state === "off"}
            <p class="mt-1 text-sm text-gray-600 dark:text-gray-400" data-testid="spelling-off">
                Spelling is not checked on this device, so no dictionary is downloaded. Turn it on above to
                choose languages.
            </p>
        {:else if spell.state === "unconfigured"}
            <p class="mt-1 text-sm text-gray-600 dark:text-gray-400" data-testid="spelling-unconfigured">
                This server has no dictionary host set, so there are no languages to check against. Its
                administrator can set one (<code>PUBLIC_DICTIONARY_URL</code>).
            </p>
        {:else if spell.error && spell.languages.length === 0}
            <p role="alert" class="mt-1 text-sm text-red-600" data-testid="spelling-manifest-error">
                The list of dictionaries could not be read from {dictionaryHost}. {spell.error}
            </p>
            <button
                type="button"
                onclick={() => service.retry()}
                data-testid="spelling-retry"
                class="mt-2 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-white/5"
            >Try again</button>
        {:else}
            <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {#if spell.followsBrowser}
                    Until you change them, these follow your browser's languages.
                {:else}
                    Chosen for this graph on this device.
                {/if}
                A word is correct if any of them accepts it.
            </p>

            {#if spell.languages.length === 0}
                <p class="mt-2 text-sm text-gray-600 dark:text-gray-400" data-testid="spelling-no-languages">
                    None of your browser's languages has a dictionary here. Add one below.
                </p>
            {:else}
                <ul class="mt-2 divide-y divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-800" data-testid="spelling-languages">
                    {#each spell.languages as language (language.tag)}
                        <li class="flex items-center gap-3 px-3 py-2" data-testid="spelling-language" data-tag={language.tag}>
                            <div class="min-w-0 flex-1">
                                <p class="text-sm text-gray-950 dark:text-gray-100">{language.name}</p>
                                <p
                                    class="text-sm {language.state === 'failed' ? 'text-red-600' : 'text-gray-500 dark:text-gray-400'}"
                                    data-testid="spelling-language-state"
                                    data-state={language.state}
                                >
                                    {stateLabel(language.state)} · {formatBytes(language.bytes)}{#if language.state === "failed" && language.error}. {language.error}{/if}
                                </p>
                            </div>
                            {#if language.state === "failed" || language.state === "offline"}
                                <button
                                    type="button"
                                    onclick={() => service.retry()}
                                    class="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-white/5"
                                >Retry</button>
                            {/if}
                            <button
                                type="button"
                                onclick={() => service.removeLanguage(language.tag)}
                                aria-label={`Remove ${language.name}`}
                                data-testid="spelling-language-remove"
                                class="rounded-lg px-3 py-1 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-950 dark:hover:text-gray-100"
                            >Remove</button>
                        </li>
                    {/each}
                </ul>
            {/if}

            {#if addable.length > 0}
                <div class="mt-3 flex gap-2">
                    <label for="spelling-add" class="sr-only">Language to add</label>
                    <select
                        id="spelling-add"
                        bind:value={toAdd}
                        data-testid="spelling-add-select"
                        class="block min-w-0 flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100"
                    >
                        {#each addable as dictionary (dictionary.tag)}
                            <option value={dictionary.tag}>{dictionary.name} ({formatBytes(dictionary.bytes)})</option>
                        {/each}
                    </select>
                    <button
                        type="button"
                        onclick={() => toAdd && service.addLanguage(toAdd)}
                        data-testid="spelling-add"
                        class="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-white/5"
                    >Add language</button>
                </div>
            {/if}

            {#if !spell.followsBrowser}
                <button
                    type="button"
                    onclick={() => service.resetLanguages()}
                    data-testid="spelling-reset"
                    class="mt-2 rounded-lg px-0 py-1 text-sm font-medium text-gray-600 dark:text-gray-300 underline underline-offset-2 hover:text-gray-950 dark:hover:text-gray-100"
                >Go back to my browser's languages</button>
            {/if}

            <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
                Each dictionary downloads once from {dictionaryHost} and then stays on this device. Each
                language uses about 20 to 50 MB of memory while in use.
                {#if coarsePointer && spell.languages.length > 3}
                    <strong>More than three may slow this device.</strong>
                {/if}
            </p>
        {/if}
    </div>

    <div class="border-t border-gray-100 dark:border-gray-800 pt-4">
        <h3 class="text-sm font-medium text-gray-950 dark:text-gray-100">Graph dictionary</h3>
        <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Words this graph accepts as spelt correctly, <strong>shared with every member</strong>. Add one
            from the menu on an underlined word.
        </p>
        {#if words.length === 0}
            <p class="mt-2 text-sm text-gray-500 dark:text-gray-400" data-testid="spelling-dictionary-empty">No words yet.</p>
        {:else}
            <input
                type="search"
                bind:value={search}
                placeholder="Search {words.length} {words.length === 1 ? 'word' : 'words'}"
                aria-label="Search the graph dictionary"
                data-testid="spelling-dictionary-search"
                class="mt-2 block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100"
            />
            <ul class="mt-2 max-h-64 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-800" data-testid="spelling-dictionary">
                {#each matching.slice(0, WORD_LIMIT) as word (word)}
                    <li class="flex items-center gap-3 px-3 py-1.5" data-testid="spelling-dictionary-word">
                        <span class="min-w-0 flex-1 truncate text-sm text-gray-950 dark:text-gray-100">{word}</span>
                        <button
                            type="button"
                            onclick={() => void removeWord(word)}
                            aria-label={`Remove ${word} from the graph dictionary`}
                            class="rounded-lg px-2 py-0.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-950 dark:hover:text-gray-100"
                        >Remove</button>
                    </li>
                {:else}
                    <li class="px-3 py-1.5 text-sm text-gray-500 dark:text-gray-400">No word matches "{search}".</li>
                {/each}
            </ul>
            {#if matching.length > WORD_LIMIT}
                <p class="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
                    Showing {WORD_LIMIT} of {matching.length}. Search to find the rest.
                </p>
            {/if}
        {/if}
        {#if removeError}
            <p role="alert" class="mt-2 text-sm text-red-600">{removeError}</p>
        {/if}
    </div>
</div>
