<script lang="ts">
    /**
     * The **Keyboard Shortcuts** modal: a reference card, not a settings page - nothing here is
     * editable, so there is no form to submit and the only action is Close.
     *
     * The app-level rows come from the same `APP_KEYBINDINGS` list the window adapter binds, so
     * a chord shown here is a chord that works. Two bindings on one command (Search has `Alt+F`
     * and `Mod+K`) collapse into one row with both chords, which reads as "either" rather than as
     * two features. The editor groups are the reference card for the CodeMirror keymap.
     */
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import { formatChord, isApplePlatform } from "$lib/surface";

    import { APP_KEYBINDINGS, APP_SHORTCUT_GROUPS, EDITOR_SHORTCUTS, type AppShortcutGroup } from "./keyboard-shortcuts";

    let { onclose }: { onclose: () => void } = $props();

    const apple = isApplePlatform();

    interface Row {
        label: string;
        /** One entry per chord, each a list of key caps. */
        chords: string[][];
    }

    /** What each app section is for, under its heading. */
    const APP_GROUP_NOTES: Record<AppShortcutGroup, string> = {
        "Go to": "From anywhere in the graph.",
        Sidebars: "A letter per view brings it to the front, and back if it was closed. L and R show or hide a whole sidebar.",
        Editor: "Spell check is set per device and applies to every graph. Its languages are in Settings, Spelling. In an underlined word, Shift+F10 opens its corrections.",
        Publish: "Publishing again needs a publication published from this device before, or the graph's only one, with a folder chosen; otherwise the Publish tab opens.",
        Help: "",
    };

    /** App rows by section, each section's rows grouped by command in first-appearance order. */
    const appGroups = APP_SHORTCUT_GROUPS.map((group) => {
        const byCommand = new Map<string, Row>();
        for (const binding of APP_KEYBINDINGS) {
            if (binding.group !== group) continue;
            const row = byCommand.get(binding.command) ?? { label: binding.label, chords: [] };
            row.chords.push(formatChord(binding.key, apple));
            byCommand.set(binding.command, row);
        }
        return { title: group, note: APP_GROUP_NOTES[group], rows: [...byCommand.values()] };
    }).filter((group) => group.rows.length > 0);

    const editorGroups = EDITOR_SHORTCUTS.map((group) => ({
        ...group,
        rows: group.shortcuts.map(
            (shortcut): Row => ({ label: shortcut.label, chords: [formatChord(shortcut.key, apple)] }),
        ),
    }));
</script>

{#snippet rows(list: Row[])}
    <dl class="rows">
        {#each list as row (row.label + row.chords.map((c) => c.join("")).join("|"))}
            <dt>{row.label}</dt>
            <dd>
                {#each row.chords as chord, i (i)}
                    {#if i > 0}<span class="or">or</span>{/if}
                    <span class="chord">
                        {#each chord as cap, j (j)}
                            <kbd>{cap}</kbd>
                        {/each}
                    </span>
                {/each}
            </dd>
        {/each}
    </dl>
{/snippet}

<Modal open={true} title="Keyboard shortcuts" size="xl" placement="top" testId="keyboard-shortcuts-dialog" {onclose}>
    {#snippet body()}
        <!-- Two columns of sections on a wide dialog, so the card is read at a glance rather than
             scrolled; the app sections first, then the editor's. -->
        <div class="columns">
            <div class="column">
                {#each appGroups as group (group.title)}
                    <section data-testid="shortcut-group" data-group={group.title}>
                        <h3>{group.title}</h3>
                        {#if group.note}<p class="note">{group.note}</p>{/if}
                        {@render rows(group.rows)}
                    </section>
                {/each}
            </div>
            <div class="column">
                {#each editorGroups as group (group.title)}
                    <section data-testid="shortcut-group" data-group={group.title}>
                        <h3>{group.title}</h3>
                        {#if group.note}<p class="note">{group.note}</p>{/if}
                        {@render rows(group.rows)}
                    </section>
                {/each}
            </div>
        </div>
    {/snippet}

    {#snippet footer()}
        <button
            type="button"
            onclick={onclose}
            data-dialog-dismiss
            data-testid="keyboard-shortcuts-close"
            class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
        >Close</button>
    {/snippet}
</Modal>

<style>
    .columns {
        display: grid;
        grid-template-columns: 1fr;
        gap: 1.25rem 2.5rem;
    }
    @media (min-width: 48rem) {
        .columns {
            grid-template-columns: 1fr 1fr;
        }
    }
    .column {
        min-width: 0;
    }
    section + section {
        margin-top: 1.25rem;
    }
    h3 {
        margin: 0;
        font-size: 0.875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--gk-text-muted, #6b7280);
    }
    .note {
        margin: 0.15rem 0 0;
        font-size: 0.875rem;
        color: var(--gk-text-muted, #6b7280);
    }
    .rows {
        display: grid;
        grid-template-columns: 1fr auto;
        column-gap: 1.5rem;
        row-gap: 0.45rem;
        margin: 0.6rem 0 0;
        font-size: 0.875rem;
    }
    dt {
        align-self: center;
    }
    dd {
        margin: 0;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.4rem;
        white-space: nowrap;
    }
    .or {
        font-size: 0.875rem;
        color: var(--gk-text-muted, #6b7280);
    }
    .chord {
        display: inline-flex;
        gap: 0.2rem;
    }
    kbd {
        display: inline-block;
        min-width: 1.6rem;
        padding: 0.1rem 0.4rem;
        border: 1px solid var(--gk-border-soft);
        border-bottom-width: 2px;
        border-radius: 5px;
        background: var(--gk-surface-1);
        font: inherit;
        font-size: 0.875rem;
        line-height: 1.25rem;
        text-align: center;
    }
</style>
