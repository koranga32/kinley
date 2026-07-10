import { apiError, handleError, json, methodNotAllowed, readJson, validationError, withSessionCookie } from "../_shared/http.js";
import { enforceRateLimits, getSession, rejectCrossSiteRequest } from "../_shared/security.js";
import { supabaseServerRequest, supabaseStorageUpload } from "../_shared/supabase.js";
import {
    validateAdminBulkQuestionsPayload,
    validateAdminFlashcardPayload,
    validateAdminOtpRequestPayload,
    validateAdminOtpVerifyPayload,
    validateAdminPasswordRecoveryPayload,
    validateAdminProfilePayload,
    validateAdminQuestionPayload,
    validateAdminPEResourcePayload,
    validateAdminQuotePayload,
    validateAdminRolePayload,
    validateAdminRoleDeletePayload,
    validateContactPayload,
    validateEmptyPayload,
    validateExamStartPayload,
    validateGradedResponsePayload,
    validateMediaIds
} from "../_shared/validation.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const QUESTION_WINDOW_SIZE = 5;
const PUBLIC_CACHE_SHORT = {
    "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=120"
};
const PUBLIC_CACHE_MEDIA = {
    "Cache-Control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=600"
};
const MEDIA_BUCKET = "exam-media";
const ADMIN_SESSION_COOKIE = "ep_admin_session";
const ADMIN_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const ADMIN_SESSION_MAX_AGE_MS = ADMIN_SESSION_MAX_AGE_SECONDS * 1000;
const MEDIA_MIME_TYPES = new Set([
    "image/jpeg", "image/png", "image/webp",
    "audio/mpeg", "audio/mp4", "audio/wav", "application/pdf"
]);

const POLICIES = {
    health: { windowMs: MINUTE, ipLimit: 30, sessionLimit: 30 },
    "admin-otp-request": { windowMs: 10 * MINUTE, ipLimit: 8, sessionLimit: 5 },
    "admin-otp-verify": { windowMs: 10 * MINUTE, ipLimit: 15, sessionLimit: 10 },
    "admin-session-refresh": { windowMs: 10 * MINUTE, ipLimit: 30, sessionLimit: 30 },
    "admin-logout": { windowMs: 10 * MINUTE, ipLimit: 30, sessionLimit: 30 },
    "admin-password-recovery": { windowMs: 10 * MINUTE, ipLimit: 10, sessionLimit: 10 },
    "admin-questions": { windowMs: MINUTE, ipLimit: 60, sessionLimit: 60 },
    "admin-flashcards": { windowMs: MINUTE, ipLimit: 60, sessionLimit: 60 },
    "admin-quotes": { windowMs: MINUTE, ipLimit: 60, sessionLimit: 60 },
    "admin-pe-resources": { windowMs: MINUTE, ipLimit: 60, sessionLimit: 60 },
    "admin-question-media": { windowMs: MINUTE, ipLimit: 90, sessionLimit: 90 },
    "admin-question": { windowMs: 10 * MINUTE, ipLimit: 60, sessionLimit: 60 },
    "admin-bulk-questions": { windowMs: 10 * MINUTE, ipLimit: 20, sessionLimit: 20 },
    "admin-flashcard": { windowMs: 10 * MINUTE, ipLimit: 40, sessionLimit: 40 },
    "admin-quote": { windowMs: 10 * MINUTE, ipLimit: 40, sessionLimit: 40 },
    "admin-profile": { windowMs: MINUTE, ipLimit: 60, sessionLimit: 60 },
    "admin-roles": { windowMs: 10 * MINUTE, ipLimit: 30, sessionLimit: 30 }
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
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    const payload = await readJson(context.request, 1024);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || Object.keys(payload).some(key => !["id", "selected_index"].includes(key))) {
        return apiError(400, "invalid_check", "Question check contains unexpected fields.");
    }
    const id = String(payload.id || "").trim();
    const selectedIndex = Number(payload.selected_index);
    if (!/^\d{1,12}$/.test(id)) return apiError(400, "invalid_id", "Question ID is invalid.");
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex > 3) {
        return apiError(400, "invalid_selection", "Selected answer must be 0, 1, 2, or 3.");
    }
    const rows = await supabaseServerRequest(
        context.env,
        `Exam?select=id,category,question,answer&id=eq.${id}&limit=1`
    );
    if (!rows?.length) return apiError(404, "not_found", "Question was not found.");
    if (!String(rows[0].category || "").startsWith("__PE__::")) {
        return apiError(403, "solution_unavailable", "Solutions are available only in PE practice.");
    }
    return json({
        id: String(rows[0].id),
        correct: selectedIndex === parseAnswerIndex(rows[0].answer)
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
    const authFailure = await requireAdminAccess(context, "flashcards_view");
    if (authFailure) return authFailure;
    const fields = "id,scope,category,date_stamp,exam_focus,created_at";
    return json(await supabaseServerRequest(
        context.env,
        `CurrentAffairFlashcards?select=${fields}&order=created_at.desc`
    ), 200, PUBLIC_CACHE_SHORT);
}

async function handleAdminQuestions(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const authFailure = await requireAdminAccess(context, "questions_view");
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
    const authFailure = await requireAdminAccess(context, "questions_view");
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

function publicQuestionText(raw) {
    return String(raw || "").split("\n§§EXPLAIN§§\n", 1)[0];
}

let examSessionSchemaReady = false;
let adminOtpSchemaReady = false;
let adminSessionSchemaReady = false;
let adminRolesSchemaReady = false;
let adminProfileSchemaReady = false;

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

async function ensureAdminSessionSchema(db) {
    if (adminSessionSchemaReady) return;
    await db.prepare(`
        create table if not exists admin_sessions (
            session_hash text primary key,
            email text not null,
            access_token text not null,
            refresh_token text,
            expires_at integer not null,
            created_at integer not null,
            updated_at integer not null
        )
    `).run();
    await db.prepare(`
        create index if not exists admin_sessions_expiry_idx
        on admin_sessions (expires_at)
    `).run();
    adminSessionSchemaReady = true;
}

async function ensureAdminRolesSchema(db) {
    if (adminRolesSchemaReady) return;
    await db.prepare(`
        create table if not exists admin_roles (
            email text primary key,
            can_questions_view integer not null default 0,
            can_questions_create integer not null default 0,
            can_questions_edit integer not null default 0,
            can_questions_bulk integer not null default 0,
            can_flashcards_view integer not null default 0,
            can_flashcards_create integer not null default 0,
            can_flashcards_edit integer not null default 0,
            can_quotes_view integer not null default 0,
            can_quotes_create integer not null default 0,
            can_quotes_edit integer not null default 0,
            active integer not null default 1,
            created_at integer not null,
            updated_at integer not null
        )
    `).run();
    const migrationStatements = [
        "alter table admin_roles add column can_questions_view integer not null default 0",
        "alter table admin_roles add column can_questions_create integer not null default 0",
        "alter table admin_roles add column can_questions_edit integer not null default 0",
        "alter table admin_roles add column can_questions_bulk integer not null default 0",
        "alter table admin_roles add column can_flashcards_view integer not null default 0",
        "alter table admin_roles add column can_flashcards_create integer not null default 0",
        "alter table admin_roles add column can_flashcards_edit integer not null default 0",
        "alter table admin_roles add column can_quotes_view integer not null default 0",
        "alter table admin_roles add column can_quotes_create integer not null default 0",
        "alter table admin_roles add column can_quotes_edit integer not null default 0"
    ];
    for (const statement of migrationStatements) {
        await db.prepare(statement).run().catch(() => {});
    }
    await db.prepare(`
        create index if not exists admin_roles_active_idx
        on admin_roles (active)
    `).run();
    adminRolesSchemaReady = true;
}

async function ensureAdminProfileSchema(db) {
    if (adminProfileSchemaReady) return;
    await db.prepare(`
        create table if not exists admin_profiles (
            email text primary key,
            display_name text not null,
            contact_email text not null default '',
            phone text not null default '',
            avatar_url text not null default '',
            updated_at integer not null
        )
    `).run();
    adminProfileSchemaReady = true;
}

async function sha256Hex(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function parseCookieHeader(request) {
    const output = {};
    for (const part of (request.headers.get("cookie") || "").split(";")) {
        const index = part.indexOf("=");
        if (index > 0) output[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return output;
}

function getAdminSessionId(request) {
    const value = parseCookieHeader(request)[ADMIN_SESSION_COOKIE] || "";
    return /^[a-f0-9-]{36}$/i.test(value) ? value : "";
}

async function adminSessionHash(context, sessionId) {
    return sha256Hex(`${context.env.RATE_LIMIT_SALT}:admin-session:${sessionId}`);
}

function withAdminSessionCookie(response, sessionId, maxAgeSeconds = ADMIN_SESSION_MAX_AGE_SECONDS) {
    const next = new Response(response.body, response);
    next.headers.append(
        "Set-Cookie",
        `${ADMIN_SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`
    );
    return next;
}

function withClearedAdminSessionCookie(response) {
    const next = new Response(response.body, response);
    next.headers.append(
        "Set-Cookie",
        `${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
    );
    return next;
}

async function purgeExpiredAdminSessions(db) {
    await db.prepare("delete from admin_sessions where expires_at < ?1")
        .bind(Date.now())
        .run()
        .catch(() => {});
}

function generateOtpCode() {
    const range = 1000000;
    const ceiling = 0x100000000 - (0x100000000 % range);
    const values = new Uint32Array(1);
    do {
        crypto.getRandomValues(values);
    } while (values[0] >= ceiling);
    return String(values[0] % range).padStart(6, "0");
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

function transactionalSender(env) {
    return String(env.RESEND_FROM_EMAIL || env.ADMIN_OTP_FROM_EMAIL || "ExamPortal <onboarding@resend.dev>").trim();
}

async function getAdminPrincipalByEmail(context, rawEmail) {
    const email = String(rawEmail || "").trim().toLowerCase();
    const superEmail = String(context.env.ADMIN_EMAIL || "").trim().toLowerCase();
    if (!email) return null;
    if (email === superEmail) {
        return {
            email,
            is_super_admin: true,
            permissions: {
                questions: true,
                questions_view: true,
                questions_create: true,
                questions_edit: true,
                questions_bulk: true,
                flashcards: true,
                flashcards_view: true,
                flashcards_create: true,
                flashcards_edit: true,
                quotes: true,
                quotes_view: true,
                quotes_create: true,
                quotes_edit: true,
                roles: true
            }
        };
    }
    if (!context.env.RATE_LIMIT_DB) return null;
    await ensureAdminRolesSchema(context.env.RATE_LIMIT_DB);
    const row = await context.env.RATE_LIMIT_DB.prepare(`
        select email,
            can_questions_view,
            can_questions_create,
            can_questions_edit,
            can_questions_bulk,
            can_flashcards_view,
            can_flashcards_create,
            can_flashcards_edit,
            can_quotes_view,
            can_quotes_create,
            can_quotes_edit,
            active
        from admin_roles where email = ?1 limit 1
    `).bind(email).first();
    if (!row || Number(row.active) !== 1) return null;
    const questions_view = Number(row.can_questions_view) === 1;
    const questions_create = Number(row.can_questions_create) === 1;
    const questions_edit = Number(row.can_questions_edit) === 1;
    const questions_bulk = Number(row.can_questions_bulk) === 1;
    const flashcards_view = Number(row.can_flashcards_view) === 1;
    const flashcards_create = Number(row.can_flashcards_create) === 1;
    const flashcards_edit = Number(row.can_flashcards_edit) === 1;
    const quotes_view = Number(row.can_quotes_view) === 1;
    const quotes_create = Number(row.can_quotes_create) === 1;
    const quotes_edit = Number(row.can_quotes_edit) === 1;
    return {
        email,
        is_super_admin: false,
        permissions: {
            questions: questions_view || questions_create || questions_edit || questions_bulk,
            questions_view,
            questions_create,
            questions_edit,
            questions_bulk,
            flashcards: flashcards_view || flashcards_create || flashcards_edit,
            flashcards_view,
            flashcards_create,
            flashcards_edit,
            quotes: quotes_view || quotes_create || quotes_edit,
            quotes_view,
            quotes_create,
            quotes_edit,
            roles: false
        }
    };
}

async function authenticateAdminPassword(context, email, password) {
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
            email,
            password
        })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.access_token) {
        return null;
    }
    return result;
}

async function createDelegatedAdminAuthUser(context, email, password) {
    if (!context.env.SUPABASE_URL || !context.env.SUPABASE_SECRET_KEY) {
        throw new Error("security_not_configured");
    }
    const response = await fetch(`${context.env.SUPABASE_URL}/auth/v1/admin/users`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            apikey: context.env.SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${context.env.SUPABASE_SECRET_KEY}`
        },
        body: JSON.stringify({
            email,
            password,
            email_confirm: true
        })
    });
    if (response.ok) return true;
    const result = await response.json().catch(() => ({}));
    const message = String(result?.msg || result?.message || result?.error_description || result?.error || "");
    if (/already|exists|registered/i.test(message)) {
        throw validationError("delegated_admin_exists", "This delegated admin email already exists. Leave password blank if you are only updating role permissions.", 409);
    }
    console.error("Supabase delegated admin create failure", response.status, message || "Unknown error");
    throw validationError("delegated_admin_create_failed", "Could not create delegated admin login.", 502);
}

async function fetchSupabaseUserByAccessToken(context, accessToken) {
    const response = await fetch(`${context.env.SUPABASE_URL}/auth/v1/user`, {
        headers: {
            apikey: context.env.SUPABASE_PUBLISHABLE_KEY,
            Authorization: `Bearer ${accessToken}`
        }
    });
    const result = await response.json().catch(() => ({}));
    const email = String(result?.email || "").toLowerCase();
    return { ok: response.ok && Boolean(email), email };
}

async function refreshSupabaseAdminSession(context, refreshToken) {
    if (!refreshToken) return null;
    const response = await fetch(`${context.env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: {
            apikey: context.env.SUPABASE_PUBLISHABLE_KEY,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ refresh_token: refreshToken })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.access_token || !result.refresh_token) return null;
    return {
        accessToken: String(result.access_token),
        refreshToken: String(result.refresh_token)
    };
}

async function resolveAdminSession(context) {
    if (!context.env.SUPABASE_URL || !context.env.SUPABASE_PUBLISHABLE_KEY || !context.env.ADMIN_EMAIL) {
        return { failure: apiError(503, "security_not_configured", "Admin security is not configured yet.") };
    }
    const sessionId = getAdminSessionId(context.request);
    if (!sessionId) {
        return { failure: apiError(401, "missing_admin_session", "Admin authentication is required.") };
    }
    await ensureAdminSessionSchema(context.env.RATE_LIMIT_DB);
    const sessionHash = await adminSessionHash(context, sessionId);
    const row = await context.env.RATE_LIMIT_DB.prepare(`
        select session_hash, email, access_token, refresh_token, expires_at
        from admin_sessions
        where session_hash = ?1
        limit 1
    `).bind(sessionHash).first();
    const now = Date.now();
    if (!row || Number(row.expires_at || 0) < now) {
        if (row) {
            await context.env.RATE_LIMIT_DB.prepare("delete from admin_sessions where session_hash = ?1")
                .bind(sessionHash)
                .run()
                .catch(() => {});
        }
        return { failure: withClearedAdminSessionCookie(apiError(401, "invalid_admin_session", "Admin session is invalid or expired.")) };
    }

    let accessToken = String(row.access_token || "");
    let refreshToken = String(row.refresh_token || "");
    let user = await fetchSupabaseUserByAccessToken(context, accessToken);
    if (!user.ok) {
        const refreshed = await refreshSupabaseAdminSession(context, refreshToken);
        if (!refreshed) {
            await context.env.RATE_LIMIT_DB.prepare("delete from admin_sessions where session_hash = ?1")
                .bind(sessionHash)
                .run()
                .catch(() => {});
            return { failure: withClearedAdminSessionCookie(apiError(401, "invalid_admin_session", "Admin session is invalid or expired.")) };
        }
        accessToken = refreshed.accessToken;
        refreshToken = refreshed.refreshToken;
        user = await fetchSupabaseUserByAccessToken(context, accessToken);
        if (!user.ok) {
            await context.env.RATE_LIMIT_DB.prepare("delete from admin_sessions where session_hash = ?1")
                .bind(sessionHash)
                .run()
                .catch(() => {});
            return { failure: withClearedAdminSessionCookie(apiError(401, "invalid_admin_session", "Admin session is invalid or expired.")) };
        }
        await context.env.RATE_LIMIT_DB.prepare(`
            update admin_sessions
            set access_token = ?2, refresh_token = ?3, updated_at = ?4
            where session_hash = ?1
        `).bind(sessionHash, accessToken, refreshToken, now).run();
    }
    const principal = await getAdminPrincipalByEmail(context, user.email);
    if (!principal) {
        return { failure: apiError(403, "admin_forbidden", "This account is not allowed to perform admin changes.") };
    }
    return { sessionId, sessionHash, principal };
}

async function requireAdminAccess(context, permission = "") {
    const resolved = await resolveAdminSession(context);
    if (resolved.failure) return resolved.failure;
    const principal = resolved.principal;
    if (!principal) {
        return apiError(403, "admin_forbidden", "This account is not allowed to perform admin changes.");
    }
    if (permission && !principal.permissions[permission]) {
        return apiError(403, "permission_denied", "Your admin role does not permit this action.");
    }
    context.data = context.data || {};
    context.data.adminPrincipal = principal;
    context.data.adminSessionId = resolved.sessionId;
    context.data.adminSessionHash = resolved.sessionHash;
    return null;
}

function adminHasCapability(principal, permission = "") {
    if (!permission) return true;
    return Boolean(principal?.permissions?.[permission]);
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

function trustedStoragePrefix(env) {
    return `${String(env.SUPABASE_URL || "").replace(/\/$/, "")}/storage/v1/object/public/${MEDIA_BUCKET}/`;
}

function decodeMediaDataUrl(dataUrl, expectedType) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
    if (!match || !match[1].toLowerCase().startsWith(`${expectedType}/`)) {
        throw validationError("invalid_media", `A valid base64 ${expectedType} file is required.`);
    }
    const contentType = match[1].toLowerCase();
    if (!MEDIA_MIME_TYPES.has(contentType)) {
        throw validationError("unsupported_media_type", `The ${expectedType} file type is not supported.`);
    }
    let binary;
    try {
        binary = atob(match[2]);
    } catch {
        throw validationError("invalid_media", `The ${expectedType} file is invalid.`);
    }
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (!bytes.length || bytes.length > 6 * 1024 * 1024) {
        throw validationError("invalid_media_size", `The ${expectedType} file must be no larger than 6 MB.`);
    }
    return { bytes, contentType };
}

function mediaExtension(contentType) {
    return ({
        "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
        "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "application/pdf": "pdf"
    })[contentType];
}

async function storeQuestionMedia(env, value, expectedType, table, category) {
    if (!value) return "";
    if (/^https:\/\//i.test(value)) {
        if (!value.startsWith(trustedStoragePrefix(env))) {
            throw validationError("untrusted_media_url", "Only media from this project's exam-media bucket is allowed.");
        }
        return value;
    }
    const { bytes, contentType } = decodeMediaDataUrl(value, expectedType);
    const section = table === "PEOnlineExam"
        ? "pe-online"
        : String(category || "").startsWith("__PE__::")
            ? "pe-practice"
            : "normal-exam";
    const objectPath = `${section}/${expectedType}/${crypto.randomUUID()}.${mediaExtension(contentType)}`;
    return supabaseStorageUpload(env, MEDIA_BUCKET, objectPath, bytes, contentType);
}

async function prepareQuestionMedia(env, question) {
    const [imageCode, audioCode] = await Promise.all([
        storeQuestionMedia(env, question.imageCode, "image", question.table, question.category),
        storeQuestionMedia(env, question.audioCode, "audio", question.table, question.category)
    ]);
    return { ...question, imageCode, audioCode };
}

async function storePEResourceDocument(env, value) {
    if (!value) return "";
    if (/^https:\/\//i.test(value)) {
        if (!value.startsWith(trustedStoragePrefix(env))) {
            throw validationError("untrusted_document_url", "Only documents from this project's exam-media bucket are allowed.");
        }
        return value;
    }
    if (/^data:application\/pdf;base64,/i.test(value)) {
        const { bytes, contentType } = decodeMediaDataUrl(value, "application");
        if (contentType !== "application/pdf") throw validationError("unsupported_document_type", "Only PDF documents are supported.");
        return supabaseStorageUpload(env, MEDIA_BUCKET, `pe-resources/document/${crypto.randomUUID()}.pdf`, bytes, contentType);
    }
    const { bytes, contentType } = decodeMediaDataUrl(value, "image");
    return supabaseStorageUpload(
        env,
        MEDIA_BUCKET,
        `pe-resources/document/${crypto.randomUUID()}.${mediaExtension(contentType)}`,
        bytes,
        contentType
    );
}

async function preparePEResourceMedia(env, resource) {
    const [documentUrl, previewUrl] = await Promise.all([
        storePEResourceDocument(env, resource.document_url),
        storeQuestionMedia(env, resource.preview_url, "image", "Exam", "__PE__::resources")
    ]);
    return { ...resource, document_url: documentUrl, preview_url: previewUrl };
}

async function storeAdminProfileAvatar(env, value) {
    if (!value) return "";
    if (/^https:\/\//i.test(value)) {
        if (!value.startsWith(trustedStoragePrefix(env))) {
            throw validationError("untrusted_profile_image", "Only profile images from this project's exam-media bucket are allowed.");
        }
        return value;
    }
    const { bytes, contentType } = decodeMediaDataUrl(value, "image");
    if (bytes.length > 2 * 1024 * 1024) {
        throw validationError("profile_image_too_large", "Profile image must be no larger than 2 MB.");
    }
    return supabaseStorageUpload(
        env,
        MEDIA_BUCKET,
        `admin-profiles/avatar/${crypto.randomUUID()}.${mediaExtension(contentType)}`,
        bytes,
        contentType
    );
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
    const authFailure = await requireAdminAccess(context, "quotes_view");
    if (authFailure) return authFailure;
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
        from: transactionalSender(context.env),
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
    const { email, password } = validateAdminOtpRequestPayload(await readJson(context.request, 4096));
    const authData = await authenticateAdminPassword(context, email, password);
    if (!authData) {
        return apiError(401, "invalid_credentials", "Admin email or password is incorrect.");
    }
    const principal = await getAdminPrincipalByEmail(context, email);
    if (!principal) {
        return apiError(403, "admin_forbidden", "This account does not have an active admin role.");
    }
    if (!principal.is_super_admin && !context.env.RESEND_FROM_EMAIL && !context.env.ADMIN_OTP_FROM_EMAIL) {
        return apiError(
            503,
            "otp_sender_not_configured",
            "Delegated verification requires a verified Resend sender configured in RESEND_FROM_EMAIL."
        );
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

    const otpDestination = principal.is_super_admin ? context.env.ADMIN_OTP_EMAIL : principal.email;
    const maskedEmail = maskEmailAddress(otpDestination);
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
            from: transactionalSender(context.env),
            to: [otpDestination],
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
    if (!context.env.SUPABASE_URL || !context.env.SUPABASE_PUBLISHABLE_KEY || !context.env.ADMIN_EMAIL) {
        return apiError(503, "security_not_configured", "Admin security is not configured yet.");
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
    const user = await fetchSupabaseUserByAccessToken(context, String(row.access_token || ""));
    if (!user.ok) {
        return apiError(401, "invalid_or_expired_code", "Verification session expired. Please sign in again.");
    }
    const principal = await getAdminPrincipalByEmail(context, user.email);
    if (!principal) {
        return apiError(403, "admin_forbidden", "This account no longer has admin access.");
    }
    await ensureAdminSessionSchema(context.env.RATE_LIMIT_DB);
    const adminSessionId = crypto.randomUUID();
    const sessionHash = await adminSessionHash(context, adminSessionId);
    const expiresAt = now + ADMIN_SESSION_MAX_AGE_MS;
    await context.env.RATE_LIMIT_DB.prepare("update admin_otp_requests set used_at = ?2 where request_id = ?1")
        .bind(requestId, now)
        .run();
    await context.env.RATE_LIMIT_DB.prepare(`
        insert into admin_sessions (
            session_hash, email, access_token, refresh_token, expires_at, created_at, updated_at
        ) values (?1, ?2, ?3, ?4, ?5, ?6, ?6)
    `).bind(
        sessionHash,
        principal.email,
        String(row.access_token || ""),
        String(row.refresh_token || ""),
        expiresAt,
        now
    ).run();
    if (Math.random() < 0.2) context.waitUntil(purgeExpiredAdminOtps(context.env.RATE_LIMIT_DB));
    if (Math.random() < 0.2) context.waitUntil(purgeExpiredAdminSessions(context.env.RATE_LIMIT_DB));
    return withAdminSessionCookie(json({
        ok: true,
        principal
    }, 201), adminSessionId);
}

async function handleAdminSessionRefresh(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    validateEmptyPayload(await readJson(context.request, 1024));
    const resolved = await resolveAdminSession(context);
    if (resolved.failure) return resolved.failure;
    return withAdminSessionCookie(json({
        ok: true,
        principal: resolved.principal
    }, 200), resolved.sessionId);
}

async function handleAdminLogout(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    validateEmptyPayload(await readJson(context.request, 1024));
    const sessionId = getAdminSessionId(context.request);
    if (sessionId && context.env.RATE_LIMIT_SALT) {
        await ensureAdminSessionSchema(context.env.RATE_LIMIT_DB);
        const sessionHash = await adminSessionHash(context, sessionId);
        await context.env.RATE_LIMIT_DB.prepare("delete from admin_sessions where session_hash = ?1")
            .bind(sessionHash)
            .run()
            .catch(() => {});
    }
    return withClearedAdminSessionCookie(json({ ok: true }, 200));
}

async function handleAdminPasswordRecovery(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    if (!context.env.SUPABASE_URL || !context.env.SUPABASE_PUBLISHABLE_KEY) {
        return apiError(503, "security_not_configured", "Admin security is not configured yet.");
    }
    const payload = validateAdminPasswordRecoveryPayload(await readJson(context.request, 12288));
    const authHeaders = {
        apikey: context.env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${payload.access_token}`
    };
    const userResponse = await fetch(`${context.env.SUPABASE_URL}/auth/v1/user`, { headers: authHeaders });
    const user = await userResponse.json().catch(() => ({}));
    const email = String(user?.email || "").trim().toLowerCase();
    if (!userResponse.ok || !email) {
        return apiError(401, "invalid_recovery_token", "This recovery link is invalid or expired.");
    }
    if (!(await getAdminPrincipalByEmail(context, email))) {
        return apiError(403, "admin_forbidden", "This account does not have active admin access.");
    }
    const updateResponse = await fetch(`${context.env.SUPABASE_URL}/auth/v1/user`, {
        method: "PUT",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ password: payload.password })
    });
    if (!updateResponse.ok) {
        const result = await updateResponse.json().catch(() => ({}));
        console.error("Admin password recovery update failed", updateResponse.status, result?.message || result?.error || "Unknown error");
        return apiError(400, "password_update_failed", "Password could not be updated. Try a different password.");
    }
    return json({ ok: true }, 200);
}

async function handleAdminProfile(context) {
    const authFailure = await requireAdminAccess(context);
    if (authFailure) return authFailure;
    if (!["GET", "POST"].includes(context.request.method)) return methodNotAllowed(["GET", "POST"]);
    await ensureAdminProfileSchema(context.env.RATE_LIMIT_DB);
    const principal = context.data.adminPrincipal;
    const email = String(principal.email || "").toLowerCase();

    if (context.request.method === "GET") {
        const profile = await context.env.RATE_LIMIT_DB.prepare(`
            select display_name, contact_email, phone, avatar_url
            from admin_profiles where email = ?1 limit 1
        `).bind(email).first();
        return json({ ok: true, principal, profile: profile || null });
    }

    const payload = validateAdminProfilePayload(await readJson(context.request, 4 * 1024 * 1024));
    const avatarUrl = await storeAdminProfileAvatar(context.env, payload.avatar);
    const now = Date.now();
    await context.env.RATE_LIMIT_DB.prepare(`
        insert into admin_profiles (email, display_name, contact_email, phone, avatar_url, updated_at)
        values (?1, ?2, ?3, ?4, ?5, ?6)
        on conflict(email) do update set
            display_name = excluded.display_name,
            contact_email = excluded.contact_email,
            phone = excluded.phone,
            avatar_url = excluded.avatar_url,
            updated_at = excluded.updated_at
    `).bind(email, payload.display_name, payload.contact_email, payload.phone, avatarUrl, now).run();
    return json({
        ok: true,
        principal,
        profile: {
            display_name: payload.display_name,
            contact_email: payload.contact_email,
            phone: payload.phone,
            avatar_url: avatarUrl
        }
    });
}

async function handleAdminRoles(context) {
    if (!["GET", "POST", "DELETE"].includes(context.request.method)) return methodNotAllowed(["GET", "POST", "DELETE"]);
    const authFailure = await requireAdminAccess(context, "roles");
    if (authFailure) return authFailure;
    await ensureAdminRolesSchema(context.env.RATE_LIMIT_DB);
    const superEmail = String(context.env.ADMIN_EMAIL || "").trim().toLowerCase();

    if (context.request.method === "GET") {
        const result = await context.env.RATE_LIMIT_DB.prepare(`
            select email,
                can_questions_view,
                can_questions_create,
                can_questions_edit,
                can_questions_bulk,
                can_flashcards_view,
                can_flashcards_create,
                can_flashcards_edit,
                can_quotes_view,
                can_quotes_create,
                can_quotes_edit,
                active, created_at, updated_at
            from admin_roles order by email asc
        `).all();
        const delegated = (result?.results || []).map(row => ({
            email: String(row.email || ""),
            is_super_admin: false,
            can_questions_view: Number(row.can_questions_view) === 1,
            can_questions_create: Number(row.can_questions_create) === 1,
            can_questions_edit: Number(row.can_questions_edit) === 1,
            can_questions_bulk: Number(row.can_questions_bulk) === 1,
            can_flashcards_view: Number(row.can_flashcards_view) === 1,
            can_flashcards_create: Number(row.can_flashcards_create) === 1,
            can_flashcards_edit: Number(row.can_flashcards_edit) === 1,
            can_quotes_view: Number(row.can_quotes_view) === 1,
            can_quotes_create: Number(row.can_quotes_create) === 1,
            can_quotes_edit: Number(row.can_quotes_edit) === 1,
            active: Number(row.active) === 1,
            created_at: Number(row.created_at || 0),
            updated_at: Number(row.updated_at || 0)
        }));
        return json({
            ok: true,
            roles: [{
                email: superEmail,
                is_super_admin: true,
                can_questions_view: true,
                can_questions_create: true,
                can_questions_edit: true,
                can_questions_bulk: true,
                can_flashcards_view: true,
                can_flashcards_create: true,
                can_flashcards_edit: true,
                can_quotes_view: true,
                can_quotes_create: true,
                can_quotes_edit: true,
                active: true
            }, ...delegated]
        });
    }

    if (context.request.method === "DELETE") {
        const { email } = validateAdminRoleDeletePayload(await readJson(context.request, 4096));
        if (!email || email === superEmail) {
            return apiError(400, "super_admin_immutable", "The primary super-admin cannot be deleted.");
        }
        if (!context.env.SUPABASE_URL || !context.env.SUPABASE_SECRET_KEY) {
            return apiError(503, "security_not_configured", "Admin user management is not configured.");
        }
        const listResponse = await fetch(`${context.env.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1000`, {
            headers: {
                apikey: context.env.SUPABASE_SECRET_KEY,
                Authorization: `Bearer ${context.env.SUPABASE_SECRET_KEY}`
            }
        });
        const listResult = await listResponse.json().catch(() => ({}));
        if (!listResponse.ok) {
            return apiError(502, "auth_user_lookup_failed", "Could not check the delegated login account.");
        }
        const users = Array.isArray(listResult?.users) ? listResult.users : Array.isArray(listResult) ? listResult : [];
        const authUser = users.find(user => String(user?.email || "").trim().toLowerCase() === email);
        if (authUser?.id) {
            const deleteResponse = await fetch(`${context.env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(authUser.id)}`, {
                method: "DELETE",
                headers: {
                    apikey: context.env.SUPABASE_SECRET_KEY,
                    Authorization: `Bearer ${context.env.SUPABASE_SECRET_KEY}`
                }
            });
            if (!deleteResponse.ok && deleteResponse.status !== 404) {
                return apiError(502, "auth_user_delete_failed", "Could not delete the delegated login account.");
            }
        }
        await context.env.RATE_LIMIT_DB.prepare("delete from admin_roles where email = ?1").bind(email).run();
        return json({ ok: true }, 200);
    }

    const role = validateAdminRolePayload(await readJson(context.request, 8192));
    if (role.email === superEmail) {
        return apiError(400, "super_admin_immutable", "The primary super-admin role cannot be changed here.");
    }
    const existingRole = await context.env.RATE_LIMIT_DB.prepare(`
        select email from admin_roles where email = ?1 limit 1
    `).bind(role.email).first();
    if (!existingRole && !role.password) {
        return apiError(400, "password_required", "Set a delegated admin password of at least 6 characters for a new admin.");
    }
    if (role.password) {
        await createDelegatedAdminAuthUser(context, role.email, role.password);
    }
    if (
        role.active
        && !role.can_questions_view
        && !role.can_questions_create
        && !role.can_questions_edit
        && !role.can_questions_bulk
        && !role.can_flashcards_view
        && !role.can_flashcards_create
        && !role.can_flashcards_edit
        && !role.can_quotes_view
        && !role.can_quotes_create
        && !role.can_quotes_edit
    ) {
        return apiError(400, "empty_role", "An active admin must have at least one permission.");
    }
    const now = Date.now();
    await context.env.RATE_LIMIT_DB.prepare(`
        insert into admin_roles (
            email,
            can_questions_view, can_questions_create, can_questions_edit, can_questions_bulk,
            can_flashcards_view, can_flashcards_create, can_flashcards_edit,
            can_quotes_view, can_quotes_create, can_quotes_edit,
            active, created_at, updated_at
        ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
        on conflict(email) do update set
            can_questions_view = excluded.can_questions_view,
            can_questions_create = excluded.can_questions_create,
            can_questions_edit = excluded.can_questions_edit,
            can_questions_bulk = excluded.can_questions_bulk,
            can_flashcards_view = excluded.can_flashcards_view,
            can_flashcards_create = excluded.can_flashcards_create,
            can_flashcards_edit = excluded.can_flashcards_edit,
            can_quotes_view = excluded.can_quotes_view,
            can_quotes_create = excluded.can_quotes_create,
            can_quotes_edit = excluded.can_quotes_edit,
            active = excluded.active,
            updated_at = excluded.updated_at
    `).bind(
        role.email,
        role.can_questions_view ? 1 : 0,
        role.can_questions_create ? 1 : 0,
        role.can_questions_edit ? 1 : 0,
        role.can_questions_bulk ? 1 : 0,
        role.can_flashcards_view ? 1 : 0,
        role.can_flashcards_create ? 1 : 0,
        role.can_flashcards_edit ? 1 : 0,
        role.can_quotes_view ? 1 : 0,
        role.can_quotes_create ? 1 : 0,
        role.can_quotes_edit ? 1 : 0,
        role.active ? 1 : 0,
        now
    ).run();
    return json({ ok: true, role }, 200);
}

async function handleAdminQuestion(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    const authFailure = await requireAdminAccess(context);
    if (authFailure) return authFailure;
    const validatedPayload = validateAdminQuestionPayload(await readJson(context.request, 20 * 1024 * 1024));
    const principal = context.data?.adminPrincipal;
    const requiredPermission = validatedPayload.id ? "questions_edit" : "questions_create";
    if (!adminHasCapability(principal, requiredPermission)) {
        return apiError(403, "permission_denied", "Your admin role does not permit this action.");
    }
    const payload = await prepareQuestionMedia(context.env, validatedPayload);
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

async function handleAdminPEResources(context) {
    const authFailure = await requireAdminAccess(context);
    if (authFailure) return authFailure;
    const principal = context.data?.adminPrincipal;
    if (context.request.method === "GET") {
        if (!adminHasCapability(principal, "questions_view")) {
            return apiError(403, "permission_denied", "Your admin role does not permit this action.");
        }
        const fields = "id,kind,title,content,practice_prompt,practice_answer,document_url,preview_url,published,sort_order,updated_at";
        return json(await supabaseServerRequest(context.env, `PEResources?select=${fields}&order=sort_order.asc,id.asc`));
    }
    if (context.request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
    const validated = validateAdminPEResourcePayload(await readJson(context.request, 20 * 1024 * 1024));
    const requiredPermission = validated.id ? "questions_edit" : "questions_create";
    if (!adminHasCapability(principal, requiredPermission)) {
        return apiError(403, "permission_denied", "Your admin role does not permit this action.");
    }
    const payload = await preparePEResourceMedia(context.env, validated);
    const path = payload.id ? `PEResources?id=eq.${encodeURIComponent(payload.id)}` : "PEResources";
    await supabaseServerRequest(context.env, path, {
        method: payload.id ? "PATCH" : "POST",
        body: { ...payload, id: undefined, updated_at: new Date().toISOString() },
        prefer: "return=minimal"
    });
    return json({ ok: true }, payload.id ? 200 : 201);
}

async function handleAdminBulkQuestions(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    const authFailure = await requireAdminAccess(context, "questions_bulk");
    if (authFailure) return authFailure;
    const payload = validateAdminBulkQuestionsPayload(await readJson(context.request, 10 * 1024 * 1024));
    const preparedQuestions = [];
    for (const question of payload.questions) {
        preparedQuestions.push(await prepareQuestionMedia(context.env, question));
    }
    await supabaseServerRequest(context.env, payload.table, {
        method: "POST",
        body: preparedQuestions.map(toSupabaseQuestionPayload),
        prefer: "return=minimal"
    });
    return json({ ok: true, count: payload.questions.length }, 201);
}

async function handleAdminFlashcard(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    const authFailure = await requireAdminAccess(context);
    if (authFailure) return authFailure;
    const payload = validateAdminFlashcardPayload(await readJson(context.request, 16384));
    const principal = context.data?.adminPrincipal;
    const requiredPermission = payload.id ? "flashcards_edit" : "flashcards_create";
    if (!adminHasCapability(principal, requiredPermission)) {
        return apiError(403, "permission_denied", "Your admin role does not permit this action.");
    }
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
    const principal = context.data?.adminPrincipal;
    const requiredPermission = payload.id ? "quotes_edit" : "quotes_create";
    if (!adminHasCapability(principal, requiredPermission)) {
        return apiError(403, "permission_denied", "Your admin role does not permit this action.");
    }
    const path = payload.id
        ? `${"daily_quotes"}?id=eq.${encodeURIComponent(payload.id)}`
        : "daily_quotes";
    await supabaseServerRequest(context.env, path, {
        method: payload.id ? "PATCH" : "POST",
        body: {
            english_quote: payload.english_quote || null,
            dzongkha_quote: payload.dzongkha_quote || null,
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
        else if (name === "admin-otp-request") response = await handleAdminOtpRequest(context, session.id);
        else if (name === "admin-otp-verify") response = await handleAdminOtpVerify(context, session.id);
        else if (name === "admin-session-refresh") response = await handleAdminSessionRefresh(context);
        else if (name === "admin-logout") response = await handleAdminLogout(context);
        else if (name === "admin-password-recovery") response = await handleAdminPasswordRecovery(context);
        else if (name === "admin-questions") response = await handleAdminQuestions(context);
        else if (name === "admin-flashcards") response = await handleFlashcards(context);
        else if (name === "admin-quotes") response = await handleQuotes(context);
        else if (name === "admin-pe-resources") response = await handleAdminPEResources(context);
        else if (name === "admin-question-media") response = await handleAdminQuestionMedia(context);
        else if (name === "admin-question") response = await handleAdminQuestion(context);
        else if (name === "admin-bulk-questions") response = await handleAdminBulkQuestions(context);
        else if (name === "admin-flashcard") response = await handleAdminFlashcard(context);
        else if (name === "admin-quote") response = await handleAdminQuote(context);
        else if (name === "admin-profile") response = await handleAdminProfile(context);
        else if (name === "admin-roles") response = await handleAdminRoles(context);
        else response = apiError(404, "not_found", "API endpoint not found.");
        return withSessionCookie(response, session.id, session.isNew);
    } catch (error) {
        return withSessionCookie(handleError(error), session.id, session.isNew);
    }
}
