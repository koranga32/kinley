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
        student_name: cleanText(value.student_name, "Student name", { min: 1, max: 80 }),
        category_track: cleanText(value.category_track, "Category", { min: 1, max: 120 }),
        final_score: finalScore,
        detailed_breakdown: breakdown
    };
}

function validateQuestionId(value, label) {
    const id = String(value ?? "").trim();
    if (!/^(?:\d{1,12}|peo:\d{1,12})$/.test(id)) {
        throw validationError("invalid_question_id", `${label} is invalid.`);
    }
    return id;
}

export function validateExamSessionPayload(input) {
    const value = exactObject(input, ["items"], "Exam session request");
    if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 120) {
        throw validationError("invalid_exam_items", "Exam session must contain 1-120 questions.");
    }
    return {
        items: value.items.map((entry, index) => {
            const item = exactObject(entry, ["id", "options"], `Exam item ${index + 1}`);
            if (!Array.isArray(item.options) || item.options.length !== 4) {
                throw validationError("invalid_options", `Exam item ${index + 1} must contain four options.`);
            }
            return {
                id: validateQuestionId(item.id, `Question ID ${index + 1}`),
                options: item.options.map((option, optionIndex) => cleanText(
                    option,
                    `Question ${index + 1} option ${optionIndex + 1}`,
                    { min: 1, max: 2000 }
                ))
            };
        })
    };
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

export function validateAdminOtpRequestPayload(input) {
    const value = exactObject(input, ["email", "password"], "Admin OTP request");
    return {
        email: optionalEmail(value.email).toLowerCase(),
        password: cleanText(value.password, "Password", { min: 1, max: 200 })
    };
}

export function validateAdminRolePayload(input) {
    const value = exactObject(
        input,
        [
            "email",
            "password",
            "can_questions_view",
            "can_questions_create",
            "can_questions_edit",
            "can_questions_bulk",
            "can_flashcards_view",
            "can_flashcards_create",
            "can_flashcards_edit",
            "can_quotes_view",
            "can_quotes_create",
            "can_quotes_edit",
            "active"
        ],
        "Admin role"
    );
    const booleanField = (field, label) => {
        if (typeof field !== "boolean") throw validationError("invalid_type", `${label} must be true or false.`);
        return field;
    };
    return {
        email: optionalEmail(value.email).toLowerCase(),
        password: value.password === undefined || value.password === null || value.password === ""
            ? ""
            : cleanText(value.password, "Delegated admin password", { min: 6, max: 200 }),
        can_questions_view: booleanField(value.can_questions_view, "Question view permission"),
        can_questions_create: booleanField(value.can_questions_create, "Question create permission"),
        can_questions_edit: booleanField(value.can_questions_edit, "Question edit permission"),
        can_questions_bulk: booleanField(value.can_questions_bulk, "Question bulk permission"),
        can_flashcards_view: booleanField(value.can_flashcards_view, "Current Affair view permission"),
        can_flashcards_create: booleanField(value.can_flashcards_create, "Current Affair create permission"),
        can_flashcards_edit: booleanField(value.can_flashcards_edit, "Current Affair edit permission"),
        can_quotes_view: booleanField(value.can_quotes_view, "Quote view permission"),
        can_quotes_create: booleanField(value.can_quotes_create, "Quote create permission"),
        can_quotes_edit: booleanField(value.can_quotes_edit, "Quote edit permission"),
        active: booleanField(value.active, "Active status")
    };
}

export function validateAdminOtpVerifyPayload(input) {
    const value = exactObject(input, ["request_id", "code"], "Admin OTP verification");
    return {
        request_id: cleanText(value.request_id, "Request ID", {
            min: 36,
            max: 36,
            pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        }),
        code: cleanText(value.code, "Verification code", {
            min: 6,
            max: 6,
            pattern: /^\d{6}$/
        })
    };
}

export function validateAdminPasswordRecoveryPayload(input) {
    const value = exactObject(input, ["access_token", "password"], "Admin password recovery");
    return {
        access_token: cleanText(value.access_token, "Recovery token", { min: 40, max: 8192 }),
        password: cleanText(value.password, "New password", { min: 8, max: 200 })
    };
}

export function validateAdminProfilePayload(input) {
    const value = exactObject(input, ["display_name", "contact_email", "phone", "avatar"], "Admin profile");
    const phone = value.phone === undefined || value.phone === null || value.phone === ""
        ? ""
        : cleanText(String(value.phone), "Phone", { min: 1, max: 30 });
    return {
        display_name: cleanText(value.display_name, "Display name", { min: 1, max: 100 }),
        contact_email: optionalEmail(value.contact_email),
        phone,
        avatar: validateMediaReference(value.avatar, "Profile image", "image")
    };
}

export function validateAdminRoleDeletePayload(input) {
    const value = exactObject(input, ["email"], "Admin role deletion");
    return { email: optionalEmail(value.email).toLowerCase() };
}

function optionalEntityId(value, label = "ID") {
    if (value === undefined || value === null || value === "") return "";
    return cleanText(String(value), label, { min: 1, max: 24, pattern: /^\d{1,12}$/ });
}

function optionalSupabaseRowId(value, label = "ID") {
    if (value === undefined || value === null || value === "") return "";
    return cleanText(String(value), label, {
        min: 1,
        max: 80,
        pattern: /^(?:\d{1,20}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
    });
}

function requiredEnum(value, allowed, label) {
    return allowedValue(cleanText(String(value), label, { min: 1, max: 80 }), allowed, label);
}

function validateQuestionOptions(value, label = "Options") {
    if (!Array.isArray(value) || value.length !== 4) {
        throw validationError("invalid_options", `${label} must contain exactly four options.`);
    }
    return value.map((option, index) => cleanText(option, `${label} ${index + 1}`, { min: 1, max: 2000 }));
}

function validateMediaReference(value, label, mediaType) {
    if (value === undefined || value === null || value === "") return "";
    // Base64 adds roughly one third to the original file size. Allow enough
    // transport space for a real 6 MB file; decoded bytes are checked again
    // by the Storage upload handler before anything is stored.
    const text = cleanText(String(value), label, { min: 5, max: 9 * 1024 * 1024 });
    const expectedDataPrefix = new RegExp(`^data:${mediaType}/`, "i");
    if (!expectedDataPrefix.test(text) && !/^https:\/\/[^\s]+$/i.test(text)) {
        throw validationError("invalid_media", `${label} must be a valid ${mediaType} upload or trusted Storage URL.`);
    }
    return text;
}

export function validateAdminQuestionPayload(input) {
    const value = exactObject(
        input,
        ["id", "table", "category", "question", "explanation", "options", "answer", "imageCode", "audioCode"],
        "Admin question mutation"
    );
    const answer = Number(value.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer > 3) {
        throw validationError("invalid_answer", "Answer must be 0, 1, 2, or 3.");
    }
    return {
        id: optionalEntityId(value.id, "Question ID"),
        table: requiredEnum(value.table, ["Exam", "PEOnlineExam"], "Question table"),
        category: cleanText(value.category, "Category", { min: 1, max: 200 }),
        question: cleanText(value.question, "Question", { min: 1, max: 12000 }),
        explanation: value.explanation === undefined || value.explanation === null ? "" : cleanText(String(value.explanation), "Explanation", { min: 0, max: 12000 }),
        options: validateQuestionOptions(value.options),
        answer,
        imageCode: validateMediaReference(value.imageCode, "Image", "image"),
        audioCode: validateMediaReference(value.audioCode, "Audio", "audio")
    };
}

export function validateAdminBulkQuestionsPayload(input) {
    const value = exactObject(input, ["table", "questions"], "Admin bulk questions mutation");
    const table = requiredEnum(value.table, ["Exam", "PEOnlineExam"], "Question table");
    if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 200) {
        throw validationError("invalid_questions", "Bulk questions must contain 1-200 entries.");
    }
    return {
        table,
        questions: value.questions.map((question, index) => {
            const parsed = validateAdminQuestionPayload({ ...question, table });
            return { ...parsed, id: "" };
        })
    };
}

export function validateAdminFlashcardPayload(input) {
    const value = exactObject(input, ["id", "scope", "category", "date_stamp", "exam_focus", "answer"], "Admin flashcard mutation");
    return {
        id: optionalSupabaseRowId(value.id, "Flashcard ID"),
        scope: requiredEnum(value.scope, ["Bhutan", "International"], "Scope"),
        category: cleanText(value.category, "Category", { min: 1, max: 120 }),
        date_stamp: cleanText(value.date_stamp, "Date stamp", { min: 1, max: 80 }),
        exam_focus: cleanText(value.exam_focus, "Question", { min: 1, max: 4000 }),
        answer: cleanText(value.answer, "Answer", { min: 1, max: 4000 })
    };
}

export function validateAdminQuotePayload(input) {
    const value = exactObject(input, ["id", "english_quote", "dzongkha_quote"], "Admin quote mutation");
    const englishQuote = cleanText(value.english_quote, "English quote", { min: 0, max: 4000 });
    const dzongkhaQuote = cleanText(value.dzongkha_quote, "Dzongkha quote", { min: 0, max: 4000 });
    if (!englishQuote && !dzongkhaQuote) {
        throw validationError("empty_quote", "Enter an English quote, a Dzongkha quote, or both.");
    }
    return {
        id: optionalSupabaseRowId(value.id, "Quote ID"),
        english_quote: englishQuote,
        dzongkha_quote: dzongkhaQuote
    };
}

export function validateAdminPEResourcePayload(input) {
    const value = exactObject(
        input,
        ["id", "kind", "title", "content", "practice_prompt", "practice_answer", "document_url", "preview_url", "published", "sort_order"],
        "PE resource mutation"
    );
    const documentUrl = value.document_url === undefined || value.document_url === null || value.document_url === ""
        ? ""
        : cleanText(String(value.document_url), "Document", { min: 5, max: 9 * 1024 * 1024 });
    const previewUrl = value.preview_url === undefined || value.preview_url === null || value.preview_url === ""
        ? ""
        : validateMediaReference(value.preview_url, "Preview image", "image");
    if (documentUrl
        && !/^data:application\/pdf;base64,/i.test(documentUrl)
        && !/^data:image\/(?:jpeg|png|webp);base64,/i.test(documentUrl)
        && !/^https:\/\/[^\s]+$/i.test(documentUrl)) {
        throw validationError("invalid_document", "Document must be a PDF or image upload, or a trusted Storage URL.");
    }
    const sortOrder = Number(value.sort_order ?? 0);
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) {
        throw validationError("invalid_sort_order", "Sort order must be a whole number between 0 and 100000.");
    }
    return {
        id: optionalSupabaseRowId(value.id, "PE resource ID"),
        kind: requiredEnum(value.kind, ["formula", "guide"], "Resource type"),
        title: cleanText(value.title, "Title", { min: 1, max: 160 }),
        content: cleanText(String(value.content ?? ""), "Content", { min: 0, max: 30000 }),
        practice_prompt: cleanText(String(value.practice_prompt ?? ""), "Practice prompt", { min: 0, max: 1000 }),
        practice_answer: cleanText(String(value.practice_answer ?? ""), "Practice answer", { min: 0, max: 500 }),
        document_url: documentUrl,
        preview_url: previewUrl,
        published: Boolean(value.published),
        sort_order: sortOrder
    };
}
