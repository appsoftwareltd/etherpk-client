<script lang="ts">
    /**
     * **Reset workspace**, under the Primary Sidebar on the General tab of a graph's settings and in
     * a [[Plain Folder]]'s. It asks in place: the form it is in stays as it was until the answer is
     * yes, and a second dialog over this one would fight it for the focus and Escape. From the
     * Activity Bar's menu and the Command Menu the same question is a dialog of its own.
     */
    import { tick } from 'svelte'

    import { RESET_WORKSPACE_PROMPT } from '#lib/workspace/workspace-reset.js'

    let {
        onreset,
        unsaved = false,
    }: {
        onreset: () => void
        /** The form around this has a Save, so what is not saved goes when the reset closes it. */
        unsaved?: boolean
    } = $props()

    let asking = $state(false)
    let trigger = $state<HTMLButtonElement>()
    let cancel = $state<HTMLButtonElement>()

    async function ask() {
        asking = true
        await tick()
        cancel?.focus()
    }
    async function stop() {
        asking = false
        await tick()
        trigger?.focus()
    }
</script>

<div class="gk-field" data-testid="reset-workspace-setting">
    <span class="gk-label" id="reset-workspace-label">Workspace</span>
    {#if asking}
        <div role="group" aria-labelledby="reset-workspace-question">
            <p class="gk-hint" id="reset-workspace-question">
                {RESET_WORKSPACE_PROMPT.title}
                {RESET_WORKSPACE_PROMPT.message}
                {#if unsaved}Changes to these settings that you have not saved are not kept.{/if}
            </p>
            <div class="mt-2 flex flex-wrap gap-2">
                <button type="button" class="gk-button" bind:this={cancel} onclick={stop} data-testid="reset-workspace-cancel">Cancel</button>
                <button type="button" class="gk-button gk-button--primary" onclick={onreset} data-testid="reset-workspace-confirm">{RESET_WORKSPACE_PROMPT.confirmLabel}</button>
            </div>
        </div>
    {:else}
        <div>
            <button type="button" class="gk-button" bind:this={trigger} onclick={ask} aria-describedby="reset-workspace-hint" data-testid="reset-workspace">Reset workspace</button>
        </div>
        <p class="gk-hint" id="reset-workspace-hint">Closes every tab, and puts both sidebars and their views back to the defaults.</p>
    {/if}
</div>
