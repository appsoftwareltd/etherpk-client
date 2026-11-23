<script lang="ts">
    /**
     * The question asked before a Sidebar View is closed or hidden (ADR 0198, amended 2026-11-23),
     * over whichever workspace's Sidebars asked it.
     */
    import { tick } from "svelte";
    import ConfirmDialog from "@appsoftwareltd/etherpk-shared/confirm-dialog";

    import type { Sidebars } from "./sidebars.svelte";

    let { sidebars }: { sidebars: Sidebars } = $props();

    const prompt = $derived(sidebars.closing());

    /**
     * On a yes, the icon the question came from is gone with its View, so the dialog has nothing to
     * give the focus back to. It goes to the Activity Bar: the icon Tab reaches, or with no icon left
     * the bar's own menu, which brings a View back. Focus that landed anywhere else is left alone.
     */
    async function answer(yes: boolean) {
        sidebars.answerClosing(yes);
        await tick();
        await new Promise(requestAnimationFrame);
        if (document.activeElement !== document.body) return;
        document.querySelector<HTMLElement>('[data-testid="activity-icon"][tabindex="0"], [data-testid="activity-menu"]')?.focus();
    }
</script>

{#if prompt}
    <ConfirmDialog open={true} {...prompt} onconfirm={() => void answer(true)} oncancel={() => void answer(false)} />
{/if}
