<script lang="ts">
    /**
     * The one modal dialog shell for every app.
     *
     * It replaces five near-identical implementations (the client sync Modal, a ConfirmDialog
     * copied into all three apps, the asset upload modal, and four inline dialogs on the admin
     * users page). They differed in Escape handling, busy handling, backdrop semantics and
     * header markup, so every accessibility fix had to be written five times and two of them
     * had Escape wired to an element that could never receive it.
     *
     * It owns the rule 8 dialog contract: focus enters on open and returns to the trigger on
     * close, Tab stays inside, Escape dismisses, Enter in a field runs the primary action, and
     * a busy dialog refuses dismissal and says why.
     */
    import type { Snippet } from "svelte";
    import { dialogFocus } from "../ui/index.svelte";

    let {
        open,
        title,
        size = "md",
        placement = "centre",
        closeOnBackdrop = true,
        busy = false,
        busyReason = "Finishing this first…",
        testId,
        onclose,
        onsubmit,
        body,
        footer,
        tools,
    }: {
        /**
         * Visibility is owned by the caller. Deliberately not `$bindable`: half the original
         * call sites passed a literal `true` and let `onclose` do the real work, which made
         * the shell's own assignment an ownership violation. One direction only.
         */
        open: boolean;
        title: string;
        /**
         * How wide the panel may grow on a screen that has the room. `md` (28rem) suits a
         * prompt or a short form; `lg` (42rem) is for a dialog with a tab strip or several
         * sections, which at the narrower width wrapped its tabs and stacked its rows; `xl`
         * (56rem) is for one whose tabs hold tables, commands to copy and paragraphs of help,
         * which at 42rem read cramped on a desktop. Below the panel's own maximum all three are
         * the full width of the viewport, so a phone sees no difference.
         */
        size?: "md" | "lg" | "xl";
        /**
         * Where the panel sits in the viewport. `centre` suits a prompt: its height is fixed,
         * so centring it is stable. `top` is for any dialog whose height changes while it is
         * open - a tab strip, an expanding section - because a centred panel re-centres on
         * every change and its header jumps under the pointer (Settings: General is tall,
         * Maintenance short). Top-anchored panels sit 8vh down on a desktop, proportional on
         * a tall monitor and not cramped on a laptop, and 1rem down on a phone, where the
         * panel nearly fills the viewport anyway. Both big surfaces (Settings, Keyboard
         * shortcuts) use it, so they sit in the same place.
         */
        placement?: "centre" | "top";
        closeOnBackdrop?: boolean;
        /**
         * An asynchronous action this dialog started is still running. The dialog then refuses
         * every dismissal - backdrop, Escape and the close button alike - because closing
         * discards the only place its result would be reported, and it disables every control
         * inside itself, because a form that still accepts edits invites the user to change
         * what has already been submitted.
         */
        busy?: boolean;
        /** Why dismissal is refused. Shown in place of the close button, never on hover alone. */
        busyReason?: string;
        /** Optional `data-testid` on the dialog element. */
        testId?: string;
        onclose?: () => void;
        /**
         * The primary action, invoked by Enter in any field as well as by a `type="submit"`
         * button in the footer. Omit for dialogs whose footer is navigation rather than a
         * single primary action.
         *
         * Note: inside this form a `<button>` with no `type` IS a submit button. Every button
         * in a dialog must declare `type="button"` or `type="submit"`; see
         * `apps/client/src/lib/sync/ui/dialog-button-type.test.ts`.
         */
        onsubmit?: () => void;
        body: Snippet;
        footer?: Snippet;
        /**
         * Actions that are NOT part of the form - each takes effect the moment it is pressed
         * and needs no Save - rendered below the footer, outside the form, so the primary
         * buttons sit directly under the inputs they commit and these cannot be mistaken for
         * something Save applies (Graph Settings' index rebuild and orphan scan).
         */
        tools?: Snippet;
    } = $props();

    const dismissible = $derived(closeOnBackdrop && !busy);
    const uid = $props.id();
    const titleId = `${uid}-title`;
    const busyId = `${uid}-busy`;

    function close() {
        onclose?.();
    }

    function onKeydown(e: KeyboardEvent) {
        if (e.key === "Escape" && dismissible) close();
    }

    // A `click` fires on the common ancestor of mousedown and mouseup - so dragging a text
    // selection from an input and releasing over the backdrop looks like a backdrop click.
    // Only close when the press STARTED on the backdrop, not merely ended there.
    let pressStartedOnBackdrop = false;
    function onBackdropPointerDown(e: PointerEvent) {
        pressStartedOnBackdrop = !(e.target as HTMLElement).closest('[role="dialog"]');
    }
    function onBackdropClick() {
        if (dismissible && pressStartedOnBackdrop) close();
        pressStartedOnBackdrop = false;
    }
</script>

<svelte:window onkeydown={open ? onKeydown : undefined} />

{#if open}
    <!--
        The backdrop is a pointer convenience, not a control: it used to carry `role="button"`
        with `tabindex="-1"`, which announced a close button that no keyboard user could ever
        reach. Escape and the header button are the real dismissals, so this contributes
        nothing to the accessibility tree.
    -->
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
    <!--
        `--dialog-top` is the panel's distance from the top of the viewport, and the panel's
        max height is the viewport less that offset and the 1rem bottom margin - the two must
        agree, or a top-anchored panel overflows a short window and its footer goes out of reach
        (the bug the max-height comment below records). Centred panels keep 1rem all round.
    -->
    <div
        class="fixed inset-0 z-50 flex justify-center px-4 pb-4 {placement === 'top' ? 'items-start pt-[var(--dialog-top)]' : 'items-center pt-4'}"
        style:--dialog-top={placement === "top" ? "max(1rem, 8vh)" : "1rem"}
        onpointerdown={onBackdropPointerDown}
        onclick={onBackdropClick}
    >
        <div class="absolute inset-0 bg-gray-950/25 dark:bg-black/50" aria-hidden="true"></div>

        <div
            class="relative z-10 flex max-h-[calc(100dvh-var(--dialog-top)-1rem)] w-full flex-col rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-[var(--gk-surface-0)] shadow-xl {size === 'xl' ? 'max-w-4xl' : size === 'lg' ? 'max-w-2xl' : 'max-w-md'}"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={busy ? busyId : undefined}
            tabindex="-1"
            data-testid={testId}
            {@attach dialogFocus}
            onclick={(e) => e.stopPropagation()}
        >
            <!--
                The panel is capped at the viewport and everything under the header scrolls as
                one, so a dialog that outgrows a short window (Graph Settings on a 720px-tall
                viewport, once its Storage section gained a third tool) keeps its buttons in
                reach. Before this the whole panel grew and the footer's buttons sat below the
                fold, where a click cannot land. The footer is not pinned: it follows the
                inputs it commits, with any `tools` after it.
            -->
            <div class="flex shrink-0 items-center justify-between gap-3 px-5 py-4 border-b border-gray-100 dark:border-gray-800">
                <h2 id={titleId} class="text-base font-semibold text-gray-950 dark:text-gray-100">{title}</h2>
                {#if dismissible}
                    <button
                        type="button"
                        onclick={close}
                        aria-label="Close"
                        data-dialog-dismiss
                        data-testid="modal-close"
                        class="rounded-lg p-1.5 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
                    >
                        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                            <path d="M6 18 18 6M6 6l12 12" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                    </button>
                {:else if busy}
                    <!--
                        Rule 7: the close affordance disappearing with no explanation reads as a
                        broken dialog. Say why it is gone, in persistent text rather than a
                        tooltip on a control that is not there to hover.
                    -->
                    <span id={busyId} data-testid="modal-busy-reason" class="shrink-0 text-sm text-gray-500 dark:text-gray-400">
                        {busyReason}
                    </span>
                {/if}
            </div>

            <!--
                A real form so Enter in any field runs the primary action. Every dialog here
                used bare inputs, so Enter did nothing in all but one of them; the fix belongs
                once in the shell rather than as a keydown handler per input.
            -->
            <div class="min-h-0 overflow-y-auto">
                <form
                    onsubmit={(e) => {
                        e.preventDefault();
                        if (!busy) onsubmit?.();
                    }}
                >
                    <!-- `display: contents` keeps the layout identical; the fieldset exists only so
                         a busy dialog disables everything inside it without each dialog remembering. -->
                    <fieldset class="contents" disabled={busy} aria-busy={busy}>
                        <div class="px-5 py-4 space-y-4">
                            {@render body()}
                        </div>

                        {#if footer}
                            <div class="flex justify-end gap-2 border-t border-gray-100 dark:border-gray-800 px-5 py-3">
                                {@render footer()}
                            </div>
                        {/if}
                    </fieldset>
                </form>

                {#if tools}
                    <div class="border-t border-gray-100 dark:border-gray-800 px-5 py-4 space-y-4" data-testid="modal-tools">
                        {@render tools()}
                    </div>
                {/if}
            </div>
        </div>
    </div>
{/if}
