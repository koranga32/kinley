import { apiError, handleError, json, methodNotAllowed, readJson, withSessionCookie } from "../_shared/http.js";
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

const POLICIES = {
    health: { windowMs: MINUTE, ipLimit: 30, sessionLimit: 30 },
    questions: { windowMs: MINUTE, ipLimit: 60, sessionLimit: 90 },
    "exam-start": { windowMs: 10 * MINUTE, ipLimit: 40, sessionLimit: 30 },
    "question-solution": { windowMs: MINUTE, ipLimit: 120, sessionLimit: 90 },
    "pe-online-questions": { windowMs: MINUTE, ipLimit: 60, sessionLimit: 90 },
    "pe-online-start": { windowMs: 10 * MINUTE, ipLimit: 30, sessionLimit: 20 },
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
        return json([...counts].map(([category, count]) => ({ category, count })));
    }
    if (view === "text" || view === "pe-practice") {
        const fields = "id,category,question,optionA,optionB,optionC,optionD";
        const rows = await supabaseServerRequest(context.env, `Exam?select=${fields}&order=id.asc`);
        return json((rows || [])
            .filter(row => String(row.category || "").startsWith("__PE__::"))
            .map(row => ({ ...row, question: publicQuestionText(row.question) })));
    }
    if (view === "media") {
        const ids = validateMediaIds(url.searchParams.get("ids"));
        if (!ids.length) return apiError(400, "missing_ids", "Question media IDs are required.");
        return json(await supabaseServerRequest(
            context.env,
            `Exam?select=id,image,audio&id=in.(${ids.join(",")})`
        ));
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
        return json(await supabaseServerRequest(context.env, `Exam?${params.toString()}`));
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
        return json({ counts, total: calculatePEOnlineTotal(counts) });
    }
    if (view === "media") {
        const ids = validateMediaIds(url.searchParams.get("ids"));
        if (!ids.length) return apiError(400, "missing_ids", "PE Online media IDs are required.");
        const rows = await supabaseServerRequest(
            context.env,
            `PEOnlineExam?select=id,image,audio&id=in.(${ids.join(",")})`
        );
        return json((rows || []).map(row => ({ ...row, id: `peo:${row.id}` })));
    }
    if (view === "all-media") {
        const rows = await supabaseServerRequest(
            context.env,
            "PEOnlineExam?select=id,image,audio&order=id.asc"
        );
        return json((rows || []).map(row => ({ ...row, id: `peo:${row.id}` })));
    }
    return apiError(400, "invalid_view", "PE Online question view must be catalog, media, or all-media.");
}

async function handleFlashcards(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const fields = "id,scope,category,date_stamp,exam_focus,created_at";
    return json(await supabaseServerRequest(
        context.env,
        `CurrentAffairFlashcards?select=${fields}&order=created_at.desc`
    ));
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
    const sessionId = await storeExamSession(context.env.RATE_LIMIT_DB, prepared.map(item => item.gradingItem));
    return json({
        ok: true,
        session_id: sessionId,
        questions: prepared.map(item => item.publicQuestion)
    }, 201);
}

async function handlePEOnlineStart(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    validateEmptyPayload(await readJson(context.request, 1024), "PE Online start request");
    const fields = "id,category,question,optionA,optionB,optionC,optionD,answer";
    const rows = await supabaseServerRequest(context.env, `PEOnlineExam?select=${fields}&order=id.asc`);
    const selected = selectPEOnlineRows(rows || []);
    const prepared = buildSecureQuestions(selected, "peo:");
    if (!prepared.length) return apiError(404, "no_questions", "No valid PE Online questions were found.");
    const sessionId = await storeExamSession(context.env.RATE_LIMIT_DB, prepared.map(item => item.gradingItem));
    return json({
        ok: true,
        session_id: sessionId,
        questions: prepared.map(item => item.publicQuestion)
    }, 201);
}

async function handleQuotes(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const now = encodeURIComponent(new Date().toISOString());
    return json(await supabaseServerRequest(
        context.env,
        `daily_quotes?select=id,english_quote,dzongkha_quote,expires_at,created_at&expires_at=gt.${now}&order=created_at.desc`
    ));
}

async function handleResponses(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    const submission = validateGradedResponsePayload(await readJson(context.request, 512000));
    await ensureExamSessionSchema(context.env.RATE_LIMIT_DB);
    const session = await context.env.RATE_LIMIT_DB.prepare(
        "update exam_sessions set used_at = ?1 where session_id = ?2 and used_at is null and expires_at > ?1 returning payload"
    ).bind(Date.now(), submission.session_id).first();
    if (!session?.payload) return apiError(409, "invalid_exam_session", "Exam session is expired or already submitted.");
    const items = JSON.parse(session.payload);
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
    return json({ ok: true, result: { correct, wrong, skipped, total: items.length, grading } }, 201);
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
        console.error("Contact upstream failure", response.status, result.message || result.name || "Unknown error");
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
        else if (name === "exam-start") response = await handleExamStart(context);
        else if (name === "question-solution") response = await handleQuestionSolution(context);
        else if (name === "pe-online-questions") response = await handlePEOnlineQuestions(context);
        else if (name === "pe-online-start") response = await handlePEOnlineStart(context);
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
