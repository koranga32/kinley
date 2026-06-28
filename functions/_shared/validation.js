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
    const normalized = value.normalize("NFKC").trim();
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

export function validateResponsePayload(input) {
    const value = exactObject(
        input,
        ["time_stamp", "student_name", "category_track", "final_score", "detailed_breakdown"],
        "Exam response"
    );

    const timeStamp = cleanText(value.time_stamp, "Timestamp", { min: 20, max: 35 });
    const parsedTime = Date.parse(timeStamp);
    if (!Number.isFinite(parsedTime) || Math.abs(Date.now() - parsedTime) > 24 * 60 * 60 * 1000) {
        throw validationError("invalid_timestamp", "Timestamp must be a current ISO date.");
    }

    const finalScore = cleanText(value.final_score, "Final score", {
        min: 3,
        max: 9,
        pattern: /^\d{1,3}\/\d{1,3}$/
    });
    const [correct, total] = finalScore.split("/").map(Number);

    if (!Array.isArray(value.detailed_breakdown) || value.detailed_breakdown.length < 1 || value.detailed_breakdown.length > 200) {
        throw validationError("invalid_breakdown", "Detailed breakdown must contain 1-200 questions.");
    }
    if (total !== value.detailed_breakdown.length || correct < 0 || correct > total) {
        throw validationError("invalid_score", "Final score does not match the question breakdown.");
    }

    const breakdown = value.detailed_breakdown.map((entry, index) => {
        const item = exactObject(entry, ["question", "selected", "status"], `Breakdown item ${index + 1}`);
        return {
            question: cleanText(item.question, `Question ${index + 1}`, { min: 1, max: 2000 }),
            selected: allowedValue(item.selected, ["A", "B", "C", "D", "Skipped"], `Selected answer ${index + 1}`),
            status: allowedValue(item.status, ["CORRECT", "WRONG", "SKIPPED"], `Answer status ${index + 1}`)
        };
    });

    const calculatedCorrect = breakdown.filter(item => item.status === "CORRECT").length;
    if (calculatedCorrect !== correct) {
        throw validationError("invalid_score", "Correct-answer count does not match the final score.");
    }

    return {
        time_stamp: new Date(parsedTime).toISOString(),
        student_name: cleanText(value.student_name, "Student name", { min: 2, max: 80 }),
        category_track: cleanText(value.category_track, "Category", { min: 1, max: 120 }),
        final_score: finalScore,
        detailed_breakdown: breakdown
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
