import { validationError } from "./http.js";

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(value, allowedKeys, label) {
    if (!isPlainObject(value)) {
        throw validationError("invalid_type", `${label} must be an object.`);
    }
    const unexpected = Object.keys(value).filter(key => !allowedKeys.includes(key));
    if (unexpected.length) {
        throw validationError("unexpected_field", `Unexpected field: ${unexpected[0]}.`);
    }
    return value;
}

function cleanText(value, label, { min = 1, max, pattern } = {}) {
    if (typeof value !== "string") {
        throw validationError("invalid_type", `${label} must be text.`);
    }
    // Preserve multilingual content exactly as entered. Compatibility
    // normalization can decompose or replace valid Tibetan/Dzongkha glyphs.
    const normalized = value.trim();
    const unsupportedControls = normalized.replace(/[\n\r\t]/g, "");
    if (/\p{Cc}/u.test(unsupportedControls)) {
        throw validationError("invalid_characters", `${label} contains unsupported control characters.`);
    }
    if (normalized.length < min || normalized.length > max) {
        throw validationError("invalid_length", `${label} must contain ${min}-${max} characters.`);
    }
    if (pattern && !pattern.test(normalized)) {
        throw validationError("invalid_format", `${label} has an invalid format.`);
    }
    return normalized;
}

function optionalEmail(value) {
    if (value === undefined || value === null || value === "") return "";
    const email = cleanText(value, "Email", { min: 3, max: 160 });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw validationError("invalid_email", "Email address is not valid.");
    }
    return email;
}

function allowedValue(value, allowed, label) {
    if (typeof value !== "string" || !allowed.includes(value)) {
        throw validationError("invalid_value", `${label} is not allowed.`);
    }
    return value;
}

export function validateContactPayload(input) {
    const value = exactObject(input, ["name", "email", "subject", "inquiry_type", "message"], "Contact request");
    return {
        name: cleanText(value.name, "Full name", { min: 2, max: 100 }),
        email: optionalEmail(value.email),
        subject: cleanText(value.subject, "Subject", { min: 3, max: 120 }),
        inquiry_type: allowedValue(
            value.inquiry_type,
            ["Contact", "Feedback", "Technical Issue", "Question Correction"],
            "Inquiry type"
        ),
        message: cleanText(value.message, "Message", { min: 10, max: 2000 })
    };
}

export function validateExamStartPayload(input) {
    const value = exactObject(input, ["category"], "Exam start request");
    return {
        category: cleanText(value.category, "Category", { min: 1, max: 200 })
    };
}

export function validateEmptyPayload(input, label = "Request") {
    exactObject(input, [], label);
    return {};
}

export function validateGradedResponsePayload(input) {
    const value = exactObject(
        input,
        ["session_id", "time_stamp", "student_name", "category_track", "selections"],
        "Exam submission"
    );
    const sessionId = cleanText(value.session_id, "Exam session", {
        min: 36,
        max: 36,
        pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    });
    const timeStamp = cleanText(value.time_stamp, "Timestamp", { min: 20, max: 35 });
    const parsedTime = Date.parse(timeStamp);
    if (!Number.isFinite(parsedTime) || Math.abs(Date.now() - parsedTime) > 24 * 60 * 60 * 1000) {
        throw validationError("invalid_timestamp", "Timestamp must be a current ISO date.");
    }
    if (!Array.isArray(value.selections) || value.selections.length < 1 || value.selections.length > 120) {
        throw validationError("invalid_selections", "Selections must contain 1-120 answers.");
    }
    return {
        session_id: sessionId,
        time_stamp: new Date(parsedTime).toISOString(),
        student_name: cleanText(value.student_name, "Student name", { min: 1, max: 80 }),
        category_track: cleanText(value.category_track, "Category", { min: 1, max: 120 }),
        selections: value.selections.map((selection, index) => {
            if (selection === null) return null;
            if (!Number.isInteger(selection) || selection < 0 || selection > 3) {
                throw validationError("invalid_selection", `Selection ${index + 1} must be 0-3 or null.`);
            }
            return selection;
        })
    };
}

export function validateMediaIds(rawIds) {
    if (!rawIds) return [];
    const parts = rawIds.split(",");
    if (parts.length > 100) {
        throw validationError("too_many_ids", "At most 100 media IDs may be requested.");
    }
    return parts.map(value => {
        const id = value.trim();
        if (!/^\d{1,12}$/.test(id)) {
            throw validationError("invalid_id", "Media IDs must be positive integers.");
        }
        return id;
    });
}
