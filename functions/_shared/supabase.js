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

export async function supabaseStorageUpload(env, bucket, objectPath, bytes, contentType) {
    requireConfig(env);
    const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`, {
        method: "POST",
        headers: {
            apikey: env.SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
            "x-upsert": "false"
        },
        body: bytes
    });
    if (!response.ok) {
        console.error("Supabase Storage upload failure", response.status, await response.text());
        throw validationError("media_upload_failed", "Media upload failed. Please try again.", 502);
    }
    return `${env.SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodedPath}`;
}
