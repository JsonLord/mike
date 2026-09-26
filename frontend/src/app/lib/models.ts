export interface ModelOption {
    id: string;
    label: string;
    group: "Anthropic" | "Google" | "OpenAI";
}

/** Models this build knows about without asking the server. */
export const MODELS: ModelOption[] = [
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", group: "Anthropic" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", group: "Google" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
    { id: "gpt-5.5", label: "GPT-5.5", group: "OpenAI" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", group: "OpenAI" },
];

export const DEFAULT_MODEL_ID = "gpt-5.5";

export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

export const GROUP_ORDER: ModelOption["group"][] = [
    "Anthropic",
    "Google",
    "OpenAI",
];
