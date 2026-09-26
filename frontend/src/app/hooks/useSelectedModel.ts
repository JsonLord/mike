"use client";

import { useCallback, useEffect, useState } from "react";
import { ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID } from "../lib/models";
import {
    isKnownModelId,
    loadRuntimeModels,
    preferredDefaultModelId,
} from "../lib/runtimeModels";

const STORAGE_KEY = "mike.selectedModel";

function readStored(): string {
    if (typeof window === "undefined") return DEFAULT_MODEL_ID;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && (ALLOWED_MODEL_IDS.has(raw) || isKnownModelId(raw))) return raw;
    return preferredDefaultModelId();
}

export function useSelectedModel(): [string, (id: string) => void] {
    const [model, setModelState] = useState<string>(DEFAULT_MODEL_ID);

    useEffect(() => {
        setModelState(readStored());
        // Re-read once the server's runtime models are known, so a stored
        // selection pointing at one of them survives the reload.
        void loadRuntimeModels().then(() => setModelState(readStored()));
    }, []);

    const setModel = useCallback((id: string) => {
        const next =
            ALLOWED_MODEL_IDS.has(id) || isKnownModelId(id)
                ? id
                : preferredDefaultModelId();
        setModelState(next);
        if (typeof window !== "undefined") {
            window.localStorage.setItem(STORAGE_KEY, next);
        }
    }, []);

    return [model, setModel];
}
