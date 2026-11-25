<script lang="ts">
    /**
     * The column (sidebar) collapse/expand glyph: a panel with a rail on the
     * given side. Represents the *column*, not its contents — so it stays correct
     * however many tabs the column later holds. Shared by both presenters (desktop
     * toolbar, mobile topbar) so the mirrored pair is drawn in exactly one place.
     */
    import { SIDEBAR_GLYPH } from '#lib/surface/icons.js'

    let { side }: { side: 'left' | 'right' } = $props()
</script>

<!-- The drawing is the icon table's (`sidebar-left`, `sidebar-right`), which a menu row that moves
     a Sidebar draws too. -->
<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path d={SIDEBAR_GLYPH[side]} />
</svg>

<style>
    svg {
        width: 1.1rem;
        height: 1.1rem;
        display: block;
    }
</style>
