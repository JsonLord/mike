// @ts-nocheck
/**
 * Reachability probe for the external legal research sources.
 *
 * The sources are third-party and outbound access differs by deployment — a
 * host reachable from a developer machine is not necessarily reachable from
 * the container this runs in. Probing once at startup and logging the result
 * turns "the assistant says it could not check" into a diagnosable line in the
 * deployment's logs.
 */

import { fetchStatute } from "./legalResearch";

const PROBES: { name: string; url: string; ua?: string }[] = [
    {
        name: "openlegaldata (case law search)",
        url: "https://de.openlegaldata.io/api/cases/search/?text=test&page_size=1",
    },
    {
        name: "gesetze-im-internet (statutes)",
        url: "https://www.gesetze-im-internet.de/bgb/__242.html",
    },
    {
        name: "rechtsprechung-im-internet (official decisions)",
        url: "https://www.rechtsprechung-im-internet.de/rii-toc.xml",
        ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    },
];

const PROBE_TIMEOUT_MS = 20000;

export type SourceStatus = {
    name: string;
    ok: boolean;
    detail: string;
    ms: number;
};

let lastResults: SourceStatus[] = [];

export function lastSourceStatus(): SourceStatus[] {
    return lastResults;
}

async function probe(p: (typeof PROBES)[number]): Promise<SourceStatus> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        // HEAD is not honoured everywhere; a ranged GET keeps the transfer small.
        const res = await fetch(p.url, {
            headers: {
                ...(p.ua ? { "User-Agent": p.ua } : {}),
                Range: "bytes=0-1024",
            },
            signal: controller.signal,
        });
        return {
            name: p.name,
            ok: res.ok || res.status === 206,
            detail: `HTTP ${res.status}`,
            ms: Date.now() - started,
        };
    } catch (err) {
        const cause = (err as { cause?: { code?: string } })?.cause?.code;
        const reason =
            err instanceof Error && err.name === "AbortError"
                ? "timed out"
                : cause || (err instanceof Error ? err.message : String(err));
        return { name: p.name, ok: false, detail: String(reason), ms: Date.now() - started };
    } finally {
        clearTimeout(timer);
    }
}

/** Probes every source and logs one line each. Never throws. */
export async function probeLegalSources(): Promise<SourceStatus[]> {
    const results = await Promise.all(PROBES.map((p) => probe(p).catch((err) => ({
        name: p.name,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        ms: 0,
    }))));
    lastResults = results;
    for (const r of results) {
        console.log(
            `[sources] ${r.ok ? "reachable" : "UNREACHABLE"}: ${r.name} — ${r.detail} (${r.ms}ms)`,
        );
    }

    // Reachability is not the same as a working lookup: statute reads fall back
    // to a mirror when the official service is blocked, so exercise one and log
    // which source actually answered.
    try {
        const probe = (await fetchStatute({ book: "bgb", section: "242" })) as {
            error?: string;
            source?: string;
            authoritative?: boolean;
        };
        console.log(
            probe.error
                ? `[sources] statute lookup FAILED: ${probe.error.slice(0, 120)}`
                : `[sources] statute lookup OK via ${probe.source} (authoritative: ${probe.authoritative !== false})`,
        );
    } catch (err) {
        console.error("[sources] statute lookup probe threw", err);
    }

    return results;
}
