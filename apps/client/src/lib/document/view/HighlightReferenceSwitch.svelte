<script lang="ts">
    /**
     * The **Highlight reference** switch: dim everything in a quoted reference except the link to
     * the document whose backlinks are shown. One setting per graph on this device
     * (`backlinks-preferences.ts`), shown in the Backlinks panel's header and in the header of the
     * section beneath every document (ADR 0135), so both places draw this one control.
     *
     * A switch, not a checkbox: it takes effect at once, there is nothing to submit.
     */
    let { on, onchange }: { on: boolean; onchange: (on: boolean) => void } = $props();
</script>

<button
    type="button"
    role="switch"
    aria-checked={on}
    class="switch"
    data-testid="backlinks-highlight"
    title="Show the rest of each reference in grey, and the link to this document in bold"
    onclick={() => onchange(!on)}
>
    <span class="switch__label">Highlight reference</span>
    <span class="switch__track" aria-hidden="true"><span class="switch__knob"></span></span>
</button>

<style>
    .switch {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.1rem 0;
        border: 0;
        background: transparent;
        color: var(--gk-text-muted, inherit);
        font: inherit;
        font-size: 0.875rem;
        cursor: pointer;
        white-space: nowrap;
    }
    @media (hover: hover) {
        .switch:hover {
            color: var(--gk-text-default);
        }
    }
    /* The track is 2.25 × 1.25rem: big enough to read as a switch and to tap. */
    .switch__track {
        position: relative;
        display: inline-block;
        width: 2.25rem;
        height: 1.25rem;
        border-radius: 999px;
        background: var(--gk-border-strong, rgba(127, 127, 127, 0.4));
        transition: background 120ms ease;
    }
    .switch__knob {
        position: absolute;
        top: 2px;
        left: 2px;
        width: calc(1.25rem - 4px);
        height: calc(1.25rem - 4px);
        border-radius: 50%;
        background: var(--gk-surface-0, #fff);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
        transition: transform 120ms ease;
    }
    .switch[aria-checked="true"] .switch__track {
        background: var(--gk-accent, #2563eb);
    }
    .switch[aria-checked="true"] .switch__knob {
        transform: translateX(1rem);
    }
    /* A finger needs a 44 CSS px target: on a touch screen the switch's row grows to it. */
    @media (pointer: coarse) {
        .switch {
            min-height: 2.75rem;
        }
    }
    .switch:focus-visible {
        outline: 2px solid var(--gk-accent, #2563eb);
        outline-offset: 1px;
    }
    @media (prefers-reduced-motion: reduce) {
        .switch__track,
        .switch__knob {
            transition: none;
        }
    }
</style>
