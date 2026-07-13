import type {
    LlmMessage,
    NormalizedToolCall,
    NormalizedToolResult,
    OpenAIToolSchema,
    StreamChatParams,
    StreamChatResult,
} from "./types";

const DEFAULT_OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MAX_OUTPUT_TOKENS = 16384;

function getEndpoint(): string {
    return process.env.OPENAI_URL || DEFAULT_OPENAI_URL;
}

function getModel(override?: string): string {
    return override || process.env.OPENAI_MODEL || "gpt-4o";
}

function apiKey(override?: string | null): string {
    const key = override?.trim() || process.env.OPENAI_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
    if (!key) {
        throw new Error(
            "OpenAI API key is not configured. Set OPENAI_KEY or OPENAI_API_KEY.",
        );
    }
    return key;
}

type StandardMessage =
    | { role: "system"; content: string }
    | { role: "user"; content: string }
    | { role: "assistant"; content: string | null; tool_calls?: any[] }
    | { role: "tool"; tool_call_id: string; content: string };

function toStandardMessages(
    systemPrompt: string | undefined,
    messages: LlmMessage[]
): StandardMessage[] {
    const result: StandardMessage[] = [];
    if (systemPrompt) {
        result.push({ role: "system", content: systemPrompt });
    }
    for (const msg of messages) {
        result.push({ role: msg.role, content: msg.content } as StandardMessage);
    }
    return result;
}

function extractSseJson(buffer: string): { events: any[]; rest: string } {
    const events: any[] = [];
    const lines = buffer.split("\n");
    let rest = "";

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (line === "data: [DONE]") continue;
        if (line.startsWith("data: ")) {
            const data = line.slice(6);
            try {
                events.push(JSON.parse(data));
            } catch {
                if (i === lines.length - 1) {
                    rest = line;
                }
            }
        }
    }

    return { events, rest };
}

export async function streamOpenAI(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model: modelOverride,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
        enableThinking,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const key = apiKey(apiKeys?.openai);
    const model = getModel(modelOverride);
    const endpoint = getEndpoint();

    let fullText = "";
    const conversationHistory: StandardMessage[] = toStandardMessages(systemPrompt, params.messages);

    for (let iter = 0; iter < maxIter; iter++) {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model,
                messages: conversationHistory,
                tools: tools.length ? tools : undefined,
                stream: true,
                max_tokens: params.maxIterations ? undefined : MAX_OUTPUT_TOKENS, // Avoid confusion with maxIter
            }),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`OpenAI request failed (${response.status}): ${text}`);
        }

        if (!response.body) throw new Error("OpenAI response had no body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const currentIterToolCalls: Record<number, { id: string, name: string, args: string }> = {};

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const extracted = extractSseJson(buffer);
            buffer = extracted.rest;

            for (const event of extracted.events) {
                const delta = event.choices?.[0]?.delta;
                if (!delta) continue;

                if (delta.reasoning_content) {
                    callbacks.onReasoningDelta?.(delta.reasoning_content);
                }

                if (delta.content) {
                    fullText += delta.content;
                    callbacks.onContentDelta?.(delta.content);
                }

                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const index = tc.index ?? 0;
                        if (!currentIterToolCalls[index]) {
                            currentIterToolCalls[index] = { id: "", name: "", args: "" };
                        }
                        if (tc.id) currentIterToolCalls[index].id = tc.id;
                        if (tc.function?.name) currentIterToolCalls[index].name = tc.function.name;
                        if (tc.function?.arguments) currentIterToolCalls[index].args += tc.function.arguments;
                    }
                }
            }
        }

        const finalToolCalls: NormalizedToolCall[] = Object.values(currentIterToolCalls).map(tc => {
            let input = {};
            try {
                input = JSON.parse(tc.args || "{}");
            } catch (e) {
                console.error("Failed to parse tool arguments", tc.args);
            }
            return {
                id: tc.id,
                name: tc.name,
                input
            };
        });

        if (finalToolCalls.length > 0 && runTools) {
             // Add the assistant's tool call message to history
             conversationHistory.push({
                role: "assistant",
                content: null,
                tool_calls: finalToolCalls.map(tc => ({
                    id: tc.id,
                    type: "function",
                    function: {
                        name: tc.name,
                        arguments: JSON.stringify(tc.input)
                    }
                }))
            });

            // Notify callbacks about tool calls
            for (const tc of finalToolCalls) {
                callbacks.onToolCallStart?.(tc);
            }

            const results = await runTools(finalToolCalls);

            // Add tool result messages to history
            for (const tr of results) {
                conversationHistory.push({
                    role: "tool",
                    tool_call_id: tr.tool_use_id,
                    content: tr.content
                });
            }
        } else {
            break;
        }
    }

    return { fullText };
}

export async function completeOpenAIText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { openai?: string | null };
}): Promise<string> {
    const key = apiKey(params.apiKeys?.openai);
    const model = getModel(params.model);
    const endpoint = getEndpoint();

    const messages = [];
    if (params.systemPrompt) {
        messages.push({ role: "system", content: params.systemPrompt });
    }
    messages.push({ role: "user", content: params.user });

    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            messages,
            max_tokens: params.maxTokens ?? 512,
        }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`OpenAI request failed (${response.status}): ${text}`);
    }

    const json = await response.json();
    return json.choices?.[0]?.message?.content ?? "";
}
