// @ts-nocheck
/**
 * OpenAI-compatible provider configuration.
 *
 * When the deployment supplies OPENAI_COMPATIBLE_URL / OPENAI_COMPATIBLE_MODEL /
 * OPENAI_COMPATIBLE_API (for example as Hugging Face Space secrets), every
 * OpenAI-family request is routed to that endpoint and pinned to that model,
 * and the model is offered to the client as a first-class choice.
 */

const DEFAULT_OPENAI_URL = "https://api.openai.com/v1/chat/completions";

function env(name: string): string | null {
    const value = process.env[name];
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

export function openAiCompatibleBaseUrl(): string | null {
    return (
        env("OPENAI_COMPATIBLE_URL") ||
        env("OPENAI_URL") ||
        env("OPENAI_BASE_URL") ||
        env("OPENAI_API_BASE")
    );
}

export function openAiCompatibleModel(): string | null {
    return env("OPENAI_COMPATIBLE_MODEL") || env("OPENAI_MODEL");
}

export function openAiApiKey(): string | null {
    return (
        env("OPENAI_COMPATIBLE_API") ||
        env("OPENAI_KEY") ||
        env("OPENAI_API_KEY") ||
        env("OPENAI_TOKEN") ||
        env("OPENAI_API_TOKEN")
    );
}

/**
 * True when the server points the OpenAI provider at a custom endpoint and
 * names the model it serves. Both are required: without the model id we cannot
 * tell the endpoint which model to run, and without the url there is nothing
 * custom to route to.
 */
export function isOpenAiCompatibleEnabled(): boolean {
    return !!(openAiCompatibleBaseUrl() && openAiCompatibleModel() && openAiApiKey());
}

/** The model id exposed to clients; null when compatible mode is off. */
export function openAiCompatibleModelId(): string | null {
    return isOpenAiCompatibleEnabled() ? openAiCompatibleModel() : null;
}

/** Chat-completions endpoint, with the path appended when only a base url is given. */
export function openAiChatCompletionsEndpoint(): string {
    let url = openAiCompatibleBaseUrl() || DEFAULT_OPENAI_URL;
    if (url.endsWith("/chat/completions") || url.endsWith("/chat/completions/")) {
        return url;
    }
    return url.endsWith("/") ? `${url}chat/completions` : `${url}/chat/completions`;
}
