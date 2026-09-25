<script lang="ts">
    import { onMount } from "svelte";
    import { applyThemePreference, getAppliedResolvedTheme, getAppliedThemePreference, THEME_CHANGE_EVENT, type ResolvedTheme, type ThemePreference } from "../theme";

    let {
        themePreference = "system",
        resolvedTheme: initialResolvedTheme = "light",
    }: {
        themePreference?: ThemePreference;
        resolvedTheme?: ResolvedTheme;
    } = $props();

    let currentPreference = $state<ThemePreference>("system");
    let resolvedTheme = $state<ResolvedTheme>("light");
    let hydrated = $state(false);

    const displayedPreference = $derived(hydrated ? currentPreference : themePreference);
    const displayedResolvedTheme = $derived(hydrated ? resolvedTheme : initialResolvedTheme);

    function syncThemeState(preference = getAppliedThemePreference(), theme = getAppliedResolvedTheme()) {
        currentPreference = preference;
        resolvedTheme = theme;
    }

    onMount(() => {
        syncThemeState();
        hydrated = true;

        const handleThemeChange = (event: Event) => {
            const detail = (event as CustomEvent<{ preference?: ThemePreference; resolvedTheme?: ResolvedTheme }>).detail;
            syncThemeState(detail?.preference, detail?.resolvedTheme);
        };

        window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);

        return () => {
            window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
        };
    });

    const options: Array<{ value: ThemePreference; label: string; icon: string }> = [
        {
            value: "light",
            label: "Light",
            icon: "M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z",
        },
        {
            value: "dark",
            label: "Dark",
            icon: "M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z",
        },
        {
            value: "system",
            label: "System",
            icon: "M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25A2.25 2.25 0 0 1 5.25 3h13.5A2.25 2.25 0 0 1 21 5.25Z",
        },
    ];

    function setPreference(value: ThemePreference) {
        const nextResolvedTheme = applyThemePreference(value);
        syncThemeState(value, nextResolvedTheme);
    }

    $effect(() => {
        if (currentPreference !== "system") {
            return;
        }

        const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
        const handleChange = () => {
            const nextResolvedTheme = applyThemePreference("system");
            syncThemeState("system", nextResolvedTheme);
        };

        mediaQuery.addEventListener("change", handleChange);

        return () => {
            mediaQuery.removeEventListener("change", handleChange);
        };
    });

    const containerClass = $derived(displayedResolvedTheme === "dark" ? "border-white/15 bg-gray-950/85 shadow-gray-950/40" : "border-gray-200 bg-white/85");

    function buttonClass(option: ThemePreference) {
        const isActive = displayedPreference === option;

        if (isActive) {
            return displayedResolvedTheme === "dark" ? "bg-white/12 text-white ring-1 ring-white/20 shadow-sm" : "bg-gray-950 text-white shadow-sm";
        }

        return displayedResolvedTheme === "dark" ? "text-gray-400 hover:bg-white/10 hover:text-white" : "text-gray-500 hover:bg-gray-100 hover:text-gray-950";
    }
</script>

<div data-testid="theme-toggle" data-hydrated={hydrated || undefined} class="inline-flex items-center rounded-full border p-1 shadow-sm backdrop-blur-sm {containerClass}">
    <div class="flex items-center gap-0.5" role="radiogroup" aria-label="Color theme">
        {#each options as option (option.value)}
            <button
                type="button"
                role="radio"
                aria-label={option.label}
                aria-checked={displayedPreference === option.value}
                data-testid={displayedPreference === option.value ? "theme-toggle-active" : undefined}
                onclick={() => {
                    setPreference(option.value);
                }}
                class="rounded-full p-1.5 transition-colors {buttonClass(option.value)}"
            >
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d={option.icon} />
                </svg>
            </button>
        {/each}
    </div>
</div>
