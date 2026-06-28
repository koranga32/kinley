import { apiError, handleError, json, methodNotAllowed, readJson, withSessionCookie } from "../_shared/http.js";
import { enforceRateLimits, getSession, rejectCrossSiteRequest } from "../_shared/security.js";
import { supabaseServerRequest } from "../_shared/supabase.js";
import { validateContactPayload, validateMediaIds, validateResponsePayload } from "../_shared/validation.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const POLICIES = {
    health: { windowMs: MINUTE, ipLimit: 30, sessionLimit: 30 },
    questions: { windowMs: MINUTE, ipLimit: 60, sessionLimit: 90 },
    flashcards: { windowMs: MINUTE, ipLimit: 60, sessionLimit: 90 },
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
        const fields = "id,category,question,optionA,optionB,optionC,optionD,answer";
        return json(await supabaseServerRequest(context.env, `Exam?select=${fields}&order=id.asc`));
    }
    if (view === "media") {
        const ids = validateMediaIds(url.searchParams.get("ids"));
        const filter = ids.length ? `&id=in.(${ids.join(",")})` : "";
        return json(await supabaseServerRequest(context.env, `Exam?select=id,image,audio${filter}`));
    }
    return apiError(400, "invalid_view", "Question view must be text or media.");
}

async function handleFlashcards(context) {
    if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
    const fields = "id,scope,category,date_stamp,exam_focus,answer,created_at";
    return json(await supabaseServerRequest(
        context.env,
        `CurrentAffairFlashcards?select=${fields}&order=created_at.desc`
    ));
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
    const payload = validateResponsePayload(await readJson(context.request, 512000));
    await supabaseServerRequest(context.env, "Response", {
        method: "POST",
        body: payload,
        prefer: "return=minimal"
    });
    return json({ ok: true }, 201);
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
        else if (name === "flashcards") response = await handleFlashcards(context);
        else if (name === "quotes") response = await handleQuotes(context);
        else if (name === "responses") response = await handleResponses(context);
        else if (name === "contact") response = await handleContact(context);
        else response = apiError(404, "not_found", "API endpoint not found.");
        return withSessionCookie(response, session.id, session.isNew);
    } catch (error) {
        return withSessionCookie(handleError(error), session.id, session.isNew);
    }
}
