<script lang="ts">
    /**
     * The in-app section sidebar, shared by both applications. The two copies differed only in
     * the navigation's accessible name and in one Server-only admin link, so both are props.
     */
    interface SectionItem {
        href: string;
        label: string;
        icon: string;
    }

    interface AdminLink {
        href: string;
        label: string;
    }

    interface Props {
        items: SectionItem[];
        /** Names this navigation for assistive technology; the apps own different sections. */
        label: string;
        /** Admin links this deployment offers, in order. */
        adminLinks?: AdminLink[];
        isActive: (href: string) => boolean;
        isAdmin: boolean;
        adminExpanded?: boolean;
        onNavigate?: () => void;
    }

    let {
        items,
        label,
        adminLinks = [{ href: "/admin/users", label: "Users" }],
        isActive,
        isAdmin,
        adminExpanded = $bindable(false),
        onNavigate = () => {},
    }: Props = $props();
</script>

<nav class="flex-1 space-y-0.5 overflow-y-auto px-3 py-5" aria-label={label}>
    {#each items as item (item.href)}
        <a href={item.href} onclick={onNavigate} class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors {isActive(item.href) ? 'bg-gray-100 text-gray-950 dark:bg-white/10 dark:text-white' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-950 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white'}" aria-current={isActive(item.href) ? "page" : undefined}>
            <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d={item.icon} stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            {item.label}
        </a>
    {/each}
    {#if isAdmin}
        <div class="mt-3 border-t border-gray-950/5 pt-3 dark:border-white/10">
            <button type="button" onclick={() => (adminExpanded = !adminExpanded)} class="group flex w-full items-center justify-between px-3 py-1" aria-expanded={adminExpanded}>
                <span class="text-sm font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">Admin</span>
                <span aria-hidden="true">{adminExpanded ? "−" : "+"}</span>
            </button>
            {#if adminExpanded}
                {#each adminLinks as link (link.href)}
                    <a href={link.href} onclick={onNavigate} class="block rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-950 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white">{link.label}</a>
                {/each}
            {/if}
        </div>
    {/if}
</nav>
