// @ts-nocheck
/**
 * rechtsprechung-im-internet.de — the official decision service of the federal
 * courts (BGH, BVerfG, BVerwG, BFH, BAG, BSG, BPatG), published by the
 * Bundesamt für Justiz.
 *
 * The service has no search API. It publishes one index of every decision
 * (rii-toc.xml, ~23 MB, ~84k entries carrying court, date, file number and a
 * link) and serves each decision as a zipped XML document. So we build a local
 * index of that TOC once per day and search it in memory; decisions themselves
 * are fetched on demand.
 *
 * The index is metadata only — court, date, file number. That makes this the
 * authoritative source for *verifying and reading* a federal decision you can
 * already name, and a complement to the full-text search over Open Legal Data
 * in ./legalResearch, not a replacement for it.
 */

import * as fs from "fs/promises";
import * as path from "path";
import JSZip from "jszip";

const TOC_URL = "https://www.rechtsprechung-im-internet.de/rii-toc.xml";
const DOC_BASE = "https://www.rechtsprechung-im-internet.de/jportal/docs/bsjrs";
const WEB_BASE =
    "https://www.rechtsprechung-im-internet.de/jportal/portal/t/nsc/page/bsjrsprod.psml";

// The service returns an empty body to clients that do not send a browser
// User-Agent, so this one is not optional.
const USER_AGENT =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const CACHE_FILE = path.join(DATA_DIR, "cache", "rii-index.json");

const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
const TOC_TIMEOUT_MS = 120000;
const DOC_TIMEOUT_MS = 30000;
const MAX_DECISION_CHARS = 40000;

export type IndexEntry = {
    /** Document number, e.g. "WBRE410021432" — the id used to fetch it. */
    n: string;
    /** Court as published, e.g. "BGH 8. Zivilsenat". */
    c: string;
    /** Decision date, YYYY-MM-DD. */
    d: string;
    /** File number (Aktenzeichen), e.g. "VIII ZR 56/25". */
    a: string;
};

type IndexCache = { built_at: number; entries: IndexEntry[] };

let index: IndexCache | null = null;
let building: Promise<IndexCache | null> | null = null;
let lastFailureAt = 0;

/**
 * After a failed build, stop trying for a while. Without this, every tool call
 * would sit through another connect timeout before reporting the source is
 * unavailable, and a chat turn would hang on a source that is simply not
 * reachable from this deployment.
 */
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Index construction
// ---------------------------------------------------------------------------

function xmlField(block: string, tag: string): string {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
    return m ? decodeXml(m[1].trim()) : "";
}

function decodeXml(s: string): string {
    return s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
        .replace(/&amp;/g, "&");
}

/** "20250917" → "2025-09-17". */
function isoDate(compact: string): string {
    if (!/^\d{8}$/.test(compact)) return "";
    return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function parseToc(xml: string): IndexEntry[] {
    const entries: IndexEntry[] = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml)) !== null) {
        const block = m[1];
        const link = xmlField(block, "link");
        // Links look like .../bsjrs/jb-WBRE410021432.zip; the document number is
        // what we need, and anything not matching that shape we cannot fetch.
        const doknr = link.match(/\/jb-([A-Za-z0-9]+)\.zip\s*$/)?.[1];
        if (!doknr) continue;
        const date = isoDate(xmlField(block, "entsch-datum"));
        entries.push({
            n: doknr,
            c: xmlField(block, "gericht"),
            d: date,
            a: xmlField(block, "aktenzeichen"),
        });
    }
    return entries;
}

async function readCache(): Promise<IndexCache | null> {
    try {
        const raw = await fs.readFile(CACHE_FILE, "utf-8");
        const parsed = JSON.parse(raw) as IndexCache;
        if (!Array.isArray(parsed?.entries) || !parsed.entries.length) return null;
        return parsed;
    } catch {
        return null;
    }
}

async function writeCache(cache: IndexCache): Promise<void> {
    try {
        await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
        await fs.writeFile(CACHE_FILE, JSON.stringify(cache), "utf-8");
    } catch (err) {
        // A cache we cannot persist just means we rebuild after a restart.
        console.error("[rii] could not write index cache", err);
    }
}

function isFresh(cache: IndexCache | null): cache is IndexCache {
    return !!cache && Date.now() - cache.built_at < INDEX_TTL_MS;
}

async function buildIndex(): Promise<IndexCache | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOC_TIMEOUT_MS);
    try {
        const res = await fetch(TOC_URL, {
            headers: { "User-Agent": USER_AGENT },
            signal: controller.signal,
        });
        if (!res.ok) {
            console.error(`[rii] TOC fetch failed: HTTP ${res.status}`);
            return null;
        }
        const xml = await res.text();
        const entries = parseToc(xml);
        if (!entries.length) {
            console.error("[rii] TOC contained no usable entries");
            return null;
        }
        const cache: IndexCache = { built_at: Date.now(), entries };
        await writeCache(cache);
        console.log(`[rii] index built: ${entries.length} decisions`);
        return cache;
    } catch (err) {
        console.error("[rii] index build failed", err);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Returns the index, building or refreshing it if needed. Concurrent callers
 * share one build. A stale index is preferred over no index if a rebuild fails.
 */
async function getIndex(): Promise<IndexCache | null> {
    if (isFresh(index)) return index;
    if (building) return building;
    if (!index && Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) return null;

    building = (async () => {
        const cached = await readCache();
        if (isFresh(cached)) {
            index = cached;
            return index;
        }
        const built = await buildIndex();
        if (!built) lastFailureAt = Date.now();
        // Fall back to whatever we have rather than failing outright.
        index = built ?? cached ?? index;
        return index;
    })().finally(() => {
        building = null;
    });

    return building;
}

/** Kick off the first build in the background so the first query is not slow. */
export function warmOfficialDecisionIndex(): void {
    void getIndex().catch((err) => console.error("[rii] warm failed", err));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** File numbers are written inconsistently: "VIII ZR 56/25", "viii zr 56/25". */
function normalizeFileNumber(s: string): string {
    return s.toLowerCase().replace(/[\s.]/g, "");
}

/** "BGH", "Bundesgerichtshof", "bgh 8. zivilsenat" all match "BGH …". */
const COURT_ALIASES: Record<string, string> = {
    bundesgerichtshof: "bgh",
    bundesverfassungsgericht: "bverfg",
    bundesverwaltungsgericht: "bverwg",
    bundesfinanzhof: "bfh",
    bundesarbeitsgericht: "bag",
    bundessozialgericht: "bsg",
    bundespatentgericht: "bpatg",
};

function courtMatches(entryCourt: string, wanted: string): boolean {
    const e = entryCourt.toLowerCase();
    const w = wanted.trim().toLowerCase();
    const alias = COURT_ALIASES[w] ?? w;
    return e.startsWith(alias) || e.includes(alias);
}

export type OfficialSearchParams = {
    court?: string;
    file_number?: string;
    date_from?: string;
    date_to?: string;
    limit?: number;
};

export async function searchOfficialDecisions(params: OfficialSearchParams) {
    const idx = await getIndex();
    if (!idx) {
        return {
            error: "The official decision index (rechtsprechung-im-internet.de) is not reachable from this deployment. Tell the user you could not check the official federal-courts source, and fall back to search_case_law. Do NOT present this as an absence of decisions.",
        };
    }

    const { court, file_number, date_from, date_to } = params;
    if (!court && !file_number && !date_from && !date_to) {
        return {
            error: "Give at least one of court, file_number, date_from or date_to. This index searches decision metadata (court, date, file number), not decision text — use search_case_law for full-text search.",
        };
    }

    const limit = Math.min(Math.max(params.limit ?? 5, 1), 20);
    const wantedFn = file_number ? normalizeFileNumber(file_number) : null;

    const hits: IndexEntry[] = [];
    for (const e of idx.entries) {
        if (court && !courtMatches(e.c, court)) continue;
        if (wantedFn && !normalizeFileNumber(e.a).includes(wantedFn)) continue;
        if (date_from && e.d < date_from) continue;
        if (date_to && e.d > date_to) continue;
        hits.push(e);
    }
    hits.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));

    const coverage = indexCoverage(idx.entries);
    return {
        source: "rechtsprechung-im-internet.de (Bundesamt für Justiz — official)",
        coverage: `Federal courts only (BGH, BVerfG, BVerwG, BFH, BAG, BSG, BPatG), ${coverage.from} to ${coverage.to}, ${idx.entries.length} decisions. Contains no Land or instance-court decisions.`,
        index_built_at: new Date(idx.built_at).toISOString(),
        total_matches: hits.length,
        returned: Math.min(hits.length, limit),
        results: hits.slice(0, limit).map((e) => ({
            decision_id: e.n,
            court: e.c,
            date: e.d,
            file_number: e.a,
            note: "Call fetch_official_decision with this decision_id for the full official text.",
        })),
    };
}

function indexCoverage(entries: IndexEntry[]): { from: string; to: string } {
    let from = "9999-99-99";
    let to = "0000-00-00";
    for (const e of entries) {
        if (!e.d) continue;
        if (e.d < from) from = e.d;
        if (e.d > to) to = e.d;
    }
    return { from, to };
}

// ---------------------------------------------------------------------------
// Fetching one decision
// ---------------------------------------------------------------------------

function xmlSectionText(xml: string, tag: string): string {
    const raw = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"))?.[1] ?? "";
    if (!raw.trim()) return "";
    return decodeXml(
        raw
            .replace(/<\/(p|dd|dl|div)>/gi, "\n")
            .replace(/<[^>]+>/g, " "),
    )
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .trim();
}

export async function fetchOfficialDecision(decisionId: string) {
    const id = String(decisionId ?? "").trim();
    if (!/^[A-Za-z0-9]+$/.test(id)) {
        return {
            error: "decision_id must be the document number returned by search_official_decisions, e.g. 'WBRE410021432'.",
        };
    }

    const url = `${DOC_BASE}/jb-${id}.zip`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOC_TIMEOUT_MS);
    let buffer: ArrayBuffer;
    try {
        const res = await fetch(url, {
            headers: { "User-Agent": USER_AGENT },
            signal: controller.signal,
        });
        if (res.status === 404) {
            return { error: `No official decision with id ${id}.` };
        }
        if (!res.ok) {
            return {
                error: `rechtsprechung-im-internet.de returned HTTP ${res.status} for ${id}.`,
            };
        }
        buffer = await res.arrayBuffer();
    } catch (err) {
        const reason =
            err instanceof Error && err.name === "AbortError"
                ? "the request timed out"
                : err instanceof Error
                  ? err.message
                  : String(err);
        return { error: `Could not reach rechtsprechung-im-internet.de: ${reason}` };
    } finally {
        clearTimeout(timer);
    }

    let xml: string;
    try {
        const zip = await JSZip.loadAsync(buffer);
        const name = Object.keys(zip.files).find((f) => f.endsWith(".xml"));
        if (!name) return { error: `The archive for ${id} contained no XML document.` };
        xml = await zip.files[name].async("string");
    } catch (err) {
        return {
            error: `Could not read the decision archive for ${id}: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    const sections = {
        titelzeile: xmlSectionText(xml, "titelzeile"),
        leitsatz: xmlSectionText(xml, "leitsatz"),
        orientierungssatz: xmlSectionText(xml, "sonstosatz"),
        tenor: xmlSectionText(xml, "tenor"),
        tatbestand: xmlSectionText(xml, "tatbestand"),
        entscheidungsgruende: xmlSectionText(xml, "entscheidungsgruende"),
    };

    const body = [
        sections.tenor && `TENOR:\n${sections.tenor}`,
        sections.tatbestand && `TATBESTAND:\n${sections.tatbestand}`,
        sections.entscheidungsgruende &&
            `ENTSCHEIDUNGSGRÜNDE:\n${sections.entscheidungsgruende}`,
    ]
        .filter(Boolean)
        .join("\n\n");

    const truncated = body.length > MAX_DECISION_CHARS;

    return {
        source: "rechtsprechung-im-internet.de (Bundesamt für Justiz — official)",
        decision_id: xmlField(xml, "doknr") || id,
        court: xmlField(xml, "gertyp"),
        senate: xmlField(xml, "spruchkoerper"),
        file_number: xmlField(xml, "aktenzeichen"),
        ecli: xmlField(xml, "ecli"),
        date: isoDate(xmlField(xml, "entsch-datum")),
        decision_type: xmlField(xml, "doktyp"),
        cited_norms: xmlField(xml, "norm"),
        title: sections.titelzeile || null,
        leitsatz: sections.leitsatz || null,
        orientierungssatz: sections.orientierungssatz || null,
        url: `${WEB_BASE}?doc.id=${id}`,
        text: truncated
            ? `${body.slice(0, MAX_DECISION_CHARS)}\n\n[…text truncated…]`
            : body,
        text_truncated: truncated,
    };
}
