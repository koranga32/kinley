import { apiError } from "./http.js";

function parseCookies(request) {
    const output = {};
    for (const part of (request.headers.get("cookie") || "").split(";")) {
        const index = part.indexOf("=");
        if (index > 0) output[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return output;
}

export function getSession(request) {
    const existing = parseCookies(request).ep_session;
    if (existing && /^[a-f0-9-]{36}$/i.test(existing)) {
        return { id: existing, isNew: false };
    }
    return { id: crypto.randomUUID(), isNew: true };
}

async function sha256(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function incrementWindow(db, key, windowStart) {
    const row = await db.prepare(`
        insert into rate_limits (rate_key, window_start, request_count)
        values (?1, ?2, 1)
        on conflict(rate_key, window_start)
        do update set request_count = request_count + 1
        returning request_count
    `).bind(key, windowStart).first();
    return Number(row?.request_count || 1);
}

export async function enforceRateLimits(context, routeName, sessionId, policy) {
    const { request, env } = context;
    if (!env.RATE_LIMIT_DB || !env.RATE_LIMIT_SALT) {
        return apiError(503, "security_not_configured", "Security service is not configured yet.");
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now();
    const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
    const retrySeconds = Math.max(1, Math.ceil((windowStart + policy.windowMs - now) / 1000));
    const [ipHash, sessionHash] = await Promise.all([
        sha256(`${env.RATE_LIMIT_SALT}:ip:${ip}`),
        sha256(`${env.RATE_LIMIT_SALT}:session:${sessionId}`)
    ]);

    const [ipCount, sessionCount] = await Promise.all([
        incrementWindow(env.RATE_LIMIT_DB, `${routeName}:ip:${ipHash}`, windowStart),
        incrementWindow(env.RATE_LIMIT_DB, `${routeName}:session:${sessionHash}`, windowStart)
    ]);

    if (Math.random() < 0.01) {
        context.waitUntil(
            env.RATE_LIMIT_DB.prepare("delete from rate_limits where window_start < ?1")
                .bind(now - 2 * 24 * 60 * 60 * 1000)
                .run()
                .catch(() => {})
        );
    }

    if (ipCount > policy.ipLimit || sessionCount > policy.sessionLimit) {
        return apiError(429, "rate_limited", "Too many requests. Please wait and try again.", {
            "Retry-After": String(retrySeconds),
            "X-RateLimit-Limit": String(Math.min(policy.ipLimit, policy.sessionLimit)),
            "X-RateLimit-Remaining": "0"
        });
    }
    return null;
}

export function rejectCrossSiteRequest(request) {
    const origin = request.headers.get("origin");
    if (!origin) return null;
    const expectedOrigin = new URL(request.url).origin;
    if (origin !== expectedOrigin) {
        return apiError(403, "origin_rejected", "Cross-site API requests are not allowed.");
    }
    return null;
}

