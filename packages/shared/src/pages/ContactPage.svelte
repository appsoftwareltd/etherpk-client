<script lang="ts">
    import { onMount } from "svelte";
    import { focusFirstInvalid } from "../ui/index.svelte";
    import { touchAll, visibleErrors } from "../forms/field-errors";
    import AlertBanner from "../components/AlertBanner.svelte";

    let name = $state("");
    let email = $state("");
    let message = $state("");

    const DRAFT_KEY = "etherpk:contact-draft";

    onMount(() => {
        try {
            message = localStorage.getItem(DRAFT_KEY) ?? message;
        } catch {
            // Private mode, or storage disabled. A draft is a convenience, never a requirement.
        }
    });

    $effect(() => {
        try {
            if (message) localStorage.setItem(DRAFT_KEY, message);
            else localStorage.removeItem(DRAFT_KEY);
        } catch {
            // As above.
        }
    });
    let formError = $state<string | null>(null);
    let fieldErrors = $state<{ name?: string; email?: string; message?: string }>({});
    let loading = $state(false);
    let success = $state(false);

    // Anti-bot: JS token set on mount
    let token = $state("");
    $effect(() => {
        token = btoa(Date.now().toString());
    });

    const inputBase = "block w-full rounded-lg border bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 transition-colors";
    const inputNormal = "border-gray-300 text-gray-950 focus:border-gray-950 focus:ring-gray-950/10";
    const inputError = "border-red-300 text-red-900 focus:border-red-500 focus:ring-red-500/10";

    function validate(): boolean {
        const errors: typeof fieldErrors = {};
        if (!name.trim()) {
            errors.name = "Name is required";
        } else if (name.length > 200) {
            errors.name = "Name must be 200 characters or fewer";
        }
        if (!email.trim()) {
            errors.email = "Email is required";
        } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            errors.email = "Please enter a valid email address";
        }
        if (!message.trim()) {
            errors.message = "Message is required";
        } else if (message.length > 5000) {
            errors.message = "Message must be 5,000 characters or fewer";
        }
        fieldErrors = errors;
        return Object.keys(errors).length === 0;
    }

    // Rule 6: validate on blur, then eagerly once a field has errored. `validate()` computes
    // every field at once, so `touched` is what stops a single blur lighting up the whole form.
    const FIELDS = ["name", "email", "message"] as const;
    let touched = $state<Record<string, boolean>>({});

    function revalidate() {
        validate();
        fieldErrors = visibleErrors(fieldErrors, touched);
    }

    function blurField(field: (typeof FIELDS)[number]) {
        touched = { ...touched, [field]: true };
        revalidate();
    }

    function inputField(field: (typeof FIELDS)[number]) {
        if (fieldErrors[field]) revalidate();
    }

    /** Submit-time validation reveals everything, and puts the caret where the first fix is. */
    function validateOnSubmit(): boolean {
        touched = touchAll(touched, FIELDS);
        const ok = validate();
        if (!ok) void focusFirstInvalid();
        return ok;
    }


    async function handleSubmit(e: SubmitEvent) {
        e.preventDefault();
        if (!validateOnSubmit()) return;
        loading = true;
        formError = null;

        try {
            const res = await fetch("/api/v1/contact", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: name.trim(),
                    email: email.trim(),
                    message: message.trim(),
                    _token: token,
                    _website: "",
                }),
            });
            const data = await res.json();

            if (!res.ok) {
                if (data.errors) {
                    fieldErrors = data.errors;
                }
                formError = data.message || "Something went wrong. Please try again.";
                loading = false;
                return;
            }

            success = true;
            name = "";
            email = "";
            message = "";
            fieldErrors = {};
        } catch {
            formError = "Failed to send message. Please check your connection and try again.";
        }
        loading = false;
    }
</script>

<svelte:head>
    <title>Contact Us - EtherPK</title>
    <meta name="description" content="Get in touch with the EtherPK team about the app, Sync+ or running your own Sync Server. We'll get back to you as soon as we can." />
    <link rel="canonical" href="https://www.etherpk.com/contact" />
    <meta property="og:title" content="Contact Us - EtherPK" />
    <meta property="og:description" content="Get in touch with the EtherPK team about the app, Sync+ or running your own Sync Server." />
    <meta property="og:url" content="https://www.etherpk.com/contact" />
    <meta property="og:type" content="website" />
</svelte:head>

<div class="mx-auto max-w-xl px-4 sm:px-6 py-16 sm:py-24">
    <div class="text-center mb-8">
        <h1 class="text-3xl sm:text-4xl font-semibold tracking-tight text-gray-950">Contact us</h1>
        <p class="mt-3 text-gray-600">Send us a message and we'll get back to you ASAP.</p>
    </div>

    {#if success}
        <div class="rounded-2xl border border-green-200 bg-green-50 p-8 text-center">
            <div class="flex justify-center mb-4">
                <div class="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 ring-1 ring-green-600/20">
                    <svg class="h-6 w-6 text-green-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                        <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clip-rule="evenodd" />
                    </svg>
                </div>
            </div>
            <h2 class="text-lg font-semibold text-green-900">Message sent</h2>
            <p class="mt-2 text-sm text-green-700">Thanks for getting in touch. We'll respond as soon as we can.</p>
            <button
                type="button"
                onclick={() => {
                    success = false;
                    token = btoa(Date.now().toString());
                }}
                class="mt-6 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 transition-colors"
            >
                Send another message
            </button>
        </div>
    {:else}
        {#if formError}
            <div class="mb-6">
                <AlertBanner variant="error" message={formError} />
            </div>
        {/if}

        <form onsubmit={handleSubmit} novalidate class="space-y-5">
            <!-- Honeypot — hidden from real users, attractive to bots -->
            <div class="absolute left-[-9999px]" aria-hidden="true">
                <label for="website">Website</label>
                <input id="website" type="text" name="website" tabindex="-1" autocomplete="off" />
            </div>

            <div>
                <label for="contact-name" class="block text-sm font-medium text-gray-700 mb-1.5">Name</label>
                <input id="contact-name" onblur={() => blurField("name")} oninput={() => inputField("name")} type="text" bind:value={name} autocomplete="name" placeholder="Your name" aria-invalid={!!fieldErrors.name} aria-describedby={fieldErrors.name ? "name-error" : undefined} class="{inputBase} {fieldErrors.name ? inputError : inputNormal}" />
                {#if fieldErrors.name}
                    <p id="name-error" class="mt-1 text-sm text-red-600">{fieldErrors.name}</p>
                {/if}
            </div>

            <div>
                <label for="contact-email" class="block text-sm font-medium text-gray-700 mb-1.5">Email</label>
                <input id="contact-email" onblur={() => blurField("email")} oninput={() => inputField("email")} type="email" bind:value={email} autocomplete="email" placeholder="you@example.com" aria-invalid={!!fieldErrors.email} aria-describedby={fieldErrors.email ? "email-error" : undefined} class="{inputBase} {fieldErrors.email ? inputError : inputNormal}" />
                {#if fieldErrors.email}
                    <p id="email-error" class="mt-1 text-sm text-red-600">{fieldErrors.email}</p>
                {/if}
            </div>

            <div>
                <label for="contact-message" class="block text-sm font-medium text-gray-700 mb-1.5">Message</label>
                <textarea id="contact-message" onblur={() => blurField("message")} oninput={() => inputField("message")} onkeydown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") e.currentTarget.form?.requestSubmit(); }} bind:value={message} rows="5" placeholder="How can we help?" aria-invalid={!!fieldErrors.message} aria-describedby={fieldErrors.message ? "message-error" : undefined} class="{inputBase} {fieldErrors.message ? inputError : inputNormal} resize-y"></textarea>
                {#if fieldErrors.message}
                    <p id="message-error" class="mt-1 text-sm text-red-600">{fieldErrors.message}</p>
                {/if}
                <p class="mt-1 text-sm text-gray-400 text-right">{message.length.toLocaleString()} / 5,000</p>
            </div>

            <button type="submit" disabled={loading} class="w-full rounded-lg bg-gray-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {loading ? "Sending…" : "Send message"}
            </button>
        </form>
    {/if}
</div>
