const JSON_HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
};

export function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...JSON_HEADERS, ...extraHeaders }
    });
}

export function apiError(status, code, message, extraHeaders = {}) {
    return json({ ok: false, error: { code, message } }, status, extraHeaders);
}

export function methodNotAllowed(allowed) {
    return apiError(405, "method_not_allowed", "This request method is not allowed.", {
        Allow: allowed.join(", ")
    });
}

export function withSessionCookie(response, sessionId, shouldSetCookie) {
    if (!shouldSetCookie) return response;
    const next = new Response(response.body, response);
    next.headers.append(
        "Set-Cookie",
        `ep_session=${sessionId}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict`
    );
    return next;
}

export async function readJson(request, maxBytes = 32768) {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
        throw validationError("content_type", "Content-Type must be application/json.");
    }

    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw validationError("payload_too_large", "Request body is too large.", 413);
    }

    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
        throw validationError("payload_too_large", "Request body is too large.", 413);
    }

    try {
        return JSON.parse(text);
    } catch {
        throw validationError("invalid_json", "Request body must contain valid JSON.");
    }
}

export function validationError(code, message, status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

export function handleError(error) {
    if (error && Number.isInteger(error.status)) {
        return apiError(error.status, error.code || "invalid_request", error.message);
    }
    console.error("ExamPortal API error", error);
    return apiError(500, "internal_error", "The request could not be completed.");
}

