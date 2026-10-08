<script lang="ts">
    import { page } from "$app/state";
    import { isCurrentDestination, type AccountMenu, type AccountMenuItem } from "./account-menu";

    /**
     * The links in every app's account menu: the account section, then access tokens below a
     * divider, then the administrator's section under its own heading. Each app wraps them in its own trigger, email line and sign-out, since
     * each ends a different session. The link to the page being shown is marked, as the top
     * navigation marks its own.
     */
    let { menu }: { menu: AccountMenu } = $props();

    const adminHeadingId = $props.id();
</script>

{#snippet link(item: AccountMenuItem)}
    {@const current = isCurrentDestination(item.href, page.url)}
    <a
        href={item.href}
        aria-current={current ? "page" : undefined}
        class={[
            "block rounded-lg px-3 py-2 text-sm font-medium transition-colors",
            current
                ? "bg-gray-50 text-gray-950 dark:bg-white/5 dark:text-white"
                : "text-gray-700 hover:bg-gray-50 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white",
        ]}>{item.label}</a
    >
{/snippet}

{#if menu.account.length > 0 || menu.access.length > 0}
    <nav aria-label="Account navigation">
        {#if menu.account.length > 0}
            <div class="p-2">
                {#each menu.account as item (item.href)}
                    {@render link(item)}
                {/each}
            </div>
        {/if}
        {#if menu.access.length > 0}
            <div data-testid="account-menu-access" class={["p-2", { "border-t border-gray-950/5 dark:border-white/10": menu.account.length > 0 }]}>
                {#each menu.access as item (item.href)}
                    {@render link(item)}
                {/each}
            </div>
        {/if}
    </nav>
{/if}
{#if menu.admin.length > 0}
    <nav data-testid="account-menu-admin" class="border-t border-gray-950/5 p-2 dark:border-white/10" aria-labelledby={adminHeadingId}>
        <p id={adminHeadingId} class="px-3 pb-1 pt-1 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Admin</p>
        {#each menu.admin as item (item.href)}
            {@render link(item)}
        {/each}
    </nav>
{/if}
