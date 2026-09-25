<script lang="ts">
    /**
     * The column (sidebar) collapse/expand glyph: a panel with a rail on the
     * given side. Represents the *column*, not its contents — so it stays correct
     * however many tabs the column later holds. Shared by both presenters (desktop
     * toolbar, mobile topbar) so the mirrored pair is drawn in exactly one place.
     */
    let { side }: { side: 'left' | 'right' } = $props()
</script>

<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    {#if side === 'left'}
        <path
            d="M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v11A1.5 1.5 0 0 1 15.5 17h-11A1.5 1.5 0 0 1 3 15.5v-11ZM8 4.5v11H15.5v-11H8Z"
        />
    {:else}
        <path
            d="M17 4.5A1.5 1.5 0 0 0 15.5 3h-11A1.5 1.5 0 0 0 3 4.5v11A1.5 1.5 0 0 0 4.5 17h11A1.5 1.5 0 0 0 17 15.5v-11ZM12 4.5v11H4.5v-11H12Z"
        />
    {/if}
</svg>

<style>
    svg {
        width: 1.1rem;
        height: 1.1rem;
        display: block;
    }
</style>
