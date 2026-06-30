import { apiError, handleError, json, methodNotAllowed, readJson, withSessionCookie } from "../_shared/http.js";
import { enforceRateLimits, getSession, rejectCrossSiteRequest } from "../_shared/security.js";
import { supabaseServerRequest } from "../_shared/supabase.js";
import {
    validateAdminBulkQuestionsPayload,
    validateAdminFlashcardPayload,
    validateAdminOtpRequestPayload,
    validateAdminOtpVerifyPayload,
    validateAdminQuestionPayload,
    validateAdminQuotePayload,
    validateContactPayload,
    validateEmptyPayload,
    validateExamStartPayload,
    validateGradedResponsePayload,
    validateMediaIds
} from "../_shared/validation.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const PUBLIC_CACHE_SHORT = {
    "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=120"
};
const PUBLIC_CACHE_MEDIA = {
    "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=600"
};

const POLICIES = {
    health: { windowMs: MINUTE, ipLimit: 30, sessionLimit: 30 },
    questions: { windowMs: MINUTE, ipLimit: 60, sessionLimit: 90 },
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
    contact: { windowMs: HOUR, ipLimit: 3, sessionLimit: 2 },
    "admin-otp-request": { windowMs: 10 * MINUTE, ipLimit: 8, sessionLimit: 5 },
    "admin-otp-verify": { windowMs: 10 * MINUTE, ipLimit: 15, sessionLimit: 10 },
    "admin-questions": { windowMs: MINUTE, ipLimit: 60, sessionLimit: 60 },
    "admin-question-media": { windowMs: MINUTE, ipLimit: 90, sessionLimit: 90 },
    "admin-question": { windowMs: 10 * MINUTE, ipLimit: 60, sessionLimit: 60 },
    "admin-bulk-questions": { windowMs: 10 * MINUTE, ipLimit: 20, sessionLimit: 20 },
    "admin-flashcard": { windowMs: 10 * MINUTE, ipLimit: 40, sessionLimit: 40 },
    "admin-quote": { windowMs: 10 * MINUTE, ipLimit: 40, sessionLimit: 40 }
};

function routeName(context) {
    const path = context.params.path;
    return Array.isArray(path) ? path.join("/") : String(path || "");
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
    if (view === "text" || view === "pe-practice") {
        const fields = "id,category,question,optionA,optionB,optionC,optionD";
        const rows = await supabaseServerRequest(context.env, `Exam?select=${fields}&order=id.asc`);
        return json((rows || [])
            .filter(row => String(row.category || "").startsWith("__PE__::"))
            .map(row => ({ ...row, question: publicQuestionText(row.question) })), 200, PUBLIC_CACHE_SHORT);
    }
    if (view === "media") {
        const ids = validateMediaIds(url.searchParams.get("ids"));
        if (!ids.length) return apiError(400, "missing_ids", "Question media IDs are required.");
        return json(await supabaseServerRequest(
            context.env,
            `Exam?select=id,image,audio&id=in.(${ids.join(",")})`
        ), 200, PUBLIC_CACHE_MEDIA);
    }
    if (view === "category-media") {
        const category = String(url.searchParams.get("category") || "").normalize("NFKC").trim();
        if (!category || category.length > 200) {
            return apiError(400, "invalid_category", "A valid category is required.");
        }
        const params = new URLSearchParams({
            select: "id,image,audio",
            order: "id.asc"
        });
        params.set("category", `eq.${category}`);
        return json(await supabaseServerRequest(context.env, `Exam?${params.toString()}`), 200, PUBLIC_CACHE_MEDIA);
    }
    return apiError(400, "invalid_view", "Question view must be catalog, pe-practice, media, or category-media.");
}

async function handleQuestionSolution(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const id = new URL(context.request.url).searchParams.get("id") || "";
    if (!/^\d{1,12}$/.test(id)) return apiError(400, "invalid_id", "Question ID is invalid.");
    const rows = await supabaseServerRequest(
        context.env,
        `Exam?select=id,category,question,answer&id=eq.${id}&limit=1`
    );
    if (!rows?.length) return apiError(404, "not_found", "Question was not found.");
    if (!String(rows[0].category || "").startsWith("__PE__::")) {
        return apiError(403, "solution_unavailable", "Solutions are available only in PE practice.");
    }
    const rawQuestion = String(rows[0].question || "");
    const delimiter = "\n§§EXPLAIN§§\n";
    const delimiterIndex = rawQuestion.indexOf(delimiter);
    return json({
        id: String(rows[0].id),
        answerIndex: parseAnswerIndex(rows[0].answer),
        explanation: delimiterIndex < 0 ? "" : rawQuestion.slice(delimiterIndex + delimiter.length)
    });
}

async function handlePEOnlineQuestions(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const url = new URL(context.request.url);
    const view = url.searchParams.get("view") || "text";
    if (view === "catalog") {
        const rows = await supabaseServerRequest(context.env, "PEOnlineExam?select=category&order=id.asc");
        const counts = { Mock: 0, "Past Paper": 0, "Data Interpretation": 0, "Current Affairs": 0 };
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
            `PEOnlineExam?select=id,image,audio&id=in.(${ids.join(",")})`
        );
        return json((rows || []).map(row => ({ ...row, id: `peo:${row.id}` })), 200, PUBLIC_CACHE_MEDIA);
    }
    if (view === "all-media") {
        const rows = await supabaseServerRequest(
            context.env,
            "PEOnlineExam?select=id,image,audio&order=id.asc"
        );
        return json((rows || []).map(row => ({ ...row, id: `peo:${row.id}` })), 200, PUBLIC_CACHE_MEDIA);
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

async function handleAdminQuestions(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const authFailure = await requireAdminAccess(context);
    if (authFailure) return authFailure;
    const fields = "id,category,question,optionA,optionB,optionC,optionD,answer";
    const [examRows, peOnlineRows] = await Promise.all([
        supabaseServerRequest(context.env, `Exam?select=${fields}&order=id.asc`),
        supabaseServerRequest(context.env, `PEOnlineExam?select=${fields}&order=id.asc`)
    ]);
    return json({ exam: examRows || [], peOnline: peOnlineRows || [] });
}

async function handleAdminQuestionMedia(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const authFailure = await requireAdminAccess(context);
    if (authFailure) return authFailure;
    const url = new URL(context.request.url);
    const table = String(url.searchParams.get("table") || "");
    const id = String(url.searchParams.get("id") || "").trim();
    if (!["Exam", "PEOnlineExam"].includes(table)) {
        return apiError(400, "invalid_table", "Question table must be Exam or PEOnlineExam.");
    }
    if (!/^\d{1,12}$/.test(id)) {
        return apiError(400, "invalid_id", "Question ID is invalid.");
    }
    const rows = await supabaseServerRequest(
        context.env,
        `${table}?select=id,image,audio&id=eq.${encodeURIComponent(id)}&limit=1`
    );
    return json(rows || []);
}

function normalizeOption(value) {
    const text = String(value || "").normalize("NFKC").trim();
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
    return { peType: parts[1] || "Mock", topic: parts[2] || "General" };
}

function calculatePEOnlineTotal(counts) {
    const di = Math.min(Number(counts["Data Interpretation"] || 0), 20);
    const currentAffairs = Math.min(Number(counts["Current Affairs"] || 0), 20);
    return Math.min(100, di + currentAffairs + Number(counts.Mock || 0) + Number(counts["Past Paper"] || 0));
}

function parseAnswerIndex(value) {
    const normalized = String(value || "").trim().toUpperCase();
    if (["A", "B", "C", "D"].includes(normalized)) return normalized.charCodeAt(0) - 65;
    const numeric = Number.parseInt(normalized, 10);
    if (numeric >= 1 && numeric <= 4) return numeric - 1;
    if (numeric >= 0 && numeric <= 3) return numeric;
    return -1;
}

function publicQuestionText(raw) {
    return String(raw || "").split("\n§§EXPLAIN§§\n", 1)[0];
}

let examSessionSchemaReady = false;
let adminOtpSchemaReady = false;

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

async function ensureAdminOtpSchema(db) {
    if (adminOtpSchemaReady) return;
    await db.prepare(`
        create table if not exists admin_otp_requests (
            request_id text primary key,
            session_id text not null,
            code_hash text not null,
            access_token text not null,
            refresh_token text,
            attempts integer not null default 0,
            expires_at integer not null,
            used_at integer
        )
    `).run();
    await db.prepare(`
        create index if not exists admin_otp_expiry_idx
        on admin_otp_requests (expires_at)
    `).run();
    adminOtpSchemaReady = true;
}

async function sha256Hex(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function generateOtpCode() {
    return String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
}

function maskEmailAddress(email) {
    const [localPart, domain = ""] = String(email || "").split("@");
    if (!localPart || !domain) return "your email";
    const localMasked = localPart.length <= 2
        ? `${localPart[0] || "*"}*`
        : `${localPart.slice(0, 2)}${"*".repeat(Math.max(localPart.length - 2, 1))}`;
    return `${localMasked}@${domain}`;
}

async function purgeExpiredAdminOtps(db) {
    const cutoff = Date.now();
    await db.prepare("delete from admin_otp_requests where expires_at < ?1 or used_at is not null")
        .bind(cutoff)
        .run()
        .catch(() => {});
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

async function authenticateAdminPassword(context, password) {
    if (!context.env.SUPABASE_URL || !context.env.ADMIN_EMAIL || !context.env.SUPABASE_PUBLISHABLE_KEY) {
        throw new Error("security_not_configured");
    }
    const response = await fetch(`${context.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
            apikey: context.env.SUPABASE_PUBLISHABLE_KEY,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            email: context.env.ADMIN_EMAIL,
            password
        })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.access_token) {
        return null;
    }
    return result;
}

async function requireAdminAccess(context) {
    const authorization = context.request.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ")) {
        return apiError(401, "missing_admin_token", "Admin authentication is required.");
    }
    if (!context.env.SUPABASE_URL || !context.env.SUPABASE_PUBLISHABLE_KEY || !context.env.ADMIN_EMAIL) {
        return apiError(503, "security_not_configured", "Admin security is not configured yet.");
    }
    const response = await fetch(`${context.env.SUPABASE_URL}/auth/v1/user`, {
        headers: {
            apikey: context.env.SUPABASE_PUBLISHABLE_KEY,
            Authorization: authorization
        }
    });
    const result = await response.json().catch(() => ({}));
    const email = String(result?.email || "");
    if (!response.ok || !email) {
        return apiError(401, "invalid_admin_token", "Admin session is invalid or expired.");
    }
    if (email.toLowerCase() !== String(context.env.ADMIN_EMAIL || "").toLowerCase()) {
        return apiError(403, "admin_forbidden", "This account is not allowed to perform admin changes.");
    }
    return null;
}

function encodeQuestionWithExplanation(questionText, explanation) {
    const cleanExplanation = String(explanation || "").trim();
    if (!cleanExplanation) return questionText;
    return `${questionText}\n§§EXPLAIN§§\n${cleanExplanation}`;
}

function toSupabaseQuestionPayload(question) {
    return {
        category: question.category,
        question: encodeQuestionWithExplanation(question.question, question.explanation),
        optionA: question.options[0],
        optionB: question.options[1],
        optionC: question.options[2],
        optionD: question.options[3],
        answer: ["A", "B", "C", "D"][question.answer] || "A",
        image: question.imageCode || "",
        audio: question.audioCode || ""
    };
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

async function storeExamSession(db, gradingItems) {
    await ensureExamSessionSchema(db);
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    await db.prepare(
        "insert into exam_sessions (session_id, payload, expires_at, used_at) values (?1, ?2, ?3, null)"
    ).bind(sessionId, JSON.stringify(gradingItems), now + 3 * HOUR).run();
    return sessionId;
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
    const mockPool = shuffled(byType("Mock"));
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
    const mockTarget = Math.ceil(remaining / 2);
    const pastTarget = remaining - mockTarget;
    let mock = mockPool.slice(0, mockTarget);
    let past = pastPool.slice(0, pastTarget);
    if (mock.length < mockTarget) past = past.concat(pastPool.slice(past.length, past.length + mockTarget - mock.length));
    if (past.length < pastTarget) mock = mock.concat(mockPool.slice(mock.length, mock.length + pastTarget - past.length));
    return [...shuffled([...mock, ...past, ...currentAffairs]), ...dataInterpretation];
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
    const rows = await supabaseServerRequest(
        context.env,
        `Exam?select=${fields}&category=eq.${encodeURIComponent(category)}&order=id.asc`
    );
    const prepared = buildSecureQuestions(shuffled(rows || []));
    if (!prepared.length) return apiError(404, "no_questions", "No valid questions were found in this category.");
    const publicQuestions = prepared.map(item => item.publicQuestion);
    const sessionId = await storeRichExamSession(context.env.RATE_LIMIT_DB, {
        version: 2,
        publicQuestions,
        gradingItems: prepared.map(item => item.gradingItem)
    });
    const initialWindow = buildQuestionWindow(publicQuestions, 0, 2);
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
        questions: buildQuestionWindow(normalized.publicQuestions, index, 2)
    }, 200);
}

async function handlePEOnlineStart(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    validateEmptyPayload(await readJson(context.request, 1024), "PE Online start request");
    const fields = "id,category,question,optionA,optionB,optionC,optionD,answer";
    const rows = await supabaseServerRequest(context.env, `PEOnlineExam?select=${fields}&order=id.asc`);
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
        questions: buildQuestionWindow(publicQuestions, 0, 2)
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
        questions: buildQuestionWindow(normalized.publicQuestions, index, 2)
    }, 200);
}

async function handleQuotes(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const now = encodeURIComponent(new Date().toISOString());
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
        return { status, correctIndex: item.correctIndex };
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
    await supabaseServerRequest(context.env, "Response", {
        method: "POST",
        body: payload,
        prefer: "return=minimal"
    });
    return json({
        ok: true,
        result: {
            correct,
            wrong,
            skipped,
            total: items.length,
            grading,
            public_questions: normalized.publicQuestions
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

async function handleAdminOtpRequest(context, sessionId) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    if (!context.env.RESEND_API_KEY || !context.env.ADMIN_EMAIL || !context.env.ADMIN_OTP_EMAIL) {
        return apiError(503, "security_not_configured", "Admin email verification is not configured yet.");
    }
    const { password } = validateAdminOtpRequestPayload(await readJson(context.request, 4096));
    const authData = await authenticateAdminPassword(context, password);
    if (!authData) {
        return apiError(401, "invalid_credentials", "Admin password is incorrect.");
    }

    await ensureAdminOtpSchema(context.env.RATE_LIMIT_DB);
    const requestId = crypto.randomUUID();
    const code = generateOtpCode();
    const now = Date.now();
    const expiresAt = now + 5 * MINUTE;
    const codeHash = await sha256Hex(`${context.env.RATE_LIMIT_SALT}:admin-otp:${requestId}:${code}`);
    await context.env.RATE_LIMIT_DB.prepare("delete from admin_otp_requests where session_id = ?1")
        .bind(sessionId)
        .run();
    await context.env.RATE_LIMIT_DB.prepare(`
        insert into admin_otp_requests (
            request_id, session_id, code_hash, access_token, refresh_token, attempts, expires_at, used_at
        ) values (?1, ?2, ?3, ?4, ?5, 0, ?6, null)
    `).bind(
        requestId,
        sessionId,
        codeHash,
        String(authData.access_token || ""),
        String(authData.refresh_token || ""),
        expiresAt
    ).run();

    const maskedEmail = maskEmailAddress(context.env.ADMIN_OTP_EMAIL);
    const message = [
        "Your ExamPortal admin verification code is:",
        "",
        code,
        "",
        "This code expires in 5 minutes.",
        "If you did not request this, please ignore this email."
    ].join("\n");
    try {
        await sendTransactionalEmail(context, {
            from: "ExamPortal <onboarding@resend.dev>",
            to: [context.env.ADMIN_OTP_EMAIL],
            subject: "ExamPortal admin verification code",
            text: message
        });
    } catch (error) {
        await context.env.RATE_LIMIT_DB.prepare("delete from admin_otp_requests where request_id = ?1")
            .bind(requestId)
            .run()
            .catch(() => {});
        return apiError(502, "otp_delivery_failed", "Verification code could not be sent. Please try again.");
    }

    if (Math.random() < 0.2) context.waitUntil(purgeExpiredAdminOtps(context.env.RATE_LIMIT_DB));

    return json({
        ok: true,
        request_id: requestId,
        destination: maskedEmail,
        expires_in_seconds: 300
    }, 201);
}

async function handleAdminOtpVerify(context, sessionId) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    if (!context.env.RATE_LIMIT_SALT) {
        return apiError(503, "security_not_configured", "Admin email verification is not configured yet.");
    }
    const { request_id: requestId, code } = validateAdminOtpVerifyPayload(await readJson(context.request, 4096));
    await ensureAdminOtpSchema(context.env.RATE_LIMIT_DB);
    const now = Date.now();
    const row = await context.env.RATE_LIMIT_DB.prepare(`
        select request_id, session_id, code_hash, access_token, refresh_token, attempts, expires_at, used_at
        from admin_otp_requests
        where request_id = ?1
        limit 1
    `).bind(requestId).first();
    if (!row || row.session_id !== sessionId || row.used_at || Number(row.expires_at) < now) {
        return apiError(401, "invalid_or_expired_code", "Verification code is invalid or expired.");
    }
    if (Number(row.attempts || 0) >= 5) {
        await context.env.RATE_LIMIT_DB.prepare("delete from admin_otp_requests where request_id = ?1")
            .bind(requestId)
            .run();
        return apiError(429, "too_many_attempts", "Too many incorrect codes. Request a new code.");
    }
    const codeHash = await sha256Hex(`${context.env.RATE_LIMIT_SALT}:admin-otp:${requestId}:${code}`);
    if (codeHash !== row.code_hash) {
        await context.env.RATE_LIMIT_DB.prepare("update admin_otp_requests set attempts = attempts + 1 where request_id = ?1")
            .bind(requestId)
            .run();
        return apiError(401, "invalid_or_expired_code", "Verification code is invalid or expired.");
    }
    await context.env.RATE_LIMIT_DB.prepare("update admin_otp_requests set used_at = ?2 where request_id = ?1")
        .bind(requestId, now)
        .run();
    if (Math.random() < 0.2) context.waitUntil(purgeExpiredAdminOtps(context.env.RATE_LIMIT_DB));
    return json({
        ok: true,
        access_token: String(row.access_token || ""),
        refresh_token: String(row.refresh_token || "")
    }, 201);
}

async function handleAdminQuestion(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    const authFailure = await requireAdminAccess(context);
    if (authFailure) return authFailure;
    const payload = validateAdminQuestionPayload(await readJson(context.request, 10 * 1024 * 1024));
    const path = payload.id
        ? `${payload.table}?id=eq.${encodeURIComponent(payload.id)}`
        : payload.table;
    await supabaseServerRequest(context.env, path, {
        method: payload.id ? "PATCH" : "POST",
        body: toSupabaseQuestionPayload(payload),
        prefer: "return=minimal"
    });
    return json({ ok: true }, payload.id ? 200 : 201);
}

async function handleAdminBulkQuestions(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    const authFailure = await requireAdminAccess(context);
    if (authFailure) return authFailure;
    const payload = validateAdminBulkQuestionsPayload(await readJson(context.request, 10 * 1024 * 1024));
    await supabaseServerRequest(context.env, payload.table, {
        method: "POST",
        body: payload.questions.map(toSupabaseQuestionPayload),
        prefer: "return=minimal"
    });
    return json({ ok: true, count: payload.questions.length }, 201);
}

async function handleAdminFlashcard(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    const authFailure = await requireAdminAccess(context);
    if (authFailure) return authFailure;
    const payload = validateAdminFlashcardPayload(await readJson(context.request, 16384));
    const path = payload.id
        ? `${"CurrentAffairFlashcards"}?id=eq.${encodeURIComponent(payload.id)}`
        : "CurrentAffairFlashcards";
    await supabaseServerRequest(context.env, path, {
        method: payload.id ? "PATCH" : "POST",
        body: {
            scope: payload.scope,
            category: payload.category,
            date_stamp: payload.date_stamp,
            exam_focus: payload.exam_focus,
            answer: payload.answer
        },
        prefer: "return=minimal"
    });
    return json({ ok: true }, payload.id ? 200 : 201);
}

async function handleAdminQuote(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    const authFailure = await requireAdminAccess(context);
    if (authFailure) return authFailure;
    const payload = validateAdminQuotePayload(await readJson(context.request, 16384));
    const path = payload.id
        ? `${"daily_quotes"}?id=eq.${encodeURIComponent(payload.id)}`
        : "daily_quotes";
    await supabaseServerRequest(context.env, path, {
        method: payload.id ? "PATCH" : "POST",
        body: {
            english_quote: payload.english_quote,
            dzongkha_quote: payload.dzongkha_quote,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        },
        prefer: "return=minimal"
    });
    return json({ ok: true }, payload.id ? 200 : 201);
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
        else if (name === "admin-otp-request") response = await handleAdminOtpRequest(context, session.id);
        else if (name === "admin-otp-verify") response = await handleAdminOtpVerify(context, session.id);
        else if (name === "admin-questions") response = await handleAdminQuestions(context);
        else if (name === "admin-question-media") response = await handleAdminQuestionMedia(context);
        else if (name === "admin-question") response = await handleAdminQuestion(context);
        else if (name === "admin-bulk-questions") response = await handleAdminBulkQuestions(context);
        else if (name === "admin-flashcard") response = await handleAdminFlashcard(context);
        else if (name === "admin-quote") response = await handleAdminQuote(context);
        else response = apiError(404, "not_found", "API endpoint not found.");
        return withSessionCookie(response, session.id, session.isNew);
    } catch (error) {
        return withSessionCookie(handleError(error), session.id, session.isNew);
    }
}
