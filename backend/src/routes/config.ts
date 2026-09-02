// @ts-nocheck
import { Router } from "express";
import {
    isOpenAiCompatibleEnabled,
    openAiCompatibleModelId,
} from "../lib/llm";

export const configRouter = Router();

export type RuntimeModel = {
    id: string;
    label: string;
    group: "Anthropic" | "Google" | "OpenAI";
};

/**
 * GET /config — public, non-sensitive server configuration the client needs to
 * render the model picker. Never returns urls or keys, only the model id the
 * server is willing to serve.
 */
configRouter.get("/", (_req, res) => {
    const compatibleModel = openAiCompatibleModelId();
    const models: RuntimeModel[] = compatibleModel
        ? [{ id: compatibleModel, label: compatibleModel, group: "OpenAI" }]
        : [];

    res.json({
        openaiCompatible: {
            enabled: isOpenAiCompatibleEnabled(),
            model: compatibleModel,
        },
        models,
    });
});
