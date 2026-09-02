"use client";

import { useEffect, useState } from "react";
import { MODELS, DEFAULT_MODEL_ID, type ModelOption } from "./models";
import { getServerConfig } from "@/app/lib/mikeApi";

/**
 * Models the server adds at runtime — currently the model behind a
 * server-configured OpenAI-compatible endpoint. Fetched once per page load and
 * cached in module scope so every picker shows the same list.
 */
let runtimeModels: ModelOption[] = [];
let inFlight: Promise<ModelOption[]> | null = null;
const listeners = new Set<(models: ModelOption[]) => void>();

async function fetchRuntimeModels(): Promise<ModelOption[]> {
    try {
        const config = await getServerConfig();
        const models = (config.models ?? []).filter(
            (m): m is ModelOption =>
                !!m?.id && !MODELS.some((known) => known.id === m.id),
        );
        runtimeModels = models;
    } catch {
        // Config is optional — fall back to the built-in model list.
        runtimeModels = [];
    }
    for (const listener of listeners) listener(runtimeModels);
    return runtimeModels;
}

export function loadRuntimeModels(): Promise<ModelOption[]> {
    if (!inFlight) inFlight = fetchRuntimeModels();
    return inFlight;
}

export function getRuntimeModels(): ModelOption[] {
    return runtimeModels;
}

/** Built-in models plus anything the server added. */
export function allModels(): ModelOption[] {
    return [...MODELS, ...runtimeModels];
}

/**
 * The model to select when the user has not chosen one. A server-configured
 * OpenAI-compatible model wins: it is the model that deployment actually runs.
 */
export function preferredDefaultModelId(): string {
    return runtimeModels[0]?.id ?? DEFAULT_MODEL_ID;
}

export function isKnownModelId(id: string): boolean {
    return allModels().some((m) => m.id === id);
}

/** Subscribes a component to the runtime model list, triggering the fetch. */
export function useAllModels(): ModelOption[] {
    const [models, setModels] = useState<ModelOption[]>(() => allModels());

    useEffect(() => {
        const listener = () => setModels(allModels());
        listeners.add(listener);
        void loadRuntimeModels().then(listener);
        return () => {
            listeners.delete(listener);
        };
    }, []);

    return models;
}
