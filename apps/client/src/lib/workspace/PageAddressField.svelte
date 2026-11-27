<script lang="ts">
    /**
     * The address of the page in front, where a person can read it, copy it and type another
     * (`navigation/page-address.ts` has the rules). An installed web app and a Native App show no
     * address bar, so the workspace toolbar shows this in its place; Go to address… shows it in a
     * dialog wherever there is no toolbar for it.
     *
     * - It reads as the person would type it: `%20` shown as a space. It scrolls to show the end of
     *   the address, the page's name, since every address of a graph starts the same.
     * - Focus selects the whole address, ready to copy or paste over. Enter goes to what was typed.
     *   In the toolbar, Escape or leaving the field puts the address back. In a dialog what was typed
     *   stays until the dialog closes, since its Go button is outside the field.
     * - An address that leads nowhere is refused under the field. The typed text and the focus stay.
     * - In the toolbar it is drawn as muted text (`asText`, Style Guide: The workspace toolbar), lit
     *   under the pointer and ringed while edited; in a dialog it is an ordinary field.
     * - Copy link copies the link of where the app runs: the web address in a browser, an EtherPK
     *   Link in a Native App. A Native App on a synced graph also offers the web address.
     */
    import { browser } from '$app/env'
    import { page } from '$app/state'

    import { addressPlace } from '#lib/native/web-address.js'
    import { currentAddressPath } from '#lib/navigation/current-address.js'
    import { ADDRESS_REFUSAL_COPY, type AddressRefusal, pageLink, pageWebAddress, readableAddress, readAddress } from '#lib/navigation/page-address.js'
    import { copyPageAddress } from '#lib/navigation/page-link-copy.js'
    import { iconSvg } from '#lib/surface/icons.js'

    let {
        ongo,
        small = false,
        floatingError = false,
        label = 'Page address',
        id = 'page-address',
        inDialog = false,
        asText = false,
    }: {
        /** Go to a page's path. */
        ongo: (path: string) => void
        /** The toolbar's size: a 30px field and the toolbar's icon buttons. */
        small?: boolean
        /** Show a refusal over what is below, so a toolbar does not grow under the pointer. */
        floatingError?: boolean
        /** The field's name for a screen reader, where no visible label names it. */
        label?: string
        /** The field's id, and the start of its error's id. */
        id?: string
        /**
         * In a dialog, leaving the field keeps what was typed, since the dialog's Go button is outside
         * it, and Escape is left to the dialog, which closes.
         */
        inDialog?: boolean
        /**
         * Drawn as text in the toolbar's ink, muted, until the pointer is over it or it is being
         * edited, so the toolbar reads as a heading and an address rather than a form.
         */
        asText?: boolean
    } = $props()

    /** How long a copy button shows its tick. */
    const COPIED_MS = 1500

    // Rendered on the server too (the Style Guide's specimens), where there is no window: there the
    // address is the page's own, as the request named it.
    const place = browser ? addressPlace() : { origin: page.url.origin, webOrigin: null, native: false }
    // `page.url` for real navigations, `currentAddressPath` for the shallow writes it never sees.
    const path = $derived.by(() => {
        if (!browser) return `${page.url.pathname}${page.url.search}`
        void page.url
        return currentAddressPath()
    })
    const link = $derived(pageLink(path, place))
    const webAddress = $derived(pageWebAddress(path, place))
    const shown = $derived(readableAddress(link))

    let input = $state<HTMLInputElement>()
    /** What the person is typing, or null while the field shows the address. */
    let draft = $state<string | null>(null)
    let refusal = $state<AddressRefusal | null>(null)
    /** Which button shows its tick. */
    let copied = $state<'link' | 'web' | null>(null)
    let copiedTimer: ReturnType<typeof setTimeout> | undefined
    /** The first mouse-up after a click into the field would undo the select-all, so it is skipped. */
    let keepSelection = false

    const errorId = $derived(`${id}-error`)

    /** Put the caret in the field, with the whole address selected. */
    export function focus(): void {
        input?.focus()
    }

    /** Go to what is typed, or say why not. */
    export function submit(): void {
        const reading = readAddress(draft ?? shown, place)
        if (!reading.ok) {
            refusal = reading.refusal
            input?.focus()
            return
        }
        draft = null
        refusal = null
        input?.blur()
        ongo(reading.path)
    }

    function restore(): void {
        draft = null
        refusal = null
    }

    function onfocus(): void {
        draft ??= shown
        keepSelection = true
        input?.select()
    }

    function onkeydown(event: KeyboardEvent): void {
        if (event.key === 'Enter') {
            event.preventDefault()
            submit()
        } else if (event.key === 'Escape' && !inDialog) {
            // The field's own Escape: the address comes back, and nothing behind it closes.
            event.preventDefault()
            event.stopPropagation()
            restore()
            input?.blur()
        }
    }

    function oninput(event: Event): void {
        draft = (event.currentTarget as HTMLInputElement).value
        // Refused once, judged again only on the next Enter: the words under the field stay until then.
    }

    async function copy(which: 'link' | 'web'): Promise<void> {
        const text = which === 'link' ? link : webAddress
        if (text === null) return
        const landed = await copyPageAddress(text, which === 'link' ? 'the link to this page' : 'the web address of this page')
        if (!landed) return
        copied = which
        clearTimeout(copiedTimer)
        copiedTimer = setTimeout(() => (copied = null), COPIED_MS)
    }

    /** Show the end of the address, the page's name, whenever it changes while nobody is typing. */
    function showEnd(node: HTMLInputElement) {
        void shown
        if (draft !== null) return
        requestAnimationFrame(() => {
            if (draft === null) node.scrollLeft = node.scrollWidth
        })
    }

    $effect(() => () => clearTimeout(copiedTimer))
</script>

<div class="address" class:small data-testid="page-address">
    <div class="field">
        <input
            bind:this={input}
            {id}
            class={asText ? 'address-text' : ['gk-input', small && 'gk-input--small']}
            data-own-field-style={asText ? "the toolbar's address reads as muted text in the toolbar's ink until it is edited (Style Guide, The workspace toolbar)" : undefined}
            type="text"
            inputmode="url"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            aria-label={label}
            aria-invalid={refusal !== null}
            aria-describedby={refusal !== null ? errorId : undefined}
            value={draft ?? shown}
            data-testid="page-address-input"
            {@attach showEnd}
            {onfocus}
            onblur={() => {
                if (!inDialog) restore()
            }}
            {onkeydown}
            {oninput}
            onmouseup={(event) => {
                if (keepSelection) event.preventDefault()
                keepSelection = false
            }}
        />
        {#if refusal !== null}
            <p class="gk-error" class:floating={floatingError} id={errorId} data-testid="page-address-error">{ADDRESS_REFUSAL_COPY[refusal]}</p>
        {/if}
    </div>
    <button
        type="button"
        class="gk-icon-button"
        aria-label={copied === 'link' ? 'Copied' : 'Copy link'}
        data-tooltip={copied === 'link' ? 'Copied' : 'Copy link'}
        data-testid="page-address-copy"
        onclick={() => void copy('link')}
    >
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
        {@html iconSvg(copied === 'link' ? 'check' : 'copy', { size: 16 })}
    </button>
    {#if webAddress !== null}
        <button
            type="button"
            class="gk-icon-button"
            aria-label={copied === 'web' ? 'Copied' : 'Copy web address'}
            data-tooltip={copied === 'web' ? 'Copied' : 'Copy web address'}
            data-testid="page-address-copy-web"
            onclick={() => void copy('web')}
        >
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
            {@html iconSvg(copied === 'web' ? 'check' : 'globe', { size: 16 })}
        </button>
    {/if}
    <!-- A copy shows only as a tick, which a screen reader does not see change on a button it left. -->
    <span class="sr-only" role="status">{copied ? 'Copied.' : ''}</span>
</div>

<style>
    .address {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        min-width: 0;
    }
    .field {
        position: relative;
        flex: 1 1 auto;
        min-width: 0;
    }
    /* The toolbar's own field: it takes the room the heading leaves, up to a width that still reads
       as one line of an address, and gives way before the toggles do. */
    .address.small {
        flex: 1 1 28rem;
        max-width: 40rem;
        min-width: 10rem;
    }
    /* Drawn as text, it is as wide as the address, up to the same 40rem. */
    @supports (field-sizing: content) {
        .address.small:has(> .field > .address-text) {
            flex: 0 1 auto;
        }
        /* A set width would win over the content's own. */
        input.address-text {
            width: auto;
        }
    }
    /* The icon buttons on a graph's toolbar colour take the ink that reads on it, as the toggles do. */
    .address.small > .gk-icon-button {
        flex: none;
        color: var(--gk-toolbar-ink, var(--gk-text-muted));
    }
    .address.small > .gk-icon-button:hover {
        background: var(--gk-toolbar-hover, var(--gk-menu-hover));
        color: var(--gk-toolbar-ink, var(--gk-text-strong));
    }
    /*
     * The toolbar's address as text: no border and no fill, 14px in the ink of the toolbar's colour
     * where one is set and otherwise the theme's muted grey, as the heading's icons are. The pointer
     * lights it with the toggles' wash, and editing keeps the wash, darkens the text and draws the
     * focus ring, so it is plain that the text can be typed over. Same 30px box as a small field in
     * every state, so nothing moves when it is clicked.
     */
    input.address-text {
        display: block;
        width: 100%;
        min-width: 0;
        /* As wide as the address, so the copy button sits after its last word, as a heading's icons
           sit after its name. A browser without it (Firefox, Safari) keeps the toolbar's width. */
        field-sizing: content;
        max-width: 100%;
        height: 1.875rem;
        margin: 0;
        padding: 0.25rem 0.5rem;
        border: 1px solid transparent;
        border-radius: 0.375rem;
        background: transparent;
        color: var(--gk-toolbar-ink, var(--gk-text-muted));
        font: inherit;
        font-size: 0.875rem;
        line-height: 1.25rem;
        cursor: text;
    }
    input.address-text:hover,
    input.address-text:focus {
        background: var(--gk-toolbar-hover, var(--gk-menu-hover));
        color: var(--gk-toolbar-ink, var(--gk-text-strong));
    }
    input.address-text:focus {
        outline: none;
        border-color: var(--gk-field-focus);
        box-shadow: 0 0 0 1px var(--gk-field-focus);
    }
    input.address-text[aria-invalid='true'] {
        border-color: var(--gk-text-danger);
        box-shadow: 0 0 0 1px var(--gk-text-danger);
    }
    .gk-error {
        margin: 0.25rem 0 0;
    }
    /* Over what is below, in the menu's colours, so the toolbar keeps its height. */
    .gk-error.floating {
        position: absolute;
        top: 100%;
        left: 0;
        z-index: var(--z-menu);
        width: max-content;
        max-width: 24rem;
        padding: 0.375rem 0.625rem;
        border: 1px solid var(--gk-menu-border);
        border-radius: 0.375rem;
        background: var(--gk-menu-bg);
        box-shadow: var(--gk-menu-shadow);
    }
</style>
