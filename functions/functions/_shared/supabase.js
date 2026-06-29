import { validationError } from "./http.js";

function requireConfig(env) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
        throw validationError("security_not_configured", "Database proxy is not configured yet.", 503);
    }
}

export async function supabaseServerRequest(env, path, { method = "GET", body, prefer = "" } = {}) {
    requireConfig(env);
    const headers = {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
        Accept: "application/json"
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (prefer) headers.Prefer = prefer;

    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (!response.ok) {
        console.error("Supabase proxy failure", response.status, await response.text());
        throw validationError("upstream_error", "Database request failed.", 502);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

