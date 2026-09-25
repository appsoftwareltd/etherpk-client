import { describe, expect, it } from 'vitest'
import { untypedDialogButtons } from './dialog-buttons'

describe('untypedDialogButtons', () => {
    it('reports an untyped button inside a body snippet', () => {
        const source = `<Dialog>
    {#snippet body()}
        <button onclick={go}>Go</button>
    {/snippet}
</Dialog>`
        expect(untypedDialogButtons(source)).toEqual([3])
    })

    it('accepts a button that declares its type', () => {
        const source = `{#snippet footer()}
    <button type="submit">Save</button>
{/snippet}`
        expect(untypedDialogButtons(source)).toEqual([])
    })

    it('ignores buttons outside any dialog snippet', () => {
        const source = `<button onclick={openDialog}>Open</button>
{#snippet body()}
    <p>nothing here</p>
{/snippet}`
        expect(untypedDialogButtons(source)).toEqual([])
    })

    it('ignores a button written inside a comment', () => {
        const source = `{#snippet body()}
    <!-- a <button> in prose is documentation, not markup -->
    <button type="button">Real</button>
{/snippet}`
        expect(untypedDialogButtons(source)).toEqual([])
    })

    it('handles attributes spread over several lines', () => {
        const source = `{#snippet body()}
    <button
        onclick={go}
        class="x"
    >Go</button>
{/snippet}`
        expect(untypedDialogButtons(source)).toEqual([2])
    })

    it('scans everything in wholeFile mode, for components that render into someone else’s dialog', () => {
        const source = `<div>
    <button onclick={scan}>Scan</button>
</div>`
        expect(untypedDialogButtons(source)).toEqual([])
        expect(untypedDialogButtons(source, { wholeFile: true })).toEqual([2])
    })
})
