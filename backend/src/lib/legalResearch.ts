// @ts-nocheck
/**
 * German legal research sources.
 *
 * Two free, publicly documented sources — no credentials, no scraping of
 * subscription databases:
 *
 *  - gesetze-im-internet.de (Bundesministerium der Justiz): the official
 *    consolidated text of federal statutes, i.e. the version currently in
 *    force.
 *  - Open Legal Data (de.openlegaldata.io): a free, community-run corpus of
 *    German court decisions with full text and a full-text search API.
 *
 * Not every deployment can reach every source: gesetze-im-internet.de refuses
 * connections from some hosting networks (the Hugging Face Space this runs on
 * among them), so fetch_statute falls back to Open Legal Data's mirror of the
 * same text and says plainly which of the two answered.
 *
 * Neither is a substitute for Beck-Online or juris: Open Legal Data's coverage
 * is partial, so callers must never present an empty result as proof that no
 * case law exists. The tool descriptions and the system prompt say so, and the
 * payloads returned here repeat it where it matters.
 */

const OLD_API = "https://de.openlegaldata.io/api";
const OLD_WEB = "https://de.openlegaldata.io";
const GII = "https://www.gesetze-im-internet.de";

const USER_AGENT =
    "Mike-Legal-Assistant/1.0 (document analysis assistant; +https://github.com/JsonLord/mike)";

const SEARCH_TIMEOUT_MS = 15000;
const FETCH_TIMEOUT_MS = 25000;

/** Full decision texts run long; cap what we hand the model. */
const MAX_CASE_CHARS = 20000;

/**
 * Where the official statute service is blocked at network level, every lookup
 * would otherwise pay a ~10s TCP connect timeout before falling back. Remember
 * the failure and go straight to the mirror for a while.
 */
const OFFICIAL_UNREACHABLE_MS = 10 * 60 * 1000;
let officialUnreachableUntil = 0;

export type LegalError = { error: string };

function isError<T>(v: T | LegalError): v is LegalError {
    return !!v && typeof v === "object" && "error" in (v as object);
}

async function httpGet(
    url: string,
    timeoutMs: number,
): Promise<{ ok: true; res: Response } | { ok: false; error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
            signal: controller.signal,
        });
        return { ok: true, res };
    } catch (err) {
        const reason =
            err instanceof Error && err.name === "AbortError"
                ? `timed out after ${Math.round(timeoutMs / 1000)}s`
                : err instanceof Error
                  ? err.message
                  : String(err);
        return { ok: false, error: `Could not reach ${hostOf(url)}: ${reason}` };
    } finally {
        clearTimeout(timer);
    }
}

function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

async function getJson<T>(url: string, timeoutMs: number): Promise<T | LegalError> {
    const got = await httpGet(url, timeoutMs);
    if (!got.ok) return { error: got.error };
    if (!got.res.ok) {
        return {
            error: `${hostOf(url)} returned HTTP ${got.res.status} for this query.`,
        };
    }
    try {
        return (await got.res.json()) as T;
    } catch {
        return { error: `${hostOf(url)} returned a response that was not JSON.` };
    }
}

// ---------------------------------------------------------------------------
// HTML / snippet handling
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
};

function decodeEntities(s: string): string {
    return s
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function stripTags(html: string): string {
    return decodeEntities(
        html
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
            .replace(/<\/(p|div|br|li|tr|h\d)>/gi, "\n")
            .replace(/<[^>]+>/g, " "),
    )
        .replace(/[ \t ]+/g, " ")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .trim();
}

/** Search snippets arrive with the matched terms wrapped in <em>. */
function cleanSnippet(text: string): string {
    return stripTags(text).replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Case law — Open Legal Data
// ---------------------------------------------------------------------------

export type CaseSearchParams = {
    query: string;
    date_from?: string;
    date_to?: string;
    court?: string;
    order_by?: "relevance" | "date" | "most_cited";
    cites_law_book?: string;
    cites_law_section?: string;
    limit?: number;
};

/** How many hits get their full record fetched automatically. */
const MAX_ENRICHED = 5;
const EXCERPT_RADIUS = 1500;

/**
 * Cuts a window of the decision text around the first search hit, so the model
 * sees the match in context rather than a bare fragment.
 */
function excerptAround(text: string, snippet: string): string {
    if (!text) return "";
    const needle = snippet.slice(0, 60).trim();
    const at = needle ? text.indexOf(needle) : -1;
    if (at < 0) return text.slice(0, EXCERPT_RADIUS * 2);
    const from = Math.max(0, at - EXCERPT_RADIUS);
    const to = Math.min(text.length, at + EXCERPT_RADIUS);
    return `${from > 0 ? "[…] " : ""}${text.slice(from, to)}${to < text.length ? " […]" : ""}`;
}

export async function searchCaseLaw(params: CaseSearchParams) {
    const query = (params.query ?? "").trim();
    if (!query) return { error: "A search query is required." };

    const limit = Math.min(Math.max(params.limit ?? 3, 1), MAX_ENRICHED);
    const qs = new URLSearchParams({ text: query, page_size: String(limit) });
    if (params.date_from) qs.set("start_date", params.date_from);
    if (params.date_to) qs.set("end_date", params.date_to);
    if (params.court) qs.set("court", params.court);
    if (params.order_by) qs.set("order_by", params.order_by);
    if (params.cites_law_book) {
        qs.set("cited_law_book", params.cites_law_book.toLowerCase());
        // The API rejects a section without its book.
        if (params.cites_law_section) {
            qs.set("cited_law_section", params.cites_law_section);
        }
    }

    const data = await getJson<{ count: number; results: any[] }>(
        `${OLD_API}/cases/search/?${qs.toString()}`,
        SEARCH_TIMEOUT_MS,
    );
    if (isError(data)) return data;

    // Every hit is fetched immediately. Search alone yields fragments with no
    // court, date or file number, and a model handed those will attribute a
    // holding to a court it never read; doing the fetch here means the only
    // case material it ever sees is a real, citable record.
    const hits = data.results ?? [];
    const enriched = await Promise.all(
        hits.map(async (r) => {
            const snippets = (r.snippets ?? []).map((sn: any) =>
                cleanSnippet(sn.text ?? ""),
            );
            const full = await fetchCase(r.id);
            if (isError(full)) {
                return {
                    case_id: r.id,
                    court_level: r.court_level_of_appeal,
                    decision_type: r.decision_type,
                    snippets,
                    citable: false,
                    note: `This decision could not be read (${full.error}). Do not cite it, and do not attribute anything in the snippets to a court.`,
                };
            }
            return {
                case_id: full.case_id,
                court: full.court,
                file_number: full.file_number,
                ecli: full.ecli,
                date: full.date,
                decision_type: full.decision_type,
                court_level: r.court_level_of_appeal,
                citing_cases_count: r.citing_cases_count,
                url: full.url,
                citable: true,
                matched_snippets: snippets,
                excerpt: excerptAround(full.text, snippets[0] ?? ""),
                excerpt_note:
                    "An extract around the search hit, not the whole decision. Text here may be a party's submission rather than the court's holding — check that before presenting anything as decided, and read the full decision if the extract does not make it clear.",
            };
        }),
    );

    return {
        source: "Open Legal Data (de.openlegaldata.io)",
        coverage_note:
            "Open Legal Data covers courts at ALL levels — Amtsgericht, Landgericht, Oberlandesgericht and the federal courts — but its coverage of each is incomplete. Do not describe it as excluding any court level; describe it as a free database whose coverage is partial. Absence of a hit is NOT evidence that no such case law exists — say so rather than concluding none exists.",
        how_to_use:
            "Each result below has already been read for you: court, file number, date and an extract of the decision are included, so you can cite these decisions directly without any further call. Cite as court, Aktenzeichen and date. Use fetch_case only when you need more of a decision than the extract shows.",
        total_matches: data.count ?? 0,
        returned: enriched.length,
        results: enriched,
    };
}

export async function fetchCase(caseId: string | number) {
    const id = String(caseId ?? "").trim();
    if (!/^\d+$/.test(id)) {
        return { error: "case_id must be the numeric id returned by search_case_law." };
    }

    const data = await getJson<any>(`${OLD_API}/cases/${id}/`, FETCH_TIMEOUT_MS);
    if (isError(data)) return data;

    const text = stripTags(String(data.content ?? ""));
    const truncated = text.length > MAX_CASE_CHARS;

    return {
        source: "Open Legal Data (de.openlegaldata.io)",
        case_id: data.id,
        court: data.court?.name ?? null,
        court_jurisdiction: data.court?.jurisdiction ?? null,
        file_number: data.file_number || null,
        ecli: data.ecli || null,
        date: data.date ?? null,
        decision_type: data.type ?? null,
        url: data.slug ? `${OLD_WEB}/case/${data.slug}` : null,
        original_source_url: data.source_url || null,
        text: truncated ? `${text.slice(0, MAX_CASE_CHARS)}\n\n[…text truncated…]` : text,
        text_truncated: truncated,
    };
}

// ---------------------------------------------------------------------------
// Statutes — Open Legal Data for search, gesetze-im-internet for the text
// ---------------------------------------------------------------------------

export async function searchStatutes(params: {
    query: string;
    book_code?: string;
    limit?: number;
}) {
    const query = (params.query ?? "").trim();
    if (!query) return { error: "A search query is required." };

    const limit = Math.min(Math.max(params.limit ?? 5, 1), 10);
    const qs = new URLSearchParams({ text: query, page_size: String(limit) });
    if (params.book_code) qs.set("book_code", params.book_code.toUpperCase());

    const data = await getJson<{ count: number; results: any[] }>(
        `${OLD_API}/laws/search/?${qs.toString()}`,
        SEARCH_TIMEOUT_MS,
    );
    if (isError(data)) return data;

    return {
        source: "Open Legal Data law index",
        total_matches: data.count ?? 0,
        results: (data.results ?? []).map((r) => ({
            book_code: r.book_code,
            title: r.title,
            snippets: (r.snippets ?? []).map((s: any) => cleanSnippet(s.text ?? "")),
            note: "Use fetch_statute with this book_code and the section number for the official current wording.",
        })),
        next_step:
            "This index may lag the official text. Always confirm the wording with fetch_statute before quoting a provision.",
    };
}

/** `242`, `§ 242`, `242 a`, `Art. 1` → the slug gesetze-im-internet uses. */
function normalizeSection(section: string): string {
    return section
        .toLowerCase()
        .replace(/artikel|art\b|art\./g, " ")
        .replace(/[^0-9a-z]/g, "");
}

function statuteUrls(book: string, section: string): string[] {
    const b = book.trim().toLowerCase().replace(/\s+/g, "");
    const s = normalizeSection(section);
    // Most laws number sections as __242; constitutional-style laws (GG, EGBGB)
    // use art_1. Try both rather than making the caller know which.
    return [`${GII}/${b}/__${s}.html`, `${GII}/${b}/art_${s}.html`];
}

/**
 * Section-slug → Open Legal Data law id, per statute book.
 *
 * The API offers no filter by section, so the book's current revision is paged
 * once and indexed in memory. Books run to a few thousand sections, so this is
 * three requests for the BGB and one for most others.
 */
const lawIdCache = new Map<string, Map<string, number>>();

const OLD_PAGE_SIZE = 1000;
const OLD_MAX_PAGES = 8;

async function lawIdsForBook(bookSlug: string): Promise<Map<string, number> | null> {
    const cached = lawIdCache.get(bookSlug);
    if (cached) return cached;

    const map = new Map<string, number>();
    for (let page = 0; page < OLD_MAX_PAGES; page++) {
        const url = `${OLD_API}/laws/?book__slug=${encodeURIComponent(bookSlug)}&book__latest=true&limit=${OLD_PAGE_SIZE}&offset=${page * OLD_PAGE_SIZE}`;
        const data = await getJson<{ count: number; results: any[] }>(url, SEARCH_TIMEOUT_MS);
        if (isError(data)) return map.size ? map : null;
        for (const r of data.results ?? []) {
            if (r?.slug && typeof r.id !== "undefined" && !map.has(r.slug)) {
                map.set(String(r.slug), Number(r.id));
            }
        }
        if ((page + 1) * OLD_PAGE_SIZE >= (data.count ?? 0)) break;
    }
    if (!map.size) return null;
    lawIdCache.set(bookSlug, map);
    return map;
}

/** Reads the provision from Open Legal Data when the official service is unreachable. */
async function fetchStatuteFromMirror(book: string, section: string) {
    const bookSlug = book.trim().toLowerCase().replace(/\s+/g, "");
    const sec = normalizeSection(section);
    const ids = await lawIdsForBook(bookSlug);
    if (!ids) return null;

    // §-numbered laws key on the bare number; article-numbered ones on artikel-N.
    const id = ids.get(sec) ?? ids.get(`artikel-${sec}`) ?? ids.get(`art-${sec}`);
    if (typeof id !== "number") return null;

    const data = await getJson<any>(`${OLD_API}/laws/${id}/`, FETCH_TIMEOUT_MS);
    if (isError(data)) return null;

    const text = stripTags(String(data.content ?? ""));
    if (!text) return null;

    return {
        source: "Open Legal Data (de.openlegaldata.io) — an INDEPENDENT community-run copy, NOT operated by the German government",
        authoritative: false,
        law: data.book_code ? `${data.book_code}` : bookSlug.toUpperCase(),
        section: data.section ?? section,
        heading: data.title ?? "",
        text,
        url: `${OLD_WEB}/law/${bookSlug}/${data.slug ?? sec}/`,
        official_url: statuteUrls(book, section)[0],
        mirror_last_updated: data.updated_date ?? null,
        currency_note:
            "The official service gesetze-im-internet.de was not reachable from this deployment, so this wording comes from Open Legal Data's independent copy of it, last updated as given in mirror_last_updated. It is a third-party copy run by a community project — NEVER describe it as an official, government, or Bundesregierung source. Tell the user the wording comes from a third-party copy and must be confirmed against the official URL before it is relied on.",
    };
}

export async function fetchStatute(params: { book: string; section: string }) {
    const book = (params.book ?? "").trim();
    const section = (params.section ?? "").trim();
    if (!book || !section) {
        return { error: "Both book (e.g. 'bgb') and section (e.g. '242') are required." };
    }

    const attempted: string[] = [];
    let officialUnreachable = Date.now() < officialUnreachableUntil;
    for (const url of officialUnreachable ? [] : statuteUrls(book, section)) {
        attempted.push(url);
        const got = await httpGet(url, FETCH_TIMEOUT_MS);
        if (!got.ok) {
            // Network-level failure: this deployment cannot reach the official
            // service at all, so stop trying URL forms and use the mirror —
            // and skip the official service entirely for the next few minutes.
            officialUnreachable = true;
            officialUnreachableUntil = Date.now() + OFFICIAL_UNREACHABLE_MS;
            console.warn(
                `[legal] gesetze-im-internet.de unreachable (${got.error}); using the mirror for the next ${OFFICIAL_UNREACHABLE_MS / 60000} minutes`,
            );
            break;
        }
        if (got.res.status === 404) continue;
        if (!got.res.ok) {
            return { error: `gesetze-im-internet.de returned HTTP ${got.res.status}.` };
        }

        // The site is served as ISO-8859-1 with no charset header.
        const html = new TextDecoder("iso-8859-1").decode(await got.res.arrayBuffer());
        const parsed = parseStatutePage(html);
        if (!parsed) {
            return { error: `Could not parse the statute page at ${url}.` };
        }
        officialUnreachableUntil = 0;
        return {
            source: "gesetze-im-internet.de (Bundesministerium der Justiz)",
            law: parsed.law,
            section: parsed.section,
            heading: parsed.heading,
            text: parsed.text,
            url,
            currency_note:
                "Official consolidated text, i.e. the version currently in force. Historic versions in force at an earlier date are not available through this tool.",
        };
    }

    const mirrored = await fetchStatuteFromMirror(book, section);
    if (mirrored) return mirrored;

    if (officialUnreachable) {
        return {
            error: `gesetze-im-internet.de is not reachable from this deployment and the provision was not found in the mirror either. Tell the user you could not verify the wording of this provision, and do not quote it from memory as if you had.`,
        };
    }
    return {
        error: `No such provision found. Tried: ${attempted.join(", ")}. Check the law abbreviation (the slug used by gesetze-im-internet.de, e.g. 'bgb', 'stgb', 'hgb', 'gg') and the section number, or use search_statutes to locate it.`,
    };
}

function parseStatutePage(html: string): {
    law: string;
    section: string;
    heading: string;
    text: string;
} | null {
    // The pages are generated from the same template throughout: the heading
    // block carries the law's name, the section number (jnenbez) and its title
    // (jnentitel); the provision itself follows in a jnhtml block and ends
    // where the page footer starts.
    const headerBlock = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "";
    const law = stripTags(headerBlock.split(/<br\s*\/?>/i)[0] ?? "");
    const section = stripTags(
        headerBlock.match(/<span[^>]*class="jnenbez"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "",
    );
    const heading = stripTags(
        headerBlock.match(/<span[^>]*class="jnentitel"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "",
    );

    const bodyStart = html.search(/class="jnhtml"/i);
    const anchor = bodyStart >= 0 ? bodyStart : html.search(/<\/h1>/i);
    if (anchor < 0) return null;
    // Start after the end of the tag the anchor points into, so the slice does
    // not begin in the middle of an attribute.
    const tagEnd = html.indexOf(">", anchor);
    const from = tagEnd > anchor ? tagEnd + 1 : anchor;
    const footer = html.search(/id="fussz/i);
    const text = stripTags(
        // The footer index can land inside a tag; drop the fragment so no
        // markup leaks into the statute text handed to the model.
        html.slice(from, footer > from ? footer : undefined).replace(/<[^>]*$/, ""),
    );

    if (!text) return null;
    return { law, section, heading, text };
}
