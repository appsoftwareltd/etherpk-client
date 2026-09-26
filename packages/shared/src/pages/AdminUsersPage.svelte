<script lang="ts">
    import { browser } from "$app/environment";
    import Dialog from "../components/Dialog.svelte";
    import type { AdminAuthClient } from "../auth/page-clients";

    /**
     * Shared with the other application, which rendered a byte-identical copy. Only the
     * post-impersonation destination and the Better Auth client differ, and both arrive as
     * props rather than being branched on inside the page.
     */
    let {
        data,
        authClient,
        impersonationDestination,
    }: {
        data: { user?: { id: string } | null };
        authClient: AdminAuthClient;
        /** Where to land after starting an impersonation session. */
        impersonationDestination: string;
    } = $props();
    let currentUserId = $derived(data.user?.id);

    // ── Types ─────────────────────────────────────────────────────
    interface AdminUser {
        id: string;
        name: string;
        email: string;
        image?: string | null;
        emailVerified: boolean;
        role: string;
        banned: boolean | null;
        banReason: string | null;
        banExpires: number | null;
        /** Better Auth's twoFactor plugin field; absent on a user that never turned it on. */
        twoFactorEnabled?: boolean | null;
        createdAt: Date;
    }

    interface UserSession {
        id: string;
        token: string;
        userId: string;
        expiresAt: Date;
        ipAddress?: string | null;
        userAgent?: string | null;
        createdAt: Date;
    }

    // ── User list state ───────────────────────────────────────────
    let users = $state<AdminUser[]>([]);
    let total = $state(0);
    let loading = $state(true);
    let error = $state<string | null>(null);

    // ── Search / filter / pagination ──────────────────────────────
    let searchValue = $state("");
    let debouncedSearch = $state("");
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    let roleFilter = $state<"all" | "admin" | "user">("all");
    let currentPage = $state(1);
    const limit = 20;
    let totalPages = $derived(Math.max(1, Math.ceil(total / limit)));

    // ── Action feedback ───────────────────────────────────────────
    let actionError = $state<string | null>(null);
    let actionSuccess = $state<string | null>(null);
    let successTimer: ReturnType<typeof setTimeout> | null = null;

    // ── Modal state: Ban ──────────────────────────────────────────
    let banModalUser = $state<AdminUser | null>(null);
    let banReason = $state("");
    let banDuration = $state<string>("permanent");
    let banning = $state(false);

    // ── Modal state: Reset password ───────────────────────────────
    let resetPasswordUser = $state<AdminUser | null>(null);
    let newPassword = $state("");
    let resettingPassword = $state(false);

    // ── Modal state: Reset two-factor ─────────────────────────────
    let resetTwoFactorUser = $state<AdminUser | null>(null);
    let resettingTwoFactor = $state(false);

    // ── Modal state: Delete ───────────────────────────────────────
    let deleteModalUser = $state<AdminUser | null>(null);
    let deleteConfirmEmail = $state("");
    let deleting = $state(false);

    // ── Sessions expansion ────────────────────────────────────────
    let expandedSessionsUserId = $state<string | null>(null);
    let userSessions = $state<UserSession[]>([]);
    let loadingSessions = $state(false);
    let revokingSession = $state<string | null>(null);
    let revokingAllSessions = $state(false);

    // ── Modal state: Role change ─────────────────────────────────
    let roleChangeUser = $state<AdminUser | null>(null);
    let changingRole = $state(false);

    // ── Per-user action loading ───────────────────────────────────
    let impersonating = $state<string | null>(null);
    let unbanning = $state<string | null>(null);

    // ── Effect: load users on param change ────────────────────────
    $effect(() => {
        const _search = debouncedSearch;
        const _role = roleFilter;
        const _page = currentPage;
        if (browser) {
            fetchUsers(_search, _role, _page);
        }
    });

    function handleSearchInput(e: Event) {
        const value = (e.target as HTMLInputElement).value;
        searchValue = value;
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            debouncedSearch = value;
            currentPage = 1;
        }, 300);
    }

    function setRoleFilter(role: "all" | "admin" | "user") {
        roleFilter = role;
        currentPage = 1;
    }

    // ── Fetch users ───────────────────────────────────────────────
    /** Monotonic request id: only the newest fetch may write to the table. */
    let requestSeq = 0;

    async function fetchUsers(search: string, role: string, page: number) {
        const seq = ++requestSeq;
        loading = true;
        error = null;
        try {
            const query: Record<string, string | number> = {
                limit,
                offset: (page - 1) * limit,
                sortBy: "createdAt",
                sortDirection: "desc",
            };
            if (search) {
                query.searchValue = search;
                query.searchField = "email";
                query.searchOperator = "contains";
            }
            if (role !== "all") {
                query.filterField = "role";
                query.filterValue = role;
                query.filterOperator = "eq";
            }
            const res = await authClient.admin.listUsers({ query });
            if (seq !== requestSeq) return; // a newer query has already been issued
            if (res.error) throw new Error(res.error.message || "Failed to load users");
            users = (res.data?.users ?? []) as unknown as AdminUser[];
            total = res.data?.total ?? 0;
        } catch (err) {
            if (seq !== requestSeq) return;
            error = err instanceof Error ? err.message : "Failed to load users";
            users = [];
            total = 0;
        } finally {
            if (seq === requestSeq) loading = false;
        }
    }

    // ── Set role ──────────────────────────────────────────────────
    function openRoleChangeModal(user: AdminUser) {
        roleChangeUser = user;
    }

    async function confirmRoleChange() {
        if (!roleChangeUser || roleChangeUser.id === currentUserId) return;
        changingRole = true;
        clearFeedback();
        try {
            const newRole = roleChangeUser.role === "admin" ? "user" : "admin";
            const res = await authClient.admin.setRole({ userId: roleChangeUser.id, role: newRole });
            if (res.error) throw new Error(res.error.message || "Failed to set role");
            roleChangeUser.role = newRole;
            showSuccess(`Role updated to ${newRole}`);
            roleChangeUser = null;
        } catch (err) {
            actionError = err instanceof Error ? err.message : "Failed to update role";
        } finally {
            changingRole = false;
        }
    }

    // ── Ban user ──────────────────────────────────────────────────
    function openBanModal(user: AdminUser) {
        banModalUser = user;
        banReason = "";
        banDuration = "permanent";
    }

    async function confirmBan() {
        if (!banModalUser) return;
        banning = true;
        clearFeedback();
        try {
            const params: { userId: string; banReason?: string; banExpiresIn?: number } = { userId: banModalUser.id };
            if (banReason) params.banReason = banReason;
            if (banDuration !== "permanent") {
                const durations: Record<string, number> = {
                    "1h": 3600,
                    "24h": 86400,
                    "7d": 604800,
                    "30d": 2592000,
                };
                params.banExpiresIn = durations[banDuration] ?? 0;
            }
            const res = await authClient.admin.banUser(params);
            if (res.error) throw new Error(res.error.message || "Failed to ban user");
            banModalUser.banned = true;
            banModalUser.banReason = banReason || null;
            showSuccess(`${banModalUser.name || banModalUser.email} has been banned`);
            banModalUser = null;
        } catch (err) {
            actionError = err instanceof Error ? err.message : "Failed to ban user";
        } finally {
            banning = false;
        }
    }

    // ── Unban user ────────────────────────────────────────────────
    async function unbanUser(user: AdminUser) {
        unbanning = user.id;
        clearFeedback();
        try {
            const res = await authClient.admin.unbanUser({ userId: user.id });
            if (res.error) throw new Error(res.error.message || "Failed to unban user");
            user.banned = false;
            user.banReason = null;
            user.banExpires = null;
            showSuccess(`${user.name || user.email} has been unbanned`);
        } catch (err) {
            actionError = err instanceof Error ? err.message : "Failed to unban user";
        } finally {
            unbanning = null;
        }
    }

    // ── Reset password ────────────────────────────────────────────
    function openResetPasswordModal(user: AdminUser) {
        resetPasswordUser = user;
        newPassword = "";
    }

    async function confirmResetPassword() {
        if (!resetPasswordUser || !newPassword) return;
        resettingPassword = true;
        clearFeedback();
        try {
            const res = await authClient.admin.setUserPassword({
                userId: resetPasswordUser.id,
                newPassword,
            });
            if (res.error) throw new Error(res.error.message || "Failed to reset password");
            showSuccess(`Password reset for ${resetPasswordUser.name || resetPasswordUser.email}`);
            resetPasswordUser = null;
            newPassword = "";
        } catch (err) {
            actionError = err instanceof Error ? err.message : "Failed to reset password";
        } finally {
            resettingPassword = false;
        }
    }

    // ── Reset two-factor ──────────────────────────────────────────
    // Better Auth's admin plugin has no call for this, so each app serves the same path. It is
    // the way back in for a user with no authenticator and no backup codes.
    async function confirmResetTwoFactor() {
        const user = resetTwoFactorUser;
        if (!user || resettingTwoFactor) return;
        resettingTwoFactor = true;
        clearFeedback();
        try {
            const res = await fetch(`/admin/users/${encodeURIComponent(user.id)}/two-factor`, { method: "DELETE" });
            if (!res.ok) {
                const body = (await res.json().catch(() => null)) as { message?: string } | null;
                throw new Error(body?.message || `The server refused the reset (HTTP ${res.status}). Try again, or reload the page.`);
            }
            users = users.map((u) => (u.id === user.id ? { ...u, twoFactorEnabled: false } : u));
            showSuccess(`Two-factor authentication is off for ${user.name || user.email}. They can sign in with their password.`);
            resetTwoFactorUser = null;
        } catch (err) {
            // The dialog stays open, as the other admin dialogs do, so a retry is one click away.
            actionError = err instanceof Error ? err.message : "Failed to reset two-factor authentication";
        } finally {
            resettingTwoFactor = false;
        }
    }

    // ── Impersonate ───────────────────────────────────────────────
    async function impersonateUser(user: AdminUser) {
        if (user.id === currentUserId) return;
        impersonating = user.id;
        clearFeedback();
        try {
            const res = await authClient.admin.impersonateUser({ userId: user.id });
            if (res.error) throw new Error(res.error.message || "Failed to impersonate user");
            window.location.href = impersonationDestination;
        } catch (err) {
            actionError = err instanceof Error ? err.message : "Failed to impersonate user";
            impersonating = null;
        }
    }

    // ── View sessions ─────────────────────────────────────────────
    async function toggleSessions(userId: string) {
        if (expandedSessionsUserId === userId) {
            expandedSessionsUserId = null;
            userSessions = [];
            return;
        }
        expandedSessionsUserId = userId;
        loadingSessions = true;
        try {
            const res = await authClient.admin.listUserSessions({ userId });
            if (res.error) throw new Error(res.error.message || "Failed to load sessions");
            userSessions = (res.data?.sessions ?? []) as unknown as UserSession[];
        } catch (err) {
            actionError = err instanceof Error ? err.message : "Failed to load sessions";
            expandedSessionsUserId = null;
        } finally {
            loadingSessions = false;
        }
    }

    // ── Revoke session ────────────────────────────────────────────
    async function revokeSession(sessionToken: string) {
        revokingSession = sessionToken;
        clearFeedback();
        try {
            const res = await authClient.admin.revokeUserSession({ sessionToken });
            if (res.error) throw new Error(res.error.message || "Failed to revoke session");
            userSessions = userSessions.filter((s) => s.token !== sessionToken);
            showSuccess("Session revoked");
        } catch (err) {
            actionError = err instanceof Error ? err.message : "Failed to revoke session";
        } finally {
            revokingSession = null;
        }
    }

    // ── Revoke all sessions ───────────────────────────────────────
    async function revokeAllSessions(userId: string) {
        revokingAllSessions = true;
        clearFeedback();
        try {
            const res = await authClient.admin.revokeUserSessions({ userId });
            if (res.error) throw new Error(res.error.message || "Failed to revoke sessions");
            userSessions = [];
            showSuccess("All sessions revoked");
        } catch (err) {
            actionError = err instanceof Error ? err.message : "Failed to revoke sessions";
        } finally {
            revokingAllSessions = false;
        }
    }

    // ── Delete user ───────────────────────────────────────────────
    function openDeleteModal(user: AdminUser) {
        deleteModalUser = user;
        deleteConfirmEmail = "";
    }

    async function confirmDelete() {
        if (!deleteModalUser || deleteConfirmEmail !== deleteModalUser.email) return;
        deleting = true;
        clearFeedback();
        try {
            const res = await authClient.admin.removeUser({ userId: deleteModalUser.id });
            if (res.error) throw new Error(res.error.message || "Failed to delete user");
            showSuccess(`${deleteModalUser.name || deleteModalUser.email} has been deleted`);
            const deletedId = deleteModalUser.id;
            deleteModalUser = null;
            users = users.filter((u) => u.id !== deletedId);
            total--;
        } catch (err) {
            actionError = err instanceof Error ? err.message : "Failed to delete user";
        } finally {
            deleting = false;
        }
    }

    // ── Helpers ───────────────────────────────────────────────────
    function clearFeedback() {
        actionError = null;
        actionSuccess = null;
        if (successTimer) clearTimeout(successTimer);
    }

    function showSuccess(message: string) {
        actionSuccess = message;
        if (successTimer) clearTimeout(successTimer);
        successTimer = setTimeout(() => (actionSuccess = null), 3000);
    }

    function formatDate(dateValue: Date | string | null | undefined) {
        if (!dateValue) return "\u2014";
        const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
        return d.toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
        });
    }

    function formatDateTime(dateValue: Date | string | null | undefined) {
        if (!dateValue) return "\u2014";
        const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
        return (
            d.toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
            }) +
            " " +
            d.toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
            })
        );
    }

    function truncateToken(token: string) {
        if (token.length <= 16) return token;
        return token.slice(0, 8) + "\u2026" + token.slice(-8);
    }

    function parseUserAgent(ua: string | null | undefined) {
        if (!ua) return "Unknown";
        if (ua.includes("Edge")) return "Edge";
        if (ua.includes("Chrome") && !ua.includes("Edge")) return "Chrome";
        if (ua.includes("Firefox")) return "Firefox";
        if (ua.includes("Safari") && !ua.includes("Chrome")) return "Safari";
        return "Other";
    }

    function initial(name: string | null | undefined) {
        if (!name) return "?";
        return name.charAt(0).toUpperCase();
    }

    const isSelf = (userId: string) => userId === currentUserId;
</script>

<svelte:head>
    <title>User Management - EtherPK</title>
</svelte:head>

<div class="max-w-4xl">
    <div class="mb-8">
        <h1 class="text-2xl font-semibold tracking-tight text-gray-950">User Management</h1>
        <p class="mt-1 text-sm text-gray-500">Manage user accounts, roles, sessions, and access.</p>
    </div>

    <!-- ── Feedback alerts ───────────────────────────────────────── -->
    {#if actionError}
        <div class="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 flex items-center justify-between">
            <span>{actionError}</span>
            <button onclick={() => (actionError = null)} class="text-red-400 hover:text-red-600 ml-3" aria-label="Dismiss">&times;</button>
        </div>
    {/if}
    {#if actionSuccess}
        <div class="mb-6 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-700 flex items-center justify-between">
            <span>{actionSuccess}</span>
            <button onclick={() => (actionSuccess = null)} class="text-emerald-400 hover:text-emerald-600 ml-3" aria-label="Dismiss">&times;</button>
        </div>
    {/if}

    <!-- ── Search / filter row ───────────────────────────────────── -->
    <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div class="flex items-center gap-1">
            <button onclick={() => setRoleFilter("all")} class="rounded-full px-3 py-1 text-sm font-medium transition-colors {roleFilter === 'all' ? 'bg-gray-950 dark:bg-white/15 text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/15'}">All</button>
            <button onclick={() => setRoleFilter("admin")} class="rounded-full px-3 py-1 text-sm font-medium transition-colors {roleFilter === 'admin' ? 'bg-gray-950 dark:bg-white/15 text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/15'}">Admin</button>
            <button onclick={() => setRoleFilter("user")} class="rounded-full px-3 py-1 text-sm font-medium transition-colors {roleFilter === 'user' ? 'bg-gray-950 dark:bg-white/15 text-white' : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-white/15'}">User</button>
        </div>
        <div class="flex items-center gap-3">
            <input type="search" aria-label="Search users by email" value={searchValue} oninput={handleSearchInput} placeholder="Search by email\u2026" class="w-56 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 placeholder-gray-400 focus:border-gray-950 focus:outline-none focus:ring-1 focus:ring-gray-950" />
            <span class="text-sm text-gray-400">{total} user{total !== 1 ? "s" : ""}</span>
        </div>
    </div>

    <!-- ── User list ─────────────────────────────────────────────── -->
    <div class="rounded-xl border border-gray-950/8 bg-white shadow-sm divide-y divide-gray-950/5">
        {#if loading && users.length === 0}
            <!-- Loading skeleton: first load only, when there is nothing worth keeping on screen. -->
            {#each Array(3) as _, skeletonRow (skeletonRow)}
                <div class="px-6 py-5 motion-safe:animate-pulse">
                    <div class="flex items-center gap-3">
                        <div class="h-9 w-9 rounded-full bg-gray-200"></div>
                        <div class="flex-1 space-y-2">
                            <div class="h-3.5 w-32 rounded bg-gray-200"></div>
                            <div class="h-3 w-48 rounded bg-gray-100"></div>
                        </div>
                    </div>
                </div>
            {/each}
        {:else if error}
            <div class="px-6 py-8 text-center">
                <p class="text-sm text-red-600">{error}</p>
                <button onclick={() => fetchUsers(debouncedSearch, roleFilter, currentPage)} class="mt-2 text-sm text-gray-500 hover:text-gray-700 underline underline-offset-2">Retry</button>
            </div>
        {:else if users.length === 0}
            <div class="px-6 py-8 text-center">
                <p class="text-sm text-gray-400">No users found.</p>
                {#if debouncedSearch || roleFilter !== "all"}
                    <p class="mt-1 text-sm text-gray-400">Try adjusting your search or filter.</p>
                {/if}
            </div>
        {:else}
            <!-- A refresh dims the existing rows rather than replacing them with a skeleton:
                 the results are stale, not absent (rule 12). -->
            <div class="divide-y divide-gray-950/5 motion-safe:transition-opacity duration-150" class:opacity-60={loading} aria-busy={loading}>
            {#each users as user (user.id)}
                <div class="px-6 py-4 {user.banned ? 'bg-red-50/50' : ''}">
                    <!-- User info row -->
                    <div class="flex items-start gap-3">
                        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-100 text-sm font-semibold text-gray-500">
                            {initial(user.name)}
                        </div>
                        <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2 flex-wrap">
                                <p class="text-sm font-medium text-gray-950 truncate">{user.name || "\u2014"}</p>
                                {#if user.role === "admin"}
                                    <span class="inline-flex items-center rounded-full bg-violet-50 px-2 py-0.5 text-sm font-medium text-violet-700 ring-1 ring-violet-600/20">Admin</span>
                                {/if}
                                {#if user.banned}
                                    <span class="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-sm font-medium text-red-700 ring-1 ring-red-600/20">Banned</span>
                                {/if}
                                {#if user.twoFactorEnabled}
                                    <span class="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-sm font-medium text-emerald-700 ring-1 ring-emerald-600/20">2FA</span>
                                {/if}
                                {#if isSelf(user.id)}
                                    <span class="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-sm font-medium text-blue-700 ring-1 ring-blue-600/20">You</span>
                                {/if}
                            </div>
                            <p class="text-sm text-gray-500 truncate">{user.email}</p>
                            <p class="text-sm text-gray-400 mt-0.5">Joined {formatDate(user.createdAt)}</p>
                            {#if user.banned && user.banReason}
                                <p class="text-sm text-red-600 mt-0.5">Reason: {user.banReason}</p>
                            {/if}
                        </div>
                    </div>

                    <!-- Action buttons -->
                    <div class="mt-3 ml-12 flex flex-wrap items-center gap-1.5">
                        <!-- Role toggle -->
                        {#if !isSelf(user.id)}
                            <button onclick={() => openRoleChangeModal(user)} class="rounded-md px-2 py-1 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors">
                                {user.role === "admin" ? "Make user" : "Make admin"}
                            </button>
                        {/if}

                        <!-- Ban / Unban -->
                        {#if !isSelf(user.id)}
                            {#if user.banned}
                                <button onclick={() => unbanUser(user)} disabled={unbanning === user.id} class="rounded-md px-2 py-1 text-sm font-medium text-emerald-700 hover:bg-emerald-50 transition-colors disabled:opacity-50">
                                    {unbanning === user.id ? "\u2026" : "Unban"}
                                </button>
                            {:else}
                                <button onclick={() => openBanModal(user)} class="rounded-md px-2 py-1 text-sm font-medium text-amber-700 hover:bg-amber-50 transition-colors"> Ban </button>
                            {/if}
                        {/if}

                        <!-- Reset password -->
                        <button onclick={() => openResetPasswordModal(user)} class="rounded-md px-2 py-1 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"> Reset password </button>

                        <!-- Reset two-factor: an administrator turns their own off from the Account page. -->
                        {#if user.twoFactorEnabled && !isSelf(user.id)}
                            <button onclick={() => (resetTwoFactorUser = user)} class="rounded-md px-2 py-1 text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"> Reset two-factor </button>
                        {/if}

                        <!-- Impersonate -->
                        {#if !isSelf(user.id) && user.role !== "admin"}
                            <button onclick={() => impersonateUser(user)} disabled={impersonating === user.id} class="rounded-md px-2 py-1 text-sm font-medium text-blue-700 hover:bg-blue-50 transition-colors disabled:opacity-50">
                                {impersonating === user.id ? "Impersonating\u2026" : "Impersonate"}
                            </button>
                        {/if}

                        <!-- Sessions -->
                        <button onclick={() => toggleSessions(user.id)} class="rounded-md px-2 py-1 text-sm font-medium transition-colors {expandedSessionsUserId === user.id ? 'bg-gray-200 text-gray-950' : 'text-gray-600 hover:bg-gray-100'}"> Sessions </button>

                        <!-- Delete -->
                        {#if !isSelf(user.id)}
                            <button onclick={() => openDeleteModal(user)} class="rounded-md px-2 py-1 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"> Delete </button>
                        {/if}
                    </div>

                    <!-- Expanded sessions -->
                    {#if expandedSessionsUserId === user.id}
                        <div class="mt-3 ml-12 rounded-lg border border-gray-200 bg-gray-50 p-3">
                            {#if loadingSessions}
                                <p class="text-sm text-gray-400 motion-safe:animate-pulse">Loading sessions\u2026</p>
                            {:else if userSessions.length === 0}
                                <p class="text-sm text-gray-400">No active sessions.</p>
                            {:else}
                                <div class="space-y-2">
                                    {#each userSessions as session (session.id)}
                                        <div class="flex items-center justify-between gap-3 rounded-md bg-white px-3 py-2 border border-gray-100">
                                            <div class="min-w-0 flex-1">
                                                <div class="flex items-center gap-2 flex-wrap">
                                                    <code class="text-sm font-mono text-gray-500">{truncateToken(session.token)}</code>
                                                    <span class="text-sm text-gray-400">{parseUserAgent(session.userAgent)}</span>
                                                </div>
                                                <div class="flex items-center gap-3 mt-0.5">
                                                    {#if session.ipAddress}
                                                        <span class="text-sm text-gray-400">IP: {session.ipAddress}</span>
                                                    {/if}
                                                    <span class="text-sm text-gray-400">Created: {formatDateTime(session.createdAt)}</span>
                                                    <span class="text-sm text-gray-400">Expires: {formatDateTime(session.expiresAt)}</span>
                                                </div>
                                            </div>
                                            <button onclick={() => revokeSession(session.token)} disabled={revokingSession === session.token} class="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50">
                                                {revokingSession === session.token ? "\u2026" : "Revoke"}
                                            </button>
                                        </div>
                                    {/each}
                                </div>
                                <div class="mt-2 flex justify-end">
                                    <button onclick={() => revokeAllSessions(user.id)} disabled={revokingAllSessions} class="rounded-md px-2.5 py-1 text-sm font-medium text-red-700 hover:bg-red-50 ring-1 ring-red-600/20 transition-colors disabled:opacity-50">
                                        {revokingAllSessions ? "Revoking\u2026" : "Revoke all sessions"}
                                    </button>
                                </div>
                            {/if}
                        </div>
                    {/if}
                </div>
            {/each}
            </div>
        {/if}
    </div>

    <!-- ── Pagination ────────────────────────────────────────────── -->
    {#if totalPages > 1}
        <div class="mt-4 flex items-center justify-between">
            <button
                onclick={() => {
                    if (currentPage > 1) currentPage--;
                }}
                disabled={currentPage <= 1}
                class="rounded-lg ring-1 ring-gray-950/15 bg-white px-3 py-1.5 text-sm font-medium text-gray-950 hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
                Previous
            </button>
            <span class="text-sm text-gray-500">
                Page {currentPage} of {totalPages} ({total} total)
            </span>
            <button
                onclick={() => {
                    if (currentPage < totalPages) currentPage++;
                }}
                disabled={currentPage >= totalPages}
                class="rounded-lg ring-1 ring-gray-950/15 bg-white px-3 py-1.5 text-sm font-medium text-gray-950 hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
                Next
            </button>
        </div>
    {/if}
</div>

<!-- ══════════════════════════════════════════════════════════════════ -->
<!-- ── Modals ────────────────────────────────────────────────────── -->
<!--
    All four use the shared Dialog: it owns Escape (previously bound to the non-focusable
    overlay div, so it never fired at all), the focus contract, and the busy behaviour.
-->
<!-- ══════════════════════════════════════════════════════════════════ -->

{#if roleChangeUser}
    {@const isAdmin = roleChangeUser.role === "admin"}
    <Dialog
        open={true}
        title={isAdmin ? "Remove admin role" : "Grant admin role"}
        busy={changingRole}
        busyReason="Updating…"
        onclose={() => (roleChangeUser = null)}
        onsubmit={() => void confirmRoleChange()}
    >
        {#snippet body()}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                {#if isAdmin}
                    This will remove admin privileges from <strong>{roleChangeUser.name || roleChangeUser.email}</strong>.
                    They will no longer be able to access the admin panel.
                {:else}
                    This will grant admin privileges to <strong>{roleChangeUser.name || roleChangeUser.email}</strong>.
                    They will have full access to the admin panel including user management.
                {/if}
            </p>
        {/snippet}
        {#snippet footer()}
            <button type="button" onclick={() => (roleChangeUser = null)} class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
            <button type="submit" data-autofocus disabled={changingRole} data-testid="admin-role-confirm" class="min-w-32 rounded-lg bg-gray-950 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 disabled:opacity-50">
                {changingRole ? "Updating\u2026" : isAdmin ? "Remove admin" : "Make admin"}
            </button>
        {/snippet}
    </Dialog>
{/if}

{#if banModalUser}
    <Dialog
        open={true}
        title="Ban user"
        busy={banning}
        busyReason="Banning…"
        onclose={() => (banModalUser = null)}
        onsubmit={() => void confirmBan()}
    >
        {#snippet body()}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                Ban <strong>{banModalUser.name || banModalUser.email}</strong> from their account. They are signed
                out everywhere, and every device and access token they use for Sync stops syncing until the ban
                ends or you lift it.
            </p>
            <div>
                <label for="ban-reason" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">Reason (optional)</label>
                <input id="ban-reason" type="text" bind:value={banReason} placeholder="e.g. Terms of service violation" class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400" />
            </div>
            <div>
                <label for="ban-duration" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">Duration</label>
                <select id="ban-duration" bind:value={banDuration} class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400">
                    <option value="1h">1 hour</option>
                    <option value="24h">24 hours</option>
                    <option value="7d">7 days</option>
                    <option value="30d">30 days</option>
                    <option value="permanent">Permanent</option>
                </select>
            </div>
        {/snippet}
        {#snippet footer()}
            <button type="button" onclick={() => (banModalUser = null)} class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
            <button type="submit" disabled={banning} data-testid="admin-ban-confirm" class="min-w-28 rounded-lg bg-amber-600 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50">
                {banning ? "Banning\u2026" : "Ban user"}
            </button>
        {/snippet}
    </Dialog>
{/if}

{#if resetPasswordUser}
    <Dialog
        open={true}
        title="Reset password"
        busy={resettingPassword}
        busyReason="Resetting…"
        onclose={() => (resetPasswordUser = null)}
        onsubmit={() => void confirmResetPassword()}
    >
        {#snippet body()}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                Set a new password for <strong>{resetPasswordUser.name || resetPasswordUser.email}</strong>.
            </p>
            <div>
                <label for="new-password" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">New password</label>
                <input id="new-password" type="password" bind:value={newPassword} placeholder="Enter new password" autocomplete="new-password" aria-describedby="new-password-hint" class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400" />
                <!-- Rule 7: the confirm button is disabled and therefore unfocusable, so its
                     condition has to be readable from the field it depends on. -->
                {#if !newPassword}
                    <p id="new-password-hint" class="mt-1.5 text-sm text-gray-500 dark:text-gray-400">Enter a password to enable Reset password.</p>
                {/if}
            </div>
        {/snippet}
        {#snippet footer()}
            <button type="button" onclick={() => (resetPasswordUser = null)} class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
            <button type="submit" disabled={resettingPassword || !newPassword} data-testid="admin-reset-password-confirm" class="min-w-36 rounded-lg bg-gray-950 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 disabled:opacity-50">
                {resettingPassword ? "Resetting\u2026" : "Reset password"}
            </button>
        {/snippet}
    </Dialog>
{/if}

{#if resetTwoFactorUser}
    <Dialog
        open={true}
        title="Reset two-factor authentication"
        busy={resettingTwoFactor}
        busyReason="Resetting…"
        onclose={() => (resetTwoFactorUser = null)}
        onsubmit={() => void confirmResetTwoFactor()}
    >
        {#snippet body()}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                This turns off two-factor authentication for <strong>{resetTwoFactorUser.name || resetTwoFactorUser.email}</strong>.
                Their authenticator app and backup codes stop working, and they sign in with their password alone
                until they turn it on again from their Account page. Do this only once you are sure the request comes
                from them.
            </p>
        {/snippet}
        {#snippet footer()}
            <button type="button" onclick={() => (resetTwoFactorUser = null)} class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
            <button type="submit" disabled={resettingTwoFactor} data-testid="admin-reset-two-factor-confirm" class="min-w-36 rounded-lg bg-gray-950 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 disabled:opacity-50">
                {resettingTwoFactor ? "Resetting\u2026" : "Turn off two-factor"}
            </button>
        {/snippet}
    </Dialog>
{/if}

{#if deleteModalUser}
    <Dialog
        open={true}
        title="Delete user"
        busy={deleting}
        busyReason="Deleting…"
        onclose={() => (deleteModalUser = null)}
        onsubmit={() => void confirmDelete()}
    >
        {#snippet body()}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                This permanently deletes the account of <strong>{deleteModalUser.name || deleteModalUser.email}</strong>.
                They are signed out everywhere, and every device and access token they use for Sync stops syncing
                at once. Graphs they own stay on the Sync Server until an administrator deletes them. This cannot be
                undone.
            </p>
            <div>
                <label for="delete-confirm" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">
                    Type <code class="rounded bg-gray-100 dark:bg-white/10 px-1 py-0.5 text-sm font-mono">{deleteModalUser.email}</code> to confirm
                </label>
                <input id="delete-confirm" type="text" bind:value={deleteConfirmEmail} placeholder={deleteModalUser.email} autocomplete="off" aria-describedby="delete-confirm-hint" class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500" />
                {#if deleteConfirmEmail !== deleteModalUser.email}
                    <p id="delete-confirm-hint" class="mt-1.5 text-sm text-gray-500 dark:text-gray-400">Delete user stays unavailable until this matches exactly.</p>
                {/if}
            </div>
        {/snippet}
        {#snippet footer()}
            <button type="button" onclick={() => (deleteModalUser = null)} class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
            <button type="submit" disabled={deleting || deleteConfirmEmail !== deleteModalUser.email} data-testid="admin-delete-confirm" class="min-w-32 rounded-lg bg-red-600 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed">
                {deleting ? "Deleting\u2026" : "Delete user"}
            </button>
        {/snippet}
    </Dialog>
{/if}
