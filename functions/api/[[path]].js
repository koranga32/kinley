import { apiError, handleError, json, methodNotAllowed, readJson, withSessionCookie } from "../_shared/http.js";
import { enforceRateLimits, getSession, rejectCrossSiteRequest } from "../_shared/security.js";
import { supabaseServerRequest } from "../_shared/supabase.js";
import {
    validateContactPayload,
    validateExamSessionPayload,
    validateGradedResponsePayload,
    validateMediaIds
} from "../_shared/validation.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const POLICIES = {
    health: { windowMs: MINUTE, ipLimit: 30, sessionLimit: 30 },
    questions: { windowMs: MINUTE, ipLimit: 60, sessionLimit: 90 },
    "question-solution": { windowMs: MINUTE, ipLimit: 120, sessionLimit: 90 },
    "pe-online-questions": { windowMs: MINUTE, ipLimit: 60, sessionLimit: 90 },
    flashcards: { windowMs: MINUTE, ipLimit: 60, sessionLimit: 90 },
    "flashcard-answer": { windowMs: MINUTE, ipLimit: 90, sessionLimit: 60 },
    "exam-session": { windowMs: HOUR, ipLimit: 60, sessionLimit: 20 },
    quotes: { windowMs: MINUTE, ipLimit: 60, sessionLimit: 90 },
    responses: { windowMs: HOUR, ipLimit: 60, sessionLimit: 12 },
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
    if (view === "text") {
        const fields = "id,category,question,optionA,optionB,optionC,optionD";
        const rows = await supabaseServerRequest(context.env, `Exam?select=${fields}&order=id.asc`);
        return json((rows || []).map(row => ({ ...row, question: publicQuestionText(row.question) })));
    }
    if (view === "media") {
        const ids = validateMediaIds(url.searchParams.get("ids"));
        const filter = ids.length ? `&id=in.(${ids.join(",")})` : "";
        return json(await supabaseServerRequest(context.env, `Exam?select=id,image,audio${filter}`));
    }
    return apiError(400, "invalid_view", "Question view must be text or media.");
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
    if (view === "text") {
        const fields = "id,category,question,optionA,optionB,optionC,optionD";
        const rows = await supabaseServerRequest(context.env, `PEOnlineExam?select=${fields}&order=id.asc`);
        return json((rows || []).map(row => ({
            ...row,
            id: `peo:${row.id}`,
            question: publicQuestionText(row.question)
        })));
    }
    if (view === "media") {
        const ids = validateMediaIds(url.searchParams.get("ids"));
        const filter = ids.length ? `&id=in.(${ids.join(",")})` : "";
        const rows = await supabaseServerRequest(context.env, `PEOnlineExam?select=id,image,audio${filter}`);
        return json((rows || []).map(row => ({ ...row, id: `peo:${row.id}` })));
    }
    return apiError(400, "invalid_view", "PE Online question view must be text or media.");
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

async function buildGradingItems(env, requestedItems) {
    const examIds = requestedItems.filter(item => /^\d+$/.test(item.id)).map(item => item.id);
    const peOnlineIds = requestedItems.filter(item => item.id.startsWith("peo:")).map(item => item.id.slice(4));
    const examRows = examIds.length
        ? await supabaseServerRequest(env, `Exam?select=id,question,optionA,optionB,optionC,optionD,answer&id=in.(${examIds.join(",")})`)
        : [];
    const peOnlineRows = peOnlineIds.length
        ? await supabaseServerRequest(env, `PEOnlineExam?select=id,question,optionA,optionB,optionC,optionD,answer&id=in.(${peOnlineIds.join(",")})`)
        : [];
    const examById = new Map((examRows || []).map(row => [String(row.id), row]));
    const peOnlineById = new Map((peOnlineRows || []).map(row => [String(row.id), row]));

    return requestedItems.map(item => {
        const providedOptions = item.options.map(normalizeOption);
        let question;
        let correctText;
        const isPEOnline = item.id.startsWith("peo:");
        const row = isPEOnline ? peOnlineById.get(item.id.slice(4)) : examById.get(item.id);
        if (!row) {
            const label = isPEOnline ? "A PE Online question" : "An exam question";
            throw Object.assign(new Error(`${label} no longer exists.`), { status: 400, code: "stale_question" });
        }
        {
            const storedOptions = [row.optionA, row.optionB, row.optionC, row.optionD].map(normalizeOption);
            const answerIndex = parseAnswerIndex(row.answer);
            if (answerIndex < 0 || [...storedOptions].sort().join("\u0000") !== [...providedOptions].sort().join("\u0000")) {
                throw Object.assign(new Error("Exam options are invalid."), { status: 400, code: "invalid_options" });
            }
            question = publicQuestionText(row.question);
            correctText = storedOptions[answerIndex];
        }
        const correctIndex = providedOptions.indexOf(correctText);
        if (correctIndex < 0) throw Object.assign(new Error("Correct option is missing."), { status: 400, code: "invalid_options" });
        return { id: item.id, question, options: item.options, correctIndex };
    });
}

async function handleExamSession(context) {
    if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
    const payload = validateExamSessionPayload(await readJson(context.request, 512000));
    const gradingItems = await buildGradingItems(context.env, payload.items);
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    await context.env.RATE_LIMIT_DB.prepare(
        "insert into exam_sessions (session_id, payload, expires_at, used_at) values (?1, ?2, ?3, null)"
    ).bind(sessionId, JSON.stringify(gradingItems), now + 3 * HOUR).run();
    context.waitUntil?.(
        context.env.RATE_LIMIT_DB.prepare("delete from exam_sessions where expires_at < ?1").bind(now).run().catch(() => {})
    );
    return json({ ok: true, session_id: sessionId }, 201);
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
        else if (name === "question-solution") response = await handleQuestionSolution(context);
        else if (name === "pe-online-questions") response = await handlePEOnlineQuestions(context);
        else if (name === "flashcards") response = await handleFlashcards(context);
        else if (name === "flashcard-answer") response = await handleFlashcardAnswer(context);
        else if (name === "exam-session") response = await handleExamSession(context);
        else if (name === "quotes") response = await handleQuotes(context);
        else if (name === "responses") response = await handleResponses(context);
        else if (name === "contact") response = await handleContact(context);
        else response = apiError(404, "not_found", "API endpoint not found.");
        return withSessionCookie(response, session.id, session.isNew);
    } catch (error) {
        return withSessionCookie(handleError(error), session.id, session.isNew);
    }
}
