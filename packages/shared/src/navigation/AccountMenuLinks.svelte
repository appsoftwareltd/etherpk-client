<script lang="ts">
    import { page } from "$app/state";
    import { isCurrentDestination, type AccountMenu, type AccountMenuItem } from "./account-menu";

    /**
     * The links in every app's account menu: the account section, then access tokens below a
     * separator, then the administrator's section under its own heading. Each app wraps them in its own trigger, email line and sign-out, since
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
        class={["gk-menu-item", current && "bg-(--gk-menu-hover) font-medium"]}>{item.label}</a
    >
{/snippet}

{#if menu.account.length > 0 || menu.access.length > 0}
    <nav aria-label="Account navigation">
        {#if menu.account.length > 0}
            <div>
                {#each menu.account as item (item.href)}
                    {@render link(item)}
                {/each}
            </div>
        {/if}
        {#if menu.access.length > 0}
            {#if menu.account.length > 0}<hr class="gk-menu-separator" />{/if}
            <div data-testid="account-menu-access">
                {#each menu.access as item (item.href)}
                    {@render link(item)}
                {/each}
            </div>
        {/if}
    </nav>
{/if}
{#if menu.admin.length > 0}
    <hr class="gk-menu-separator" />
    <nav data-testid="account-menu-admin" aria-labelledby={adminHeadingId}>
        <p id={adminHeadingId} class="px-3 py-1 text-sm font-semibold uppercase tracking-wider text-(--gk-text-muted)">Admin</p>
        {#each menu.admin as item (item.href)}
            {@render link(item)}
        {/each}
    </nav>
{/if}
