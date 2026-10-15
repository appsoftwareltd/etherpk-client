/**
 * The model providers an Agent Chat can reach (ADR 0147), each called from the browser with the
 * person's own key. Nothing here is a setting: it is what the Client knows about each provider,
 * so the settings screen can ask the right questions and the chat can call the right API.
 */

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'local' | 'compatible'

export interface ProviderInfo {
    id: ProviderId
    /** The name a person knows the provider by. */
    label: string
    /** Whether a connection needs a key, may have one, or has none. */
    key: 'required' | 'optional'
    /** Where the person gets a key, shown beside the field. */
    keyUrl?: string
    /** An example key's start, shown in the empty field. */
    keyPlaceholder?: string
    /** Whether a connection names the server's address, and which addresses it may be. */
    address: 'fixed' | 'loopback' | 'https'
    /** The address a new connection starts with. */
    defaultAddress?: string
    /** Whether the provider searches the web itself, so a chat can offer web search. */
    webSearch: boolean
    /** A way to connect without pasting a key. */
    connect?: 'openrouter'
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
    anthropic: {
        id: 'anthropic',
        label: 'Anthropic (Claude)',
        key: 'required',
        keyUrl: 'https://console.anthropic.com/settings/keys',
        keyPlaceholder: 'sk-ant-…',
        address: 'fixed',
        webSearch: true,
    },
    openai: {
        id: 'openai',
        label: 'OpenAI',
        key: 'required',
        keyUrl: 'https://platform.openai.com/api-keys',
        keyPlaceholder: 'sk-…',
        address: 'fixed',
        webSearch: true,
    },
    gemini: {
        id: 'gemini',
        label: 'Google Gemini',
        key: 'required',
        keyUrl: 'https://aistudio.google.com/apikey',
        keyPlaceholder: 'AIza…',
        address: 'fixed',
        // Grounding with Google Search obliges the app to show Google's search suggestions, which
        // come as HTML that extension code may not write (ADR 0130). Off until they can be drawn.
        webSearch: false,
    },
    openrouter: {
        id: 'openrouter',
        label: 'OpenRouter',
        key: 'required',
        keyUrl: 'https://openrouter.ai/settings/keys',
        keyPlaceholder: 'sk-or-…',
        address: 'fixed',
        webSearch: true,
        connect: 'openrouter',
    },
    local: {
        id: 'local',
        label: 'A model on this computer (Ollama, LM Studio)',
        key: 'optional',
        address: 'loopback',
        defaultAddress: 'http://localhost:11434/v1',
        webSearch: false,
    },
    compatible: {
        id: 'compatible',
        label: 'Another OpenAI-compatible server',
        key: 'optional',
        address: 'https',
        defaultAddress: 'https://',
        webSearch: false,
    },
}

/** The providers in the order the settings list them. */
export const PROVIDER_ORDER: readonly ProviderId[] = ['anthropic', 'openai', 'gemini', 'openrouter', 'local', 'compatible']

export function isProviderId(value: unknown): value is ProviderId {
    return typeof value === 'string' && (PROVIDER_ORDER as readonly string[]).includes(value)
}

/**
 * The loopback names the Client's content policy lets the page reach over plain HTTP. Not `[::1]`:
 * a content policy cannot name an IPv6 address.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1'])

/**
 * Why an address will not do for a provider, or null when it will. A model on this computer is
 * reached over loopback only, which is all the Client's content policy allows over plain HTTP;
 * another server needs HTTPS.
 */
export function addressProblem(provider: ProviderId, address: string): string | null {
    const info = PROVIDERS[provider]
    if (info.address === 'fixed') return null
    let url: URL
    try {
        url = new URL(address.trim())
    } catch {
        return 'Enter the full address, starting with http:// or https://.'
    }
    if (info.address === 'loopback') {
        if (!LOOPBACK_HOSTS.has(url.hostname)) return 'A model on this computer is reached at localhost or 127.0.0.1. For a model on another computer, choose "Another OpenAI-compatible server" and use an https address.'
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'The address starts with http:// or https://.'
        return null
    }
    if (url.protocol !== 'https:') return 'The address of another server must start with https://, so your notes are not sent in plain text.'
    return null
}
