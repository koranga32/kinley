import { apiError, handleError, json, methodNotAllowed, readJson, validationError, withSessionCookie } from "../_shared/http.js";
import { enforceRateLimits, getSession, rejectCrossSiteRequest } from "../_shared/security.js";
import { supabaseServerRequest } from "../_shared/supabase.js";
import {
    validateContactPayload,
    validateEmptyPayload,
    validateExamStartPayload,
    validateGradedResponsePayload,
    validateMediaIds
} from "../_shared/validation.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const QUESTION_WINDOW_SIZE = 5;
const QUESTION_POOL_CACHE_SECONDS = 120;
const questionPoolMemoryCache = new Map();
const PUBLIC_CACHE_SHORT = {
    "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=120"
};
const PUBLIC_CACHE_MEDIA = {
    "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=600"
};
const MEDIA_BUCKET = "exam-media";

const POLICIES = {
    health: { windowMs: MINUTE, ipLimit: 30, sessionLimit: 30 },
    questions: { windowMs: MINUTE, ipLimit: 60, sessionLimit: 90 },
    "pe-overview": { windowMs: MINUTE, ipLimit: 60, sessionLimit: 90 },
    "pe-resources": { windowMs: MINUTE, ipLimit: 60, sessionLimit: 90 },
    "pe-resource-pdf": { windowMs: MINUTE, ipLimit: 45, sessionLimit: 60 },
    "pe-resource-answer": { windowMs: MINUTE, ipLimit: 90, sessionLimit: 90 },
    "pe-di-graph": { windowMs: MINUTE, ipLimit: 2400, sessionLimit: 240 },
    "exam-start": { windowMs: 10 * MINUTE, ipLimit: 40, sessionLimit: 30 },
    "exam-question": { windowMs: MINUTE, ipLimit: 120, sessionLimit: 180 },
    "question-solution": { windowMs: MINUTE, ipLimit: 120, sessionLimit: 90 },
    "pe-online-questions": { windowMs: MINUTE, ipLimit: 60, sessionLimit: 90 },
    "pe-online-start": { windowMs: 10 * MINUTE, ipLimit: 30, sessionLimit: 20 },
    "pe-online-question": { windowMs: MINUTE, ipLimit: 120, sessionLimit: 180 },
    flashcards: { windowMs: MINUTE, ipLimit: 60, sessionLimit: 90 },
    "flashcard-answer": { windowMs: MINUTE, ipLimit: 90, sessionLimit: 60 },
    quotes: { windowMs: MINUTE, ipLimit: 60, sessionLimit: 90 },
    responses: { windowMs: 10 * MINUTE, ipLimit: 40, sessionLimit: 30 },
    contact: { windowMs: HOUR, ipLimit: 3, sessionLimit: 2 }
};

function routeName(context) {
    const path = context.params.path;
    return Array.isArray(path) ? path.join("/") : String(path || "");
}

async function getServerQuestionPool(context, cacheName, loader) {
    const now = Date.now();
    const memoryEntry = questionPoolMemoryCache.get(cacheName);
    if (memoryEntry && memoryEntry.expiresAt > now) return memoryEntry.promise;

    const promise = (async () => {
        const cache = globalThis.caches?.default;
        const internalUrl = new URL(context.request.url);
        internalUrl.pathname = `/__server-cache/question-pool/${encodeURIComponent(cacheName)}`;
        internalUrl.search = "";
        const internalKey = new Request(internalUrl.toString(), { method: "GET" });
        if (cache) {
            const cached = await cache.match(internalKey);
            if (cached?.ok && cached.headers.get("X-ExamPortal-Server-Cache") === "question-pool") {
                return cached.json();
            }
        }

        const rows = await loader();
        if (cache) {
            await cache.put(internalKey, new Response(JSON.stringify(rows || []), {
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": `max-age=${QUESTION_POOL_CACHE_SECONDS}`,
                    "X-ExamPortal-Server-Cache": "question-pool",
                    "X-Robots-Tag": "noindex, nofollow"
                }
            }));
        }
        return rows || [];
    })().catch(error => {
        questionPoolMemoryCache.delete(cacheName);
        throw error;
    });

    questionPoolMemoryCache.set(cacheName, {
        promise,
        expiresAt: now + (QUESTION_POOL_CACHE_SECONDS * 1000)
    });
    return promise;
}

async function handleQuestions(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const url = new URL(context.request.url);
    const view = url.searchParams.get("view") || "text";
    if (view === "catalog") {
        const rows = await supabaseServerRequest(context.env, "Exam?select=category&order=id.asc");
        const counts = new Map();
        for (const row of rows || []) {
            const category = String(row.category || "");
            if (!category || category.startsWith("__PE__::")) continue;
            counts.set(category, (counts.get(category) || 0) + 1);
        }
        return json([...counts].map(([category, count]) => ({ category, count })), 200, PUBLIC_CACHE_SHORT);
    }
    if (view === "pe-catalog") {
        const rows = await supabaseServerRequest(context.env, "Exam?select=category&order=id.asc");
        const counts = new Map();
        for (const row of rows || []) {
            const info = parsePECategory(row.category);
            if (!info) continue;
            const key = `${info.peType}::${info.topic}`;
            const current = counts.get(key) || { peType: info.peType, topic: info.topic, count: 0 };
            current.count += 1;
            counts.set(key, current);
        }
        return json([...counts.values()], 200, PUBLIC_CACHE_SHORT);
    }
    if (view === "pe-practice") {
        const peType = String(url.searchParams.get("pe_type") || "").normalize("NFKC").trim();
        const topic = String(url.searchParams.get("topic") || "").normalize("NFKC").trim();
        if (!peType || peType.length > 80 || !topic || topic.length > 160) {
            return apiError(400, "invalid_pe_topic", "A valid PE type and topic are required.");
        }
        const fields = "id,category,question,optionA,optionB,optionC,optionD";
        const categories = [`__PE__::${peType}::${topic}`];
        if (peType === "BCSC(main)") categories.push(`__PE__::Mock::${topic}`);
        const responses = await Promise.all(categories.map(category => {
            const params = new URLSearchParams({
                select: fields,
                order: "id.asc"
            });
            params.set("category", `eq.${category}`);
            return supabaseServerRequest(context.env, `Exam?${params.toString()}`);
        }));
        return json(responses.flatMap(rows => rows || []).map(row => {
            const stored = decodeStoredQuestion(row.question);
            return {
                ...row,
                question: stored.question,
                answer_type: stored.answerType
            };
        }), 200, PUBLIC_CACHE_SHORT);
    }
    if (view === "media") {
        const ids = validateMediaIds(url.searchParams.get("ids"));
        if (!ids.length) return apiError(400, "missing_ids", "Question media IDs are required.");
        const rows = await supabaseServerRequest(
            context.env,
            `Exam?select=id,category,image,audio&id=in.(${ids.join(",")})`
        );
        return json((rows || []).map(row => normalizePublicQuestionMediaRow(context, row, "Exam")), 200, PUBLIC_CACHE_MEDIA);
    }
    if (view === "category-media") {
        const category = String(url.searchParams.get("category") || "").normalize("NFKC").trim();
        if (!category || category.length > 200) {
            return apiError(400, "invalid_category", "A valid category is required.");
        }
        const params = new URLSearchParams({
            select: "id,category,image,audio",
            order: "id.asc"
        });
        params.set("category", `eq.${category}`);
        const rows = await supabaseServerRequest(context.env, `Exam?${params.toString()}`);
        return json((rows || []).map(row => normalizePublicQuestionMediaRow(context, row, "Exam")), 200, PUBLIC_CACHE_MEDIA);
    }
    return apiError(400, "invalid_view", "Question view must be catalog, pe-catalog, pe-practice, media, or category-media.");
}

async function handlePEOverview(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const rows = await supabaseServerRequest(context.env, "Exam?select=category,image&order=id.asc");
    const types = new Map();
    for (const row of rows || []) {
        const info = parsePECategory(row.category);
        if (!info) continue;
        const current = types.get(info.peType) || { type: info.peType, questions: 0, graphPaths: new Set() };
        current.questions += 1;
        if (info.peType === "Data Interpretation" && String(row.image || "").trim()) {
            current.graphPaths.add(String(row.image).trim());
        }
        types.set(info.peType, current);
    }
    const categories = [...types.values()].map(item => ({
        type: item.type,
        questions: item.questions,
        graphs: item.graphPaths.size
    }));
    return json({ categories }, 200, PUBLIC_CACHE_SHORT);
}

async function handlePEResources(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const fields = "id,kind,title,content,practice_prompt,document_url,preview_url,website_url,updated_at";
    const rows = await supabaseServerRequest(
        context.env,
        `PEResources?select=${fields}&published=eq.true&order=sort_order.asc,id.asc`
    );
    return json((rows || []).map(row => ({
        ...row,
        document_url: normalizePublicMediaValue(context.env, row.document_url, "application"),
        preview_url: normalizePublicMediaValue(context.env, row.preview_url, "image")
    })), 200, PUBLIC_CACHE_SHORT);
}

async function handlePEResourcePdf(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const id = new URL(context.request.url).searchParams.get("id") || "";
    if (!/^\d+$/.test(id)) return apiError(400, "invalid_resource_id", "A valid guide resource ID is required.");
    const rows = await supabaseServerRequest(
        context.env,
        `PEResources?select=id,document_url&id=eq.${encodeURIComponent(id)}&kind=eq.guide&published=eq.true&limit=1`
    );
    const documentUrl = normalizePublicMediaValue(context.env, rows?.[0]?.document_url, "application");
    const trustedPrefix = `${String(context.env.SUPABASE_URL || "").replace(/\/$/, "")}/storage/v1/object/public/${MEDIA_BUCKET}/`;
    if (!documentUrl || !documentUrl.startsWith(trustedPrefix) || !/\.pdf(?:$|[?#])/i.test(documentUrl)) {
        return apiError(404, "pdf_not_found", "This guide does not have an available PDF document.");
    }
    const upstream = await fetch(documentUrl, { headers: { Accept: "application/pdf" } });
    if (!upstream.ok || !String(upstream.headers.get("content-type") || "").toLowerCase().includes("application/pdf")) {
        return apiError(502, "pdf_fetch_failed", "The guide PDF could not be loaded.");
    }
    return new Response(upstream.body, {
        status: 200,
        headers: {
            "Content-Type": "application/pdf",
            "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=600",
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff"
        }
    });
}

async function handlePEResourceAnswer(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    const payload = await readJson(context.request, 2048);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || Object.keys(payload).some(key => !["id", "answer"].includes(key))) {
        return apiError(400, "invalid_formula_answer", "A formula resource ID and answer are required.");
    }
    const id = String(payload.id || "").trim();
    const answer = String(payload.answer || "").normalize("NFKC").trim().toLocaleLowerCase();
    if (!/^\d{1,12}$/.test(id) || !answer || answer.length > 500) {
        return apiError(400, "invalid_formula_answer", "The formula answer is invalid.");
    }
    const rows = await supabaseServerRequest(
        context.env,
        `PEResources?select=id,practice_answer&id=eq.${encodeURIComponent(id)}&kind=eq.formula&published=eq.true&limit=1`
    );
    if (!rows?.length || !String(rows[0].practice_answer || "").trim()) {
        return apiError(404, "formula_not_found", "Formula practice is not available.");
    }
    const expected = String(rows[0].practice_answer).normalize("NFKC").trim().toLocaleLowerCase();
    return json({ id: String(rows[0].id), correct: answer === expected });
}

async function handleQuestionSolution(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    const payload = await readJson(context.request, 4096);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || Object.keys(payload).some(key => !["id", "selected_index", "written_answer"].includes(key))) {
        return apiError(400, "invalid_check", "Question check contains unexpected fields.");
    }
    const id = String(payload.id || "").trim();
    if (!/^\d{1,12}$/.test(id)) return apiError(400, "invalid_id", "Question ID is invalid.");
    const hasSelectedIndex = Object.hasOwn(payload, "selected_index");
    const hasWrittenAnswer = Object.hasOwn(payload, "written_answer");
    if (hasSelectedIndex === hasWrittenAnswer) return apiError(400, "invalid_check", "Provide one answer to check.");
    const rows = await supabaseServerRequest(
        context.env,
        `Exam?select=id,category,question,answer&id=eq.${id}&limit=1`
    );
    if (!rows?.length) return apiError(404, "not_found", "Question was not found.");
    if (!String(rows[0].category || "").startsWith("__PE__::")) {
        return apiError(403, "solution_unavailable", "Solutions are available only in PE practice.");
    }
    const stored = decodeStoredQuestion(rows[0].question);
    if (hasWrittenAnswer) {
        if (stored.answerType !== "written") return apiError(400, "invalid_answer_type", "This question requires a multiple-choice answer.");
        const submitted = payload.written_answer;
        if (typeof submitted !== "string" || submitted.length > 2000) {
            return apiError(400, "invalid_written_answer", "Written answer must be text up to 2000 characters.");
        }
        const expected = String(stored.writtenAnswer || "").trim().toLocaleLowerCase();
        if (!expected) return apiError(404, "written_answer_unavailable", "Written answer is not available.");
        return json({
            id: String(rows[0].id),
            correct: submitted.trim().toLocaleLowerCase() === expected,
            explanation: stored.explanation
        });
    }
    if (stored.answerType === "written") return apiError(400, "invalid_answer_type", "This question requires a written answer.");
    const selectedIndex = Number(payload.selected_index);
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex > 3) {
        return apiError(400, "invalid_selection", "Selected answer must be 0, 1, 2, or 3.");
    }
    return json({
        id: String(rows[0].id),
        correct: selectedIndex === parseAnswerIndex(rows[0].answer),
        explanation: stored.explanation
    });
}

async function handlePEOnlineQuestions(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const url = new URL(context.request.url);
    const view = url.searchParams.get("view") || "text";
    if (view === "catalog") {
        const rows = await supabaseServerRequest(context.env, "PEOnlineExam?select=category&order=id.asc");
        const counts = { "Past Paper": 0, "Data Interpretation": 0, "Current Affairs": 0 };
        for (const row of rows || []) {
            const info = parsePECategory(row.category);
            if (info && Object.hasOwn(counts, info.peType)) counts[info.peType] += 1;
        }
        return json({ counts, total: calculatePEOnlineTotal(counts) }, 200, PUBLIC_CACHE_SHORT);
    }
    if (view === "media") {
        const ids = validateMediaIds(url.searchParams.get("ids"));
        if (!ids.length) return apiError(400, "missing_ids", "PE Online media IDs are required.");
        const rows = await supabaseServerRequest(
            context.env,
            `PEOnlineExam?select=id,category,image,audio&id=in.(${ids.join(",")})`
        );
        return json((rows || []).map(row => normalizePublicQuestionMediaRow(context, row, "PEOnlineExam")), 200, PUBLIC_CACHE_MEDIA);
    }
    if (view === "all-media") {
        const rows = await supabaseServerRequest(
            context.env,
            "PEOnlineExam?select=id,category,image,audio&order=id.asc"
        );
        return json((rows || []).map(row => normalizePublicQuestionMediaRow(context, row, "PEOnlineExam")), 200, PUBLIC_CACHE_MEDIA);
    }
    return apiError(400, "invalid_view", "PE Online question view must be catalog, media, or all-media.");
}

async function handleFlashcards(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const fields = "id,scope,category,date_stamp,exam_focus,created_at";
    return json(await supabaseServerRequest(
        context.env,
        `CurrentAffairFlashcards?select=${fields}&order=created_at.desc`
    ), 200, PUBLIC_CACHE_SHORT);
}

function normalizeOption(value) {
    const text = String(value || "").trim();
    const isoDateOnly = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{3})?Z$/;
    if (!isoDateOnly.test(text)) return text;
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text;
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Thimphu",
        day: "numeric",
        month: "long",
        year: "numeric"
    }).format(date);
}

function shuffled(values) {
    const output = [...values];
    for (let i = output.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [output[i], output[j]] = [output[j], output[i]];
    }
    return output;
}

function parsePECategory(value) {
    const category = String(value || "");
    if (!category.startsWith("__PE__::")) return null;
    const parts = category.split("::");
    const rawType = parts[1] || "BCSC(main)";
    return { peType: rawType === "Mock" ? "BCSC(main)" : rawType, topic: parts[2] || "General" };
}

function calculatePEOnlineTotal(counts) {
    const di = Math.min(Number(counts["Data Interpretation"] || 0), 20);
    const currentAffairs = Math.min(Number(counts["Current Affairs"] || 0), 20);
    return Math.min(100, di + currentAffairs + Number(counts["Past Paper"] || 0));
}

function parseAnswerIndex(value) {
    const normalized = String(value || "").trim().toUpperCase();
    if (["A", "B", "C", "D"].includes(normalized)) return normalized.charCodeAt(0) - 65;
    const numeric = Number.parseInt(normalized, 10);
    if (numeric >= 1 && numeric <= 4) return numeric - 1;
    if (numeric >= 0 && numeric <= 3) return numeric;
    return -1;
}

const QUESTION_META_DELIM = "\n§§QUESTION_META§§\n";
const EXPLANATION_DELIM = "\n§§EXPLAIN§§\n";

function decodeStoredQuestion(raw) {
    const text = String(raw || "");
    const explanationIndex = text.indexOf(EXPLANATION_DELIM);
    const content = explanationIndex === -1 ? text : text.slice(0, explanationIndex);
    const explanation = explanationIndex === -1 ? "" : text.slice(explanationIndex + EXPLANATION_DELIM.length);
    const metaIndex = content.indexOf(QUESTION_META_DELIM);
    const question = metaIndex === -1 ? content : content.slice(0, metaIndex);
    let metadata = {};
    if (metaIndex !== -1) {
        try { metadata = JSON.parse(content.slice(metaIndex + QUESTION_META_DELIM.length)); } catch (error) {}
    }
    return {
        question,
        explanation,
        answerType: metadata?.answer_type === "written" ? "written" : "multiple_choice",
        writtenAnswer: metadata?.answer_type === "written" ? String(metadata.written_answer || "") : ""
    };
}

function publicQuestionText(raw) {
    return decodeStoredQuestion(raw).question;
}

let examSessionSchemaReady = false;

async function ensureExamSessionSchema(db) {
    if (examSessionSchemaReady) return;
    await db.prepare(`
        create table if not exists exam_sessions (
            session_id text primary key,
            payload text not null,
            expires_at integer not null,
            used_at integer
        )
    `).run();
    await db.prepare(`
        create index if not exists exam_sessions_expiry_idx
        on exam_sessions (expires_at)
    `).run();
    examSessionSchemaReady = true;
}

async function sendTransactionalEmail(context, email) {
    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${context.env.RESEND_API_KEY}`
        },
        body: JSON.stringify(email)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.id) {
        console.error("Resend upstream failure", response.status, result.message || result.name || "Unknown error");
        throw new Error("email_delivery_failed");
    }
    return result;
}

function trustedStoragePrefix(env) {
    return `${String(env.SUPABASE_URL || "").replace(/\/$/, "")}/storage/v1/object/public/${MEDIA_BUCKET}/`;
}

function normalizePublicMediaValue(env, value, expectedType) {
    const source = String(value || "").trim();
    if (!source) return "";
    if (source.startsWith("https://") || source.startsWith("blob:")) return source;
    if (source.startsWith(`data:${expectedType}/`)) return source;

    const supabaseOrigin = String(env.SUPABASE_URL || "").replace(/\/$/, "");
    const bucketPrefix = `${MEDIA_BUCKET}/`;

    if (source.startsWith("/storage/v1/object/public/")) {
        return `${supabaseOrigin}${source}`;
    }
    if (source.startsWith("storage/v1/object/public/")) {
        return `${supabaseOrigin}/${source}`;
    }

    const normalizedPath = source.startsWith(bucketPrefix)
        ? source.slice(bucketPrefix.length)
        : source.replace(/^\/+/, "");

    return `${trustedStoragePrefix(env)}${normalizedPath}`;
}

function normalizePublicMediaRow(env, row, idTransform = value => value) {
    return {
        ...row,
        id: idTransform(row.id),
        image: normalizePublicMediaValue(env, row.image, "image"),
        audio: normalizePublicMediaValue(env, row.audio, "audio")
    };
}

function normalizePublicQuestionMediaRow(context, row, table) {
    const isPEOnline = table === "PEOnlineExam";
    const normalized = normalizePublicMediaRow(
        context.env,
        row,
        value => isPEOnline ? `peo:${value}` : value
    );
    const info = parsePECategory(row.category);
    if (info?.peType === "Data Interpretation" && normalized.image) {
        const url = new URL(context.request.url);
        url.pathname = "/api/pe-di-graph";
        url.search = new URLSearchParams({
            id: String(row.id),
            source: isPEOnline ? "pe-online" : "practice"
        }).toString();
        normalized.image = url.toString();
    }
    delete normalized.category;
    return normalized;
}

async function handlePEDIGraph(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const url = new URL(context.request.url);
    const id = String(url.searchParams.get("id") || "").trim();
    const source = String(url.searchParams.get("source") || "practice");
    if (!/^\d{1,12}$/.test(id) || !["practice", "pe-online"].includes(source)) {
        return apiError(400, "invalid_graph", "A valid Data Interpretation graph is required.");
    }

    const cache = globalThis.caches?.default;
    const cacheUrl = new URL(url.origin);
    cacheUrl.pathname = `/__server-cache/pe-di-graph/${source}/${id}`;
    const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
    if (cache) {
        const cached = await cache.match(cacheKey);
        if (cached?.ok && cached.headers.get("X-ExamPortal-Server-Cache") === "di-graph") return cached;
    }

    const table = source === "pe-online" ? "PEOnlineExam" : "Exam";
    const rows = await supabaseServerRequest(
        context.env,
        `${table}?select=id,category,image&id=eq.${id}&limit=1`
    );
    const row = rows?.[0];
    if (parsePECategory(row?.category)?.peType !== "Data Interpretation") {
        return apiError(404, "graph_not_found", "Data Interpretation graph was not found.");
    }
    const graphUrl = normalizePublicMediaValue(context.env, row.image, "image");
    if (!graphUrl || !graphUrl.startsWith(trustedStoragePrefix(context.env))) {
        return apiError(404, "graph_not_found", "Data Interpretation graph was not found.");
    }
    const upstream = await fetch(graphUrl, { headers: { Accept: "image/avif,image/webp,image/*" } });
    const contentType = String(upstream.headers.get("content-type") || "").toLowerCase();
    if (!upstream.ok || !contentType.startsWith("image/")) {
        return apiError(502, "graph_fetch_failed", "Data Interpretation graph could not be loaded.");
    }
    const response = new Response(upstream.body, {
        status: 200,
        headers: {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
            "X-ExamPortal-Server-Cache": "di-graph",
            "X-Content-Type-Options": "nosniff"
        }
    });
    if (cache) {
        const cacheWrite = cache.put(cacheKey, response.clone());
        if (typeof context.waitUntil === "function") context.waitUntil(cacheWrite);
        else await cacheWrite;
    }
    return response;
}

function buildSecureQuestions(rows, idPrefix = "") {
    const prepared = [];
    for (const row of rows || []) {
        const storedOptions = [row.optionA, row.optionB, row.optionC, row.optionD].map(normalizeOption);
        const answerIndex = parseAnswerIndex(row.answer);
        if (answerIndex < 0 || storedOptions.some(option => !option)) continue;
        const optionItems = shuffled(storedOptions.map((text, index) => ({ text, correct: index === answerIndex })));
        const options = optionItems.map(item => item.text);
        prepared.push({
            publicQuestion: {
                id: `${idPrefix}${row.id}`,
                category: row.category,
                question: publicQuestionText(row.question),
                options
            },
            gradingItem: {
                id: `${idPrefix}${row.id}`,
                question: publicQuestionText(row.question),
                options,
                correctIndex: optionItems.findIndex(item => item.correct)
            }
        });
    }
    return prepared;
}

async function storeRichExamSession(db, payload) {
    await ensureExamSessionSchema(db);
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    await db.prepare(
        "insert into exam_sessions (session_id, payload, expires_at, used_at) values (?1, ?2, ?3, null)"
    ).bind(sessionId, JSON.stringify(payload), now + 3 * HOUR).run();
    return sessionId;
}

function normalizeStoredExamSession(payload) {
    const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (Array.isArray(parsed)) {
        return {
            version: 1,
            publicQuestions: [],
            gradingItems: parsed
        };
    }
    return {
        version: Number(parsed?.version || 2),
        publicQuestions: Array.isArray(parsed?.publicQuestions) ? parsed.publicQuestions : [],
        gradingItems: Array.isArray(parsed?.gradingItems) ? parsed.gradingItems : []
    };
}

function buildQuestionWindow(publicQuestions, startIndex = 0, count = 2) {
    const items = [];
    for (let offset = 0; offset < count; offset += 1) {
        const index = startIndex + offset;
        if (index >= publicQuestions.length) break;
        items.push({
            index,
            question: publicQuestions[index]
        });
    }
    return items;
}

function selectPEOnlineRows(rows) {
    const byType = type => (rows || []).filter(row => parsePECategory(row.category)?.peType === type);
    const pastPool = shuffled(byType("Past Paper"));
    const currentAffairs = shuffled(byType("Current Affairs")).slice(0, 20);

    const diByTopic = new Map();
    for (const row of byType("Data Interpretation")) {
        const topic = parsePECategory(row.category).topic;
        if (!diByTopic.has(topic)) diByTopic.set(topic, []);
        diByTopic.get(topic).push(row);
    }
    const dataInterpretation = [];
    for (const topic of shuffled([...diByTopic.keys()])) {
        dataInterpretation.push(...diByTopic.get(topic));
        if (dataInterpretation.length >= 20) break;
    }

    const remaining = Math.max(100 - dataInterpretation.length - currentAffairs.length, 0);
    const past = pastPool.slice(0, remaining);
    return [...shuffled([...past, ...currentAffairs]), ...dataInterpretation];
}

async function handleFlashcardAnswer(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const id = new URL(context.request.url).searchParams.get("id") || "";
    if (!/^\d{1,12}$/.test(id)) return apiError(400, "invalid_id", "Flashcard ID is invalid.");
    const rows = await supabaseServerRequest(
        context.env,
        `CurrentAffairFlashcards?select=id,answer&id=eq.${id}&limit=1`
    );
    if (!rows?.length) return apiError(404, "not_found", "Flashcard was not found.");
    return json({ id: String(rows[0].id), answer: rows[0].answer || "" });
}

async function handleExamStart(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    const { category } = validateExamStartPayload(await readJson(context.request, 4096));
    if (category.startsWith("__PE__::")) {
        return apiError(400, "invalid_category", "Choose a normal exam category.");
    }
    const fields = "id,category,question,optionA,optionB,optionC,optionD,answer";
    const rows = await getServerQuestionPool(context, `exam:${category}`, () => supabaseServerRequest(
        context.env,
        `Exam?select=${fields}&category=eq.${encodeURIComponent(category)}&order=id.asc`
    ));
    const prepared = buildSecureQuestions(shuffled(rows || []));
    if (!prepared.length) return apiError(404, "no_questions", "No valid questions were found in this category.");
    const publicQuestions = prepared.map(item => item.publicQuestion);
    const sessionId = await storeRichExamSession(context.env.RATE_LIMIT_DB, {
        version: 2,
        publicQuestions,
        gradingItems: prepared.map(item => item.gradingItem)
    });
    const initialWindow = buildQuestionWindow(publicQuestions, 0, QUESTION_WINDOW_SIZE);
    return json({
        ok: true,
        session_id: sessionId,
        total: publicQuestions.length,
        questions: initialWindow
    }, 201);
}

async function handleExamQuestion(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const url = new URL(context.request.url);
    const sessionId = String(url.searchParams.get("session_id") || "").trim();
    const indexText = String(url.searchParams.get("index") || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
        return apiError(400, "invalid_exam_session", "Exam session is invalid.");
    }
    if (!/^\d{1,3}$/.test(indexText)) {
        return apiError(400, "invalid_index", "Question index is invalid.");
    }
    const index = Number.parseInt(indexText, 10);
    await ensureExamSessionSchema(context.env.RATE_LIMIT_DB);
    const session = await context.env.RATE_LIMIT_DB.prepare(
        "select payload from exam_sessions where session_id = ?1 and expires_at > ?2 limit 1"
    ).bind(sessionId, Date.now()).first();
    if (!session?.payload) {
        return apiError(404, "session_not_found", "Exam session could not be found.");
    }
    const normalized = normalizeStoredExamSession(session.payload);
    if (!normalized.publicQuestions.length) {
        return apiError(409, "session_not_streamable", "This exam session does not support question streaming.");
    }
    if (index < 0 || index >= normalized.publicQuestions.length) {
        return apiError(400, "invalid_index", "Question index is outside the exam range.");
    }
    return json({
        ok: true,
        total: normalized.publicQuestions.length,
        questions: buildQuestionWindow(normalized.publicQuestions, index, QUESTION_WINDOW_SIZE)
    }, 200);
}

async function handlePEOnlineStart(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    validateEmptyPayload(await readJson(context.request, 1024), "PE Online start request");
    const fields = "id,category,question,optionA,optionB,optionC,optionD,answer";
    const rows = await getServerQuestionPool(context, "pe-online:all", () => (
        supabaseServerRequest(context.env, `PEOnlineExam?select=${fields}&order=id.asc`)
    ));
    const selected = selectPEOnlineRows(rows || []);
    const prepared = buildSecureQuestions(selected, "peo:");
    if (!prepared.length) return apiError(404, "no_questions", "No valid PE Online questions were found.");
    const publicQuestions = prepared.map(item => item.publicQuestion);
    const sessionId = await storeRichExamSession(context.env.RATE_LIMIT_DB, {
        version: 2,
        publicQuestions,
        gradingItems: prepared.map(item => item.gradingItem)
    });
    return json({
        ok: true,
        session_id: sessionId,
        total: publicQuestions.length,
        questions: buildQuestionWindow(publicQuestions, 0, QUESTION_WINDOW_SIZE)
    }, 201);
}

async function handlePEOnlineQuestion(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const url = new URL(context.request.url);
    const sessionId = String(url.searchParams.get("session_id") || "").trim();
    const indexText = String(url.searchParams.get("index") || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
        return apiError(400, "invalid_exam_session", "PE Online session is invalid.");
    }
    if (!/^\d{1,3}$/.test(indexText)) {
        return apiError(400, "invalid_index", "Question index is invalid.");
    }
    const index = Number.parseInt(indexText, 10);
    await ensureExamSessionSchema(context.env.RATE_LIMIT_DB);
    const session = await context.env.RATE_LIMIT_DB.prepare(
        "select payload from exam_sessions where session_id = ?1 and expires_at > ?2 limit 1"
    ).bind(sessionId, Date.now()).first();
    if (!session?.payload) {
        return apiError(404, "session_not_found", "PE Online session could not be found.");
    }
    const normalized = normalizeStoredExamSession(session.payload);
    if (!normalized.publicQuestions.length) {
        return apiError(409, "session_not_streamable", "This PE Online session does not support question streaming.");
    }
    if (index < 0 || index >= normalized.publicQuestions.length) {
        return apiError(400, "invalid_index", "Question index is outside the exam range.");
    }
    return json({
        ok: true,
        total: normalized.publicQuestions.length,
        questions: buildQuestionWindow(normalized.publicQuestions, index, QUESTION_WINDOW_SIZE)
    }, 200);
}

async function purgeExpiredQuotes(env, nowIso) {
    await supabaseServerRequest(
        env,
        `daily_quotes?expires_at=lte.${encodeURIComponent(nowIso)}`,
        { method: "DELETE", prefer: "return=minimal" }
    );
}

function queueExpiredQuoteCleanup(context, nowIso) {
    const cleanup = purgeExpiredQuotes(context.env, nowIso).catch(error => {
        console.error("Expired daily quote cleanup failed:", error);
    });
    if (typeof context.waitUntil === "function") context.waitUntil(cleanup);
}

async function handleQuotes(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const nowIso = new Date().toISOString();
    queueExpiredQuoteCleanup(context, nowIso);
    const now = encodeURIComponent(nowIso);
    return json(await supabaseServerRequest(
        context.env,
        `daily_quotes?select=id,english_quote,dzongkha_quote,expires_at,created_at&expires_at=gt.${now}&order=created_at.desc`
    ), 200, PUBLIC_CACHE_SHORT);
}

async function handleResponses(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    const submission = validateGradedResponsePayload(await readJson(context.request, 512000));
    await ensureExamSessionSchema(context.env.RATE_LIMIT_DB);
    const session = await context.env.RATE_LIMIT_DB.prepare(
        "update exam_sessions set used_at = ?1 where session_id = ?2 and used_at is null and expires_at > ?1 returning payload"
    ).bind(Date.now(), submission.session_id).first();
    if (!session?.payload) return apiError(409, "invalid_exam_session", "Exam session is expired or already submitted.");
    const normalized = normalizeStoredExamSession(session.payload);
    const items = normalized.gradingItems;
    if (items.length !== submission.selections.length) {
        return apiError(400, "invalid_selections", "Answer count does not match the exam session.");
    }
    let correct = 0;
    let wrong = 0;
    let skipped = 0;
    const grading = items.map((item, index) => {
        const selectedIndex = submission.selections[index];
        const status = selectedIndex === null ? "SKIPPED" : selectedIndex === item.correctIndex ? "CORRECT" : "WRONG";
        if (status === "CORRECT") correct++;
        else if (status === "WRONG") wrong++;
        else skipped++;
        return { status };
    });
    const payload = {
        time_stamp: submission.time_stamp,
        student_name: submission.student_name,
        category_track: submission.category_track,
        final_score: `${correct}/${items.length}`,
        detailed_breakdown: items.map((item, index) => ({
            question: item.question,
            selected: submission.selections[index] === null ? "Skipped" : ["A", "B", "C", "D"][submission.selections[index]],
            status: grading[index].status
        }))
    };
    const saveResponse = supabaseServerRequest(context.env, "Response", {
        method: "POST",
        body: payload,
        prefer: "return=minimal"
    }).catch(error => {
        console.error("Exam response history save failed:", error);
    });
    if (typeof context.waitUntil === "function") context.waitUntil(saveResponse);
    else await saveResponse;
    return json({
        ok: true,
        save_queued: true,
        result: {
            correct,
            wrong,
            skipped,
            total: items.length,
            grading
        }
    }, 201);
}

async function handleContact(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    if (!context.env.CONTACT_EMAIL || !context.env.RESEND_API_KEY) {
        return apiError(503, "security_not_configured", "Contact delivery is not configured yet.");
    }
    const payload = validateContactPayload(await readJson(context.request, 16384));
    const message = [
        `Name: ${payload.name}`,
        `Email: ${payload.email || "Not provided"}`,
        `Inquiry type: ${payload.inquiry_type}`,
        "",
        payload.message
    ].join("\n");
    const email = {
        from: "ExamPortal <onboarding@resend.dev>",
        to: [context.env.CONTACT_EMAIL],
        subject: `ExamPortal Contact: ${payload.subject}`,
        text: message
    };
    if (payload.email) email.reply_to = payload.email;

    try {
        await sendTransactionalEmail(context, email);
    } catch (error) {
        return apiError(502, "contact_delivery_failed", "Message delivery failed. Please try again later.");
    }
    return json({ ok: true }, 201);
}

export async function onRequest(context) {
    const name = routeName(context);
    const policy = POLICIES[name];
    if (!policy) return apiError(404, "not_found", "API endpoint not found.");

    const originFailure = rejectCrossSiteRequest(context.request);
    if (originFailure) return originFailure;

    const session = getSession(context.request);
    try {
        const rateLimitFailure = await enforceRateLimits(context, name, session.id, policy);
        if (rateLimitFailure) return withSessionCookie(rateLimitFailure, session.id, session.isNew);

        let response;
        if (name === "health") response = json({ ok: true, service: "ExamPortal API" });
        else if (name === "questions") response = await handleQuestions(context);
        else if (name === "pe-overview") response = await handlePEOverview(context);
        else if (name === "pe-resources") response = await handlePEResources(context);
        else if (name === "pe-resource-pdf") response = await handlePEResourcePdf(context);
        else if (name === "pe-resource-answer") response = await handlePEResourceAnswer(context);
        else if (name === "pe-di-graph") response = await handlePEDIGraph(context);
        else if (name === "exam-start") response = await handleExamStart(context);
        else if (name === "exam-question") response = await handleExamQuestion(context);
        else if (name === "question-solution") response = await handleQuestionSolution(context);
        else if (name === "pe-online-questions") response = await handlePEOnlineQuestions(context);
        else if (name === "pe-online-start") response = await handlePEOnlineStart(context);
        else if (name === "pe-online-question") response = await handlePEOnlineQuestion(context);
        else if (name === "flashcards") response = await handleFlashcards(context);
        else if (name === "flashcard-answer") response = await handleFlashcardAnswer(context);
        else if (name === "quotes") response = await handleQuotes(context);
        else if (name === "responses") response = await handleResponses(context);
        else if (name === "contact") response = await handleContact(context);
        else response = apiError(404, "not_found", "API endpoint not found.");
        return withSessionCookie(response, session.id, session.isNew);
    } catch (error) {
        return withSessionCookie(handleError(error), session.id, session.isNew);
    }
}
