<script lang="ts">
    /**
     * Agent Chat's mark: the robot Agent Kanban uses (Lucide's "bot", ISC), on its own 24-unit grid.
     * The manifest's `agent-chat` icon is the same drawing on the Client's 16-unit grid.
     */
    const { class: className = "size-4" }: { class?: string } = $props();
</script>

<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class={["shrink-0", className]}>
    <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" />
    <path d="M9 13v2" />
</svg>
