<script lang="ts">
    /**
     * An inline action cluster on a **read-only** surface: the icon buttons that follow an
     * [[Asset Reference]] or a [[File Link]] in a quoted line. What the buttons are is the caller's
     * (`asset-affordances.ts`, `link-affordances.ts`), so the list here is the same one, in the
     * same order, wired to the same [[Command]]s as the editor's own cluster (`inline-actions.ts`).
     * The buttons are plain HTML, not the editor's imperative cluster: that one exists to keep
     * CodeMirror out of its own widgets' events, a problem a Svelte surface does not have.
     */
    import { iconSvg } from "$lib/surface/icons";

    import type { InlineAction } from "../inline-action";

    let {
        actions,
        /** What the buttons act on, read after the label: "Download q3-report.pdf", "Copy path /home/g/x". */
        name,
        /** Run the action; resolves true when it did its work, which is what shows its `confirm`. */
        run,
        /** What the cluster follows. Names its data attributes (`data-asset-actions`), which tests and hosts key on. */
        kind,
        /** The cluster's own attribute value: the asset reference, the file path. */
        subject,
        /** Icon size in px: 16 is the editor's trailing cluster, 18 its image overlay. */
        size = 16,
    }: {
        actions: InlineAction[];
        name: string;
        run: (action: InlineAction) => Promise<boolean>;
        kind: "asset" | "file-link";
        subject: string;
        size?: number;
    } = $props();

    /** The Command whose confirmation (the tick after a copy) is standing in for its icon right now. */
    let confirming = $state<string | null>(null);
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;

    /** Run the action; where it has a confirmation and reports success, show it for a moment. */
    async function runAction(action: InlineAction) {
        const done = await run(action);
        if (!done || !action.confirm) return;
        confirming = action.command;
        if (confirmTimer) clearTimeout(confirmTimer);
        confirmTimer = setTimeout(() => (confirming = null), 1500);
    }

    /**
     * Run the action for `command` as if its button had been clicked. The label a cluster follows
     * can act too (a file link's text copies), and it shares the button's tick rather than
     * confirming on its own.
     */
    export function trigger(command: string): Promise<void> {
        const action = actions.find((candidate) => candidate.command === command);
        return action ? runAction(action) : Promise.resolve();
    }
</script>

<span class="actions" {...{ [`data-${kind}-actions`]: subject }}>
    {#each actions as action (action.command)}
        {@const shown = confirming === action.command && action.confirm ? action.confirm : action}
        <button
            type="button"
            class={["action", { done: shown !== action }]}
            title={shown.label}
            aria-label="{shown.label} {name}"
            {...{ [`data-${kind}-action`]: action.command }}
            onclick={(event) => {
                // The cluster sits inside a clickable reference row; this click is about the
                // file, not about navigating to the document that mentions it.
                event.stopPropagation();
                void runAction(action);
            }}
        >
            <!-- In-repo constant markup from the icon table (surface/icons.ts), never user or
                 document content — the same justification the Command Bar's icons carry. -->
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html iconSvg(shown.icon, { size })}
        </button>
    {/each}
</span>

<style>
    .actions {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        vertical-align: baseline;
    }
    .action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 3px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--gk-text-muted, currentColor);
        cursor: pointer;
        line-height: 0;
    }
    /* A neutral translucent tint rather than a surface token: the reference card these sit on is
       already `--gk-surface-2`, so a surface colour would either match it or (light mode's
       `--gk-surface-3`, an inverted near-black) shout. Grey over grey reads in both themes. */
    @media (hover: hover) {
        .action:hover {
            background: rgba(127, 127, 127, 0.22);
            color: var(--gk-text-default, currentColor);
        }
    }
    /* The moment after a copy: the tick takes the accent so it reads as an outcome, not as
       another button. */
    .action.done,
    .action.done:hover {
        color: var(--gk-accent, #2563eb);
    }
    /* The panel's own text is small and quiet, so the focus ring has to be explicit rather than
       relying on the browser's default outline landing somewhere visible. */
    .action:focus-visible {
        outline: 2px solid var(--gk-accent, #2563eb);
        outline-offset: 1px;
    }
</style>
