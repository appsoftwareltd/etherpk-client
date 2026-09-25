<script lang="ts">
    /**
     * A [[Fenced Code Block]] quoted read-only: the code on the editor's shaded panel, coloured by
     * the editor's own grammar and token table (`code-tokens.ts`), without the fence lines.
     *
     * As in the editor (ADR 0094), code never wraps: a long line stays whole and the block scrolls
     * sideways under a scrollbar at its bottom. The editor has to draw its own bar, its code lines
     * being CodeMirror's and no scroll container; here the <pre> is one, so the bar is the browser's,
     * styled to the editor's thin thumb, and a trackpad swipe, Shift+wheel, a finger or the arrow
     * keys scroll it too. The code's own indentation and blank lines are kept.
     *
     * A long block shows its first {@link COLLAPSED_LINES} lines and a button for the rest, so one
     * pasted log cannot push every other reference out of sight or be parsed on every refresh. The
     * button expands the quote in place and collapses it again; it is not the reference body, so
     * it never opens the source.
     *
     * The code shows as plain text at once and takes its colours when the grammar has loaded (the
     * first fence in a language loads it; later ones reuse it). A language the editor does not know
     * stays plain, as it does in the editor.
     */
    import { codeTokens } from "../code-tokens";
    import { CODE_FONT_SCALE } from "./augmentations/code-highlight";

    let { lang, code }: { lang: string; code: string } = $props();

    /** Lines a long block shows until expanded. */
    const COLLAPSED_LINES = 12;
    /** Fewer hidden lines than this and the block shows whole: a button to reveal two lines is noise. */
    const MIN_HIDDEN_LINES = 4;

    const codeId = $props.id();
    let expanded = $state(false);
    const lines = $derived(code.split("\n"));
    const collapsible = $derived(lines.length - COLLAPSED_LINES >= MIN_HIDDEN_LINES);
    const shown = $derived(collapsible && !expanded ? lines.slice(0, COLLAPSED_LINES).join("\n") : code);
    // The same code gets the same promise back (code-tokens.ts), so a panel refresh that leaves
    // this quote unchanged leaves its DOM alone.
    const tokens = $derived(codeTokens(lang, shown));

    function toggle(event: MouseEvent) {
        // Inside the reference body, whose click opens the source; this click is about the quote.
        event.stopPropagation();
        expanded = !expanded;
    }
</script>

<div class="quoted-code" style:--code-font-scale={CODE_FONT_SCALE}>
    <!-- No whitespace between the tags: inside a <pre> it would be part of the code. Tokens are keyed
         by position, which is all the identity a decomposition of one string has. -->
    <pre id={codeId} data-testid="reference-code" data-lang={lang || undefined}><code
            >{#await tokens}{shown}{:then coloured}{#if coloured}{#each coloured as token, i (i)}{#if token.style}<span
                            style={token.style}>{token.text}</span
                        >{:else}{token.text}{/if}{/each}{:else}{shown}{/if}{:catch}{shown}{/await}</code
        ></pre>
    {#if collapsible}
        <button
            type="button"
            class="quoted-code__toggle"
            aria-expanded={expanded}
            aria-controls={codeId}
            data-testid="reference-code-more"
            onclick={toggle}
        >
            {expanded ? "Show fewer lines" : `Show ${lines.length - COLLAPSED_LINES} more lines`}
        </button>
    {/if}
</div>

<style>
    /* The padding is the panel's, outside the scroller: scrolled code clips 0.7em inside the
       panel's edge rather than at it, and the bar starts and ends the same distance in. */
    .quoted-code {
        margin: 0.2rem 0;
        padding: 0.45em 0.7em;
        border-radius: 5px;
        background: var(--gk-code-bg, rgba(127, 127, 127, 0.1));
    }
    /* Inside the scroller: a gap between the last line and the bar, and room after the longest
       line once it is scrolled to its end, so its last character does not sit on the clip edge. */
    pre {
        margin: 0;
        padding: 0 0.7em 0.3em 0;
        font-family: var(--gk-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        /* The editor's code size relative to prose, floored at the 14px every read text keeps. */
        font-size: max(0.875rem, calc(var(--code-font-scale) * 1em));
        line-height: 1.4;
        /* Never wrapped: see the component comment. */
        white-space: pre;
        overflow-x: auto;
        tab-size: 4;
    }
    /* The editor's bar (code-scroll.ts): a thin rounded thumb on the panel, brighter under the
       pointer. Styling the WebKit scrollbar also keeps it drawn on macOS, whose overlay scrollbars
       would otherwise hide it until the block is scrolled. Firefox takes the standard properties;
       Chromium would let those override the WebKit styling, so they are given to Firefox alone. */
    pre::-webkit-scrollbar {
        height: 0.8em;
    }
    pre::-webkit-scrollbar-track {
        background: transparent;
    }
    pre::-webkit-scrollbar-thumb {
        border: 0.2em solid transparent;
        border-radius: 999px;
        background: var(--gk-code-scrollbar, rgba(127, 127, 127, 0.45)) padding-box;
    }
    pre::-webkit-scrollbar-thumb:hover,
    pre::-webkit-scrollbar-thumb:active {
        background: var(--gk-code-scrollbar-active, rgba(127, 127, 127, 0.7)) padding-box;
    }
    @supports not selector(::-webkit-scrollbar) {
        pre {
            scrollbar-width: thin;
            scrollbar-color: var(--gk-code-scrollbar, rgba(127, 127, 127, 0.45)) transparent;
        }
    }
    code {
        font: inherit;
    }
    /* A quiet text button under the code: muted until pointed at, never smaller than 14px. */
    .quoted-code__toggle {
        display: block;
        margin: 0.3rem 0 0;
        padding: 0.1rem 0;
        border: 0;
        background: transparent;
        color: var(--gk-text-muted, inherit);
        font-family: var(--gk-sans, "Inter", system-ui, sans-serif);
        font-size: 0.875rem;
        cursor: pointer;
    }
    @media (hover: hover) {
        .quoted-code__toggle:hover {
            color: var(--gk-text-default, inherit);
            text-decoration: underline;
        }
    }
    .quoted-code__toggle:focus-visible {
        outline: 2px solid var(--gk-accent, #2563eb);
        outline-offset: 1px;
    }
</style>
