// ─── CONFIG ──────────────────────────────────────────
// All database access is routed through same-origin Cloudflare API functions.
// Supabase secrets and privileged credentials never belong in this file.
const ALPHA = ["A","B","C","D"];
const DB_TIMEOUT_MS = 60000;
const API_TIMEOUT_MS = 20000;
const DB_CACHE_KEY = "supabase_exam_catalog_v3_counts_only";
const SECONDS_PER_QUESTION = 30;
const PE_BCSC_MAIN_TYPE = "BCSC(main)";

// ─── STATE ───────────────────────────────────────────
let questionPool = [];
let categories   = [];
let activeData   = [];
let responses    = [];
let currentIdx   = 0;
let timeLeft     = 0;
let timerInterval= null;
let databaseReady = false;
let databaseLoading = false;
let databaseLoadPromise = null;
let examCatalogReady = false;
let examCategoryCounts = new Map();
let setupContinued = false;
let examPreparing = false;
let dailyQuotes = [];
let dailyQuoteTickerIndex = 0;
let dailyQuoteExpiryTimer = null;
let activeCategoryLabel = null; // overrides category-select value when set (e.g. PE Online Test)
let audioQuestionTimer = null;  // tracks the 30s countdown for the current audio question
let activeExamSessionId = "";
let activeExamTotal = 0;
let normalExamMode = false;
let peOnlineMode = false;
let peOnlineCatalog = {
    counts: { "Past Paper": 0, "Data Interpretation": 0, "Current Affairs": 0 },
    total: 0
};
let questionMediaCache = new Map();
let categoryMediaPrefetch = { category: "", promise: null };
let peOnlineMediaPrefetchPromise = null;
let peTopicMediaPrefetch = new Map();
let peDIGraphPrefetch = new Map();
let peDIGraphFingerprintCache = new Map();
let publicApiCache = new Map();
let peQuestionsCache = [];
let peTopicBuckets = new Map();
let peTopicQuestionCache = new Map();
let peOverviewCatalog = [];
let peResourcesCatalog = [];
let peHomeDashboardLoadPromise = null;
let peActiveResourceTab = "formula";
let peGuideCarouselIndex = 0;
let peGuideCarouselTimer = null;
let cafStateLoaded = false;
let cafStatePromise = null;
let submitInProgress = false;
const QUESTION_PREFETCH_AHEAD = 5;

function bindStaticUiEvents() {
    document.getElementById("contact-modal")?.addEventListener("click", handleContactBackdropClick);
    document.getElementById("contact-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        submitContactForm();
    });
    document.getElementById("contact-modal-close-btn")?.addEventListener("click", closeContactModal);

    document.getElementById("theme-toggle-btn")?.addEventListener("click", toggleThemeMode);
    document.getElementById("contact-btn")?.addEventListener("click", openContactModal);
    document.getElementById("pe-btn")?.addEventListener("click", openPEPortal);
    document.getElementById("pe-back-btn")?.addEventListener("click", closePEPortal);

    document.getElementById("student-name")?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") startExam();
    });
    document.getElementById("category-select")?.addEventListener("change", handleCategorySelectionChange);
    document.getElementById("start-btn")?.addEventListener("click", startExam);
    document.getElementById("normal-sidebar-submit-btn")?.addEventListener("click", submitExam);

    document.getElementById("peo-btn-prev")?.addEventListener("click", () => { void peoNavigateBack(); });
    document.getElementById("peo-submit-btn")?.addEventListener("click", peoSubmitOnlineTest);
    document.getElementById("pe-return-online-btn")?.addEventListener("click", returnToPEOnlineTestPage);
    document.getElementById("results-return-home-btn")?.addEventListener("click", retakeExam);

    document.getElementById("pe-home-search")?.addEventListener("input", renderPEHomeGrid);
    document.getElementById("pe-home-panel")?.addEventListener("click", handlePEHomeDashboardClick);
    document.getElementById("pe-home-panel")?.addEventListener("paste", handlePESelfNotePaste);
    document.getElementById("caf-bhutan-box")?.addEventListener("click", () => cafSelectRegion("Bhutan"));
    document.getElementById("caf-intl-box")?.addEventListener("click", () => cafSelectRegion("International"));
    document.getElementById("caf-category-dropdown")?.addEventListener("change", () => cafFilterData());
    document.getElementById("caf-slide-left")?.addEventListener("click", () => cafChangePage(-1));
    document.getElementById("caf-slide-right")?.addEventListener("click", () => cafChangePage(1));
    document.getElementById("pe-mock-search")?.addEventListener("input", renderPEMockGrid);
    document.getElementById("pe-past-search")?.addEventListener("input", renderPEPastGrid);
    document.getElementById("pe-di-search")?.addEventListener("input", renderPEDIGrid);
    document.getElementById("pe-online-start-btn")?.addEventListener("click", startPEOnlineTest);
    document.getElementById("pe-question-back-btn")?.addEventListener("click", showPEFolderScreen);
    document.getElementById("pe-di-back-btn")?.addEventListener("click", closePEDIViewer);
    bindImageZoomEvents();
}

const IMAGE_ZOOM_SELECTOR = [
    "#pe-di-chart-img",
    "#peo-graph-img",
    ".q-image",
    ".pe-question-image"
].join(",");
let imageZoomLastTap = { target: null, time: 0 };

function bindImageZoomEvents() {
    document.addEventListener("dblclick", handleImageZoomRequest);
    document.addEventListener("click", handleImageZoomTap);
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeImageZoom();
    });
}

function getZoomableImage(target) {
    const image = target?.closest?.(IMAGE_ZOOM_SELECTOR);
    if (!image || !image.getAttribute("src")) return null;
    return image;
}

function handleImageZoomRequest(event) {
    const image = getZoomableImage(event.target);
    if (!image) return;
    event.preventDefault();
    event.stopPropagation();
    openImageZoom(image);
}

function handleImageZoomTap(event) {
    if (event.target.closest?.(".image-zoom-overlay")) {
        closeImageZoom();
        return;
    }

    const image = getZoomableImage(event.target);
    if (!image) return;

    const now = Date.now();
    if (imageZoomLastTap.target === image && now - imageZoomLastTap.time < 320) {
        event.preventDefault();
        event.stopPropagation();
        imageZoomLastTap = { target: null, time: 0 };
        openImageZoom(image);
        return;
    }

    imageZoomLastTap = { target: image, time: now };
}

function openImageZoom(sourceImage) {
    const source = sourceImage.currentSrc || sourceImage.src || sourceImage.getAttribute("src");
    if (!source) return;

    closeImageZoom();

    const overlay = document.createElement("div");
    overlay.className = "image-zoom-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Zoomed image");

    const image = document.createElement("img");
    image.className = "image-zoom-img";
    image.src = source;
    image.alt = sourceImage.alt || "Zoomed image";
    image.decoding = "async";

    overlay.appendChild(image);
    document.body.appendChild(overlay);
    document.body.classList.add("image-zoom-open");
}

function closeImageZoom() {
    document.querySelector(".image-zoom-overlay")?.remove();
    document.body.classList.remove("image-zoom-open");
}

		// ─── INIT ────────────────────────────────────────────
	if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initializeApp, { once: true });
    } else {
        initializeApp();
    }

    function loadDeferredVisualStyles() {
        requestAnimationFrame(() => {
            ["google-fonts-stylesheet", "bootstrap-icons-stylesheet"].forEach(id => {
                const stylesheet = document.getElementById(id);
                if (stylesheet) stylesheet.media = "all";
            });
        });
    }

	async function initializeApp() {
	    showLoading(false);
        loadDeferredVisualStyles();
        localStorage.removeItem("exam_theme_mode");
        applyThemeMode("light");
        bindStaticUiEvents();
        const copyrightEl = document.getElementById("site-copyright");
        if (copyrightEl) copyrightEl.textContent = `© ${new Date().getFullYear()}`;
        renderDailyQuoteTicker();
        warmPublicStartupData();
        setEntryActionButtons();
	    document.getElementById("student-name").focus();
	}

    function warmPublicStartupData() {
        const kickOff = () => {
            const lightweightLoads = [
                loadDailyQuotes({ fresh: true }).then(renderDailyQuoteTicker),
                caLoadState({ render: false }),
                loadExamCatalog(),
                loadPEOnlineQuestionBank().then(updatePEOnlineCount)
            ];
            Promise.allSettled(lightweightLoads).then(() => {
                // Load only the PE practice catalog after the small startup
                // requests; individual topics fetch their questions on click.
                setTimeout(() => loadDatabase({ silent: true }).catch(() => {}), 120);
            });
        };
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => setTimeout(kickOff, 0));
        } else {
            setTimeout(kickOff, 0);
        }
    }

    function applyThemeMode(mode) {
        const useDark = mode === "dark";
        document.documentElement.classList.add("theme-switch-instant");
        document.body.classList.toggle("dark-theme", useDark);
        const btn = document.getElementById("theme-toggle-btn");
        if (btn) btn.textContent = useDark ? "☀ Light" : "🌙 Dark";
        void document.body.offsetWidth;
        requestAnimationFrame(() => document.documentElement.classList.remove("theme-switch-instant"));
    }

    function toggleThemeMode() {
        const nextMode = document.body.classList.contains("dark-theme") ? "light" : "dark";
        applyThemeMode(nextMode);
    }


	function shuffleArray(items) {
	    const copy = [...items];
	    for (let i = copy.length - 1; i > 0; i--) {
	        const j = Math.floor(Math.random() * (i + 1));
	        [copy[i], copy[j]] = [copy[j], copy[i]];
	    }
	    return copy;
	}

    function escapeHTML(value) {
        return String(value ?? "").replace(/[&<>"']/g, char => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[char]);
    }

    function safeMediaURL(value, mediaType) {
        const source = String(value || "").trim();
        const allowedDataPrefix = mediaType === "audio" ? "data:audio/" : "data:image/";
        if (source.startsWith(allowedDataPrefix) || source.startsWith("https://") || source.startsWith("blob:")) {
            return source;
        }
        return "";
    }

    function safeMediaSource(value, mediaType) {
        return escapeHTML(safeMediaURL(value, mediaType));
    }

	// ─── PE CATEGORY ENCODING HELPERS ──────────────────
	// PE questions are stored using the existing `category` column with a
	// special prefix so NO new Supabase columns are required and the normal
	// exam question flow is never touched or put at risk.
	// Format: "__PE__::<BCSC(main)|Past Paper|Data Interpretation>::<Topic Name>"
	function isPECategory(cat) {
	    return typeof cat === "string" && cat.startsWith("__PE__::");
	}

	function parsePECategory(cat) {
	    if (!isPECategory(cat)) return null;
	    const parts = cat.split("::");
        const rawType = parts[1] || PE_BCSC_MAIN_TYPE;
	    return {
	        peType: rawType === "Mock" ? PE_BCSC_MAIN_TYPE : rawType,
	        topic: parts[2] || "General"
	    };
	}

	function parseCorrectAnswer(value) {
	    const normalized = String(value || "").trim().toUpperCase();
	    if (ALPHA.includes(normalized)) return ALPHA.indexOf(normalized);
	    const numeric = parseInt(normalized, 10);
	    if (numeric >= 1 && numeric <= 4) return numeric - 1;
	    if (numeric >= 0 && numeric <= 3) return numeric;
	    return -1;
	}

	function randomizePEPracticeQuestionSet(questions, { shuffleQuestions = true } = {}) {
	    const orderedQuestions = shuffleQuestions ? shuffleArray(questions) : [...questions];
	    return orderedQuestions.map(question => {
	        const optionItems = (Array.isArray(question.options) ? question.options : [])
	            .slice(0, 4)
	            .map((text, originalIndex) => ({ text, originalIndex }));
	        const shuffledOptions = shuffleArray(optionItems);
	        return {
	            ...question,
	            options: shuffledOptions.map(item => item.text),
	            _optionOriginalIndexes: shuffledOptions.map(item => item.originalIndex),
	            _peRandomSort: Math.random()
	        };
	    });
	}

// ─── LOADING ─────────────────────────────────────────
function showLoading(on, msg = "Loading…") {
    const el = document.getElementById("loading-overlay");
    document.getElementById("loading-text").textContent = msg;
    el.classList.toggle("hidden", !on);
}

// ─── TOAST ───────────────────────────────────────────
let toastTimer;
function showToast(msg, type = "info") {
    const t = document.getElementById("toast");
    const icons = { success: "✓", error: "✕", info: "ℹ" };
    t.className = `toast ${type} show`;
    const icon = document.createElement("span");
    const message = document.createElement("span");
    icon.textContent = icons[type] || icons.info;
    message.textContent = String(msg || "");
    t.replaceChildren(icon, message);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

function setEntryActionButtons() {
    const contactBtn = document.getElementById("contact-btn");
    const peBtn = document.getElementById("pe-btn");
    const themeBtn = document.getElementById("theme-toggle-btn");
    if (themeBtn) themeBtn.style.display = "inline-flex";
    if (contactBtn) contactBtn.style.display = "block";
    if (peBtn) peBtn.style.display = "none";
}

function setPostContinueActionButtons() {
    const contactBtn = document.getElementById("contact-btn");
    const peBtn = document.getElementById("pe-btn");
    const themeBtn = document.getElementById("theme-toggle-btn");
    if (themeBtn) themeBtn.style.display = "inline-flex";
    if (contactBtn) contactBtn.style.display = "none";
    if (peBtn) peBtn.style.display = "block";
}

function hideTopActionButtons() {
    const contactBtn = document.getElementById("contact-btn");
    const peBtn = document.getElementById("pe-btn");
    const themeBtn = document.getElementById("theme-toggle-btn");
    if (themeBtn) themeBtn.style.display = "none";
    if (contactBtn) contactBtn.style.display = "none";
    if (peBtn) peBtn.style.display = "none";
}

// ─── DATABASE ─+────────────────────────────────────────
function setLoaderProgress(pct) {
    const bar = document.getElementById("loader-progress");
    if (bar) bar.style.width = pct + "%";
}

function saveDatabaseCache(data) {
    const serialized = JSON.stringify(data);
    try { sessionStorage.setItem(DB_CACHE_KEY, serialized); } catch (e) {}
    try { localStorage.setItem(DB_CACHE_KEY, serialized); } catch (e) {}
}

function clearDatabaseCache() {
    try { sessionStorage.removeItem(DB_CACHE_KEY); } catch (e) {}
    try { localStorage.removeItem(DB_CACHE_KEY); } catch (e) {}
    questionMediaCache = new Map();
    categoryMediaPrefetch = { category: "", promise: null };
    peOnlineMediaPrefetchPromise = null;
    peTopicMediaPrefetch = new Map();
    peDIGraphPrefetch = new Map();
    peDIGraphFingerprintCache = new Map();
    peTopicQuestionCache = new Map();
    clearPublicApiCache();
}

async function apiRequest(path, { method = "GET", body, headers = {} } = {}) {
    const normalizedMethod = String(method || "GET").toUpperCase();
    if (normalizedMethod === "GET") {
        const ttlMs = getPublicApiCacheTTL(path);
        if (ttlMs > 0) {
            const now = Date.now();
            const cached = publicApiCache.get(path);
            if (cached?.data !== undefined && cached.expiresAt > now) {
                return cached.data;
            }
            if (cached?.promise) return cached.promise;
            const pending = fetchApiJson(path, { method: normalizedMethod, body, headers })
                .then(data => {
                    publicApiCache.set(path, { data, expiresAt: Date.now() + ttlMs, promise: null });
                    return data;
                })
                .catch(error => {
                    publicApiCache.delete(path);
                    throw error;
                });
            publicApiCache.set(path, { data: undefined, expiresAt: 0, promise: pending });
            return pending;
        }
    } else {
        clearPublicApiCache();
    }

    return fetchApiJson(path, { method: normalizedMethod, body, headers });
}

async function fetchApiJson(path, { method = "GET", body, headers = {} } = {}) {
    const requestHeaders = { ...headers };
    if (body) requestHeaders["Content-Type"] = "application/json";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    let response;
    try {
        response = await fetch(`/api/${path}`, {
            method,
            headers: Object.keys(requestHeaders).length ? requestHeaders : undefined,
            body: body ? JSON.stringify(body) : undefined,
            credentials: "same-origin",
            signal: controller.signal
        });
    } catch (error) {
        if (controller.signal.aborted) {
            const timeoutError = new Error("The server took too long to respond. Please try again.");
            timeoutError.code = "request_timeout";
            timeoutError.status = 504;
            throw timeoutError;
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }

    const data = await response.json().catch(() => null);
    if (!response.ok) {
        const error = new Error(data?.error?.message || `Request failed (${response.status})`);
        error.code = data?.error?.code || "request_failed";
        error.status = response.status;
        throw error;
    }
    return data;
}


function getPublicApiCacheTTL(path) {
    if (path === "questions?view=catalog") return 5 * 60 * 1000;
    if (path === "questions?view=pe-catalog") return 5 * 60 * 1000;
    if (path === "pe-online-questions?view=catalog") return 5 * 60 * 1000;
    if (path === "pe-online-questions?view=all-media") return 10 * 60 * 1000;
    if (path === "flashcards") return 60 * 1000;
    if (path === "quotes") return 60 * 1000;
    if (path.startsWith("questions?view=media&ids=")) return 10 * 60 * 1000;
    if (path.startsWith("questions?view=category-media&category=")) return 10 * 60 * 1000;
    if (path.startsWith("pe-online-questions?view=media&ids=")) return 10 * 60 * 1000;
    return 0;
}

function clearPublicApiCache() {
    publicApiCache = new Map();
}

// ─── EXPLANATION ENCODING ──────────────────────────────
// Explanations are embedded directly inside the existing `question` text
// column using a hidden delimiter, so NO new Supabase column is required.
// This guarantees question saving keeps working even if the database
// schema was never updated with an `explanation` field.
const EXPLANATION_DELIM = "\n§§EXPLAIN§§\n";
const QUESTION_META_DELIM = "\n§§QUESTION_META§§\n";

function decodeQuestionWithExplanation(rawQuestion) {
    const text = String(rawQuestion || "");
    const explanationIndex = text.indexOf(EXPLANATION_DELIM);
    const content = explanationIndex === -1 ? text : text.slice(0, explanationIndex);
    const metaIndex = content.indexOf(QUESTION_META_DELIM);
    let metadata = {};
    if (metaIndex !== -1) {
        try { metadata = JSON.parse(content.slice(metaIndex + QUESTION_META_DELIM.length)); } catch (error) {}
    }
    return {
        question: metaIndex === -1 ? content : content.slice(0, metaIndex),
        explanation: explanationIndex === -1 ? "" : text.slice(explanationIndex + EXPLANATION_DELIM.length),
        answerType: metadata?.answer_type === "written" ? "written" : "multiple_choice",
        writtenAnswer: metadata?.answer_type === "written" ? String(metadata.written_answer || "") : ""
    };
}

function mapExamRows(rows, sourceTable = "Exam") {
    return (rows || []).map(row => {
        const { question, explanation, answerType, writtenAnswer } = decodeQuestionWithExplanation(row.question);
        return {
            id: row.id,
            sourceTable,
            category: row.category,
            question,
            explanation,
            answerType: row.answer_type === "written" ? "written" : answerType,
            writtenAnswer,
            options: [row.optionA, row.optionB, row.optionC, row.optionD],
            answer: parseCorrectAnswer(row.answer),
            imageCode: row.image || "",
            audioCode: row.audio || ""
        };
    });
}

function mapSecureExamRows(rows) {
    return (rows || []).map(row => ({
        id: row.id,
        category: row.category,
        question: row.question || "",
        explanation: "",
        answerType: "multiple_choice",
        writtenAnswer: "",
        options: Array.isArray(row.options) ? row.options.slice(0, 4) : [],
        answer: -1,
        imageCode: "",
        audioCode: ""
    }));
}

async function fetchQuestions() {
    const rows = await apiRequest("questions?view=pe-catalog");
    return (rows || []).map(row => ({
        peType: String(row.peType || ""),
        topic: String(row.topic || ""),
        count: Number(row.count || 0)
    })).filter(row => row.peType && row.topic && row.count > 0);
}

async function fetchPEPracticeTopicQuestions(peType, topic) {
    const path = `questions?view=pe-practice&pe_type=${encodeURIComponent(peType)}&topic=${encodeURIComponent(topic)}`;
    return randomizePEPracticeQuestionSet(mapExamRows(await apiRequest(path)), {
        shuffleQuestions: peType !== "Data Interpretation"
    });
}


async function loadExamCatalog() {
    const rows = await apiRequest("questions?view=catalog");
    examCategoryCounts = new Map((rows || []).map(row => [row.category, Number(row.count || 0)]));
    categories = [...examCategoryCounts.keys()];
    examCatalogReady = categories.length > 0;
    updateCategorySelects();
    const total = [...examCategoryCounts.values()].reduce((sum, count) => sum + count, 0);
    const btn = document.getElementById("start-btn");
    btn.disabled = !examCatalogReady;
    btn.innerHTML = examCatalogReady
        ? `<span>${setupContinued ? "Begin Examination" : "Continue"}</span> →`
        : "No Questions Available";
    return examCatalogReady;
}

async function startSecureNormalExam(category) {
    activeExamSessionId = "";
    activeExamTotal = 0;
    const response = await apiRequest("exam-start", { method: "POST", body: { category } });
    if (!response || typeof response.session_id !== "string" || !Array.isArray(response.questions) || !response.questions.length) {
        throw new Error("The server returned an incomplete exam session. Please redeploy the latest API files.");
    }
    activeExamSessionId = response.session_id;
    activeExamTotal = Number(response.total || 0);
    return {
        total: activeExamTotal,
        questions: mapSecureExamWindowRows(response.questions)
    };
}

function mapSecureExamWindowRows(rows) {
    return (rows || [])
        .map(entry => {
            const index = Number(entry?.index);
            if (!Number.isInteger(index) || index < 0 || !entry?.question) return null;
            const mapped = mapSecureExamRows([entry.question])[0];
            if (!mapped) return null;
            return { index, question: mapped };
        })
        .filter(Boolean);
}

function seedNormalExamQuestions(total, rows) {
    activeData = new Array(total).fill(null);
    for (const entry of rows || []) {
        if (entry && Number.isInteger(entry.index) && entry.index >= 0 && entry.index < total) {
            activeData[entry.index] = entry.question;
        }
    }
}

function mergeNormalExamWindow(rows) {
    for (const entry of rows || []) {
        if (entry && Number.isInteger(entry.index) && entry.index >= 0 && entry.index < activeData.length) {
            activeData[entry.index] = entry.question;
        }
    }
}

async function fetchNormalExamQuestionWindow(index) {
    const response = await apiRequest(
        `exam-question?session_id=${encodeURIComponent(activeExamSessionId)}&index=${encodeURIComponent(index)}`
    );
    if (!response || !Array.isArray(response.questions)) {
        throw new Error("The server returned an incomplete question window.");
    }
    const mapped = mapSecureExamWindowRows(response.questions);
    mergeNormalExamWindow(mapped);
    return mapped;
}

async function ensureNormalExamQuestionLoaded(index) {
    if (!normalExamMode || activeData[index]) return activeData[index];
    await fetchNormalExamQuestionWindow(index);
    if (activeData[index]) {
        await fetchSelectedQuestionMedia([activeData[index]]);
    }
    return activeData[index];
}

async function prefetchNormalExamQuestion(index) {
    if (!normalExamMode || index < 0 || index >= activeData.length || activeData[index]) return;
    try {
        const rows = await fetchNormalExamQuestionWindow(index);
        const warmable = rows.map(entry => entry.question).filter(Boolean);
        if (warmable.length) {
            await fetchSelectedQuestionMedia(warmable);
            await warmQuestionAssets(warmable, { reportProgress: false });
        }
    } catch (error) {
        console.error("Normal exam prefetch failed:", error);
    }
}

async function startSecurePEOnlineExam() {
    activeExamSessionId = "";
    activeExamTotal = 0;
    const response = await apiRequest("pe-online-start", { method: "POST", body: {} });
    if (!response || typeof response.session_id !== "string" || !Array.isArray(response.questions) || !response.questions.length) {
        throw new Error("The server returned an incomplete PE Online session. Please redeploy the latest API files.");
    }
    activeExamSessionId = response.session_id;
    activeExamTotal = Number(response.total || 0);
    return {
        total: activeExamTotal,
        questions: mapSecureExamWindowRows(response.questions)
    };
}

async function fetchPEOnlineQuestionWindow(index) {
    const response = await apiRequest(
        `pe-online-question?session_id=${encodeURIComponent(activeExamSessionId)}&index=${encodeURIComponent(index)}`
    );
    if (!response || !Array.isArray(response.questions)) {
        throw new Error("The server returned an incomplete PE Online question window.");
    }
    const mapped = mapSecureExamWindowRows(response.questions);
    mergeNormalExamWindow(mapped);
    return mapped;
}

async function ensurePEOnlineQuestionLoaded(index) {
    if (!peOnlineMode) return activeData[index];
    if (!activeData[index]) {
        await fetchPEOnlineQuestionWindow(index);
    }
    if (activeData[index]) {
        await fetchSelectedQuestionMedia([activeData[index]]);
    }
    return activeData[index];
}

async function prefetchPEOnlineQuestion(index) {
    if (!peOnlineMode || index < 0 || index >= activeData.length) return;
    try {
        let warmable = [];
        if (activeData[index]) {
            warmable = [activeData[index]];
        } else {
            const rows = await fetchPEOnlineQuestionWindow(index);
            warmable = rows.map(entry => entry.question).filter(Boolean);
        }
        if (warmable.length) {
            await fetchSelectedQuestionMedia(warmable);
            await warmQuestionAssets(warmable, { reportProgress: false });
        }
    } catch (error) {
        console.error("PE Online prefetch failed:", error);
    }
}

function mergeMediaRowsIntoQuestions(questions, mediaRows) {
    // Supabase commonly serializes bigint IDs as numbers, while secure exam
    // IDs are strings. Normalize both sides or valid media silently misses.
    const mediaById = new Map((mediaRows || []).map(r => [String(r.id), r]));
    let changed = false;
    (questions || []).forEach(q => {
        const media = mediaById.get(String(q.id));
        if (!media) return;
        if (typeof media.image === "string" && q.imageCode !== media.image) {
            q.imageCode = media.image;
            changed = true;
        }
        if (typeof media.audio === "string" && q.audioCode !== media.audio) {
            q.audioCode = media.audio;
            changed = true;
        }
    });
    return changed;
}

function cacheMediaRows(mediaRows) {
    (mediaRows || []).forEach(row => {
        const id = String(row?.id || "").trim();
        if (!id) return;
        const current = questionMediaCache.get(id) || { id, image: "", audio: "" };
        questionMediaCache.set(id, {
            id,
            image: typeof row.image === "string" ? row.image : current.image,
            audio: typeof row.audio === "string" ? row.audio : current.audio
        });
    });
}

function getCachedMediaRows(ids) {
    return ids
        .map(id => questionMediaCache.get(String(id)))
        .filter(Boolean);
}

function collectQuestionMediaIds(questions, matcher) {
    return [...new Set((questions || [])
        .map(q => String(q.id || ""))
        .filter(id => matcher.test(id)))];
}

async function fetchSelectedQuestionMedia(questions, { persistCache = true } = {}) {
    const mediaRows = [];
    const normalIds = collectQuestionMediaIds(questions, /^\d+$/);
    const peOnlinePrefixedIds = collectQuestionMediaIds(questions, /^peo:\d+$/);

    const cachedNormalRows = getCachedMediaRows(normalIds);
    const cachedPEOnlineRows = getCachedMediaRows(peOnlinePrefixedIds);
    if (cachedNormalRows.length) mediaRows.push(...cachedNormalRows);
    if (cachedPEOnlineRows.length) mediaRows.push(...cachedPEOnlineRows);

    const missingNormalIds = normalIds.filter(id => !questionMediaCache.has(id));
    const missingPEOnlineIds = peOnlinePrefixedIds
        .filter(id => !questionMediaCache.has(id))
        .map(id => id.slice(4));

    for (let i = 0; i < missingNormalIds.length; i += 80) {
        const chunk = missingNormalIds.slice(i, i + 80);
        const rows = await apiRequest(`questions?view=media&ids=${encodeURIComponent(chunk.join(","))}`);
        if (Array.isArray(rows)) mediaRows.push(...rows);
    }
    for (let i = 0; i < missingPEOnlineIds.length; i += 80) {
        const chunk = missingPEOnlineIds.slice(i, i + 80);
        const rows = await apiRequest(`pe-online-questions?view=media&ids=${encodeURIComponent(chunk.join(","))}`);
        if (Array.isArray(rows)) mediaRows.push(...rows);
    }
    if (!mediaRows.length) return;
    cacheMediaRows(mediaRows);
    mergeMediaRowsIntoQuestions(questionPool, mediaRows);
    mergeMediaRowsIntoQuestions(questions, mediaRows);
    if (persistCache) saveDatabaseCache(questionPool);
}

function preloadImageAsset(src) {
    return new Promise(resolve => {
        if (!src) { resolve(); return; }
        const img = new Image();
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        img.onload = () => {
            if (img.decode) img.decode().catch(() => {}).finally(finish);
            else finish();
        };
        img.onerror = finish;
        img.src = src;
        setTimeout(finish, 6000);
    });
}

function preloadAudioAsset(src) {
    return new Promise(resolve => {
        if (!src) { resolve(); return; }
        const audio = new Audio();
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            audio.onloadedmetadata = null;
            audio.oncanplaythrough = null;
            audio.onerror = null;
            resolve();
        };
        audio.preload = "auto";
        audio.onloadedmetadata = finish;
        audio.oncanplaythrough = finish;
        audio.onerror = finish;
        audio.src = src;
        audio.load();
        setTimeout(finish, 6000);
    });
}

async function warmQuestionAssets(questions, { reportProgress = true } = {}) {
    const assets = [];
    (questions || []).forEach(q => {
        if (q.imageCode) assets.push(() => preloadImageAsset(q.imageCode));
        if (q.audioCode) assets.push(() => preloadAudioAsset(q.audioCode));
    });
    if (!assets.length) return;

    const total = assets.length;
    for (let i = 0; i < total; i += 4) {
        await Promise.allSettled(assets.slice(i, i + 4).map(load => load()));
        if (reportProgress) {
            setLoaderProgress(Math.min(95, 45 + Math.round(((i + 4) / total) * 45)));
        }
    }
}

async function warmMediaRows(mediaRows) {
    const warmable = (mediaRows || []).map(row => ({
        imageCode: typeof row.image === "string" ? row.image : "",
        audioCode: typeof row.audio === "string" ? row.audio : ""
    }));
    await warmQuestionAssets(warmable, { reportProgress: false });
}

async function prefetchCategoryMedia(category, { blockForMs = 0 } = {}) {
    const normalizedCategory = String(category || "").trim();
    if (!normalizedCategory) return;

    if (categoryMediaPrefetch.category !== normalizedCategory || !categoryMediaPrefetch.promise) {
        categoryMediaPrefetch = {
            category: normalizedCategory,
            promise: (async () => {
                const rows = await apiRequest(`questions?view=category-media&category=${encodeURIComponent(normalizedCategory)}`);
                if (!Array.isArray(rows) || !rows.length) return;
                cacheMediaRows(rows);
                await warmMediaRows(rows.filter(row => row.image || row.audio));
            })().catch(error => {
                console.error("Category media prefetch failed:", error);
            })
        };
    }

    if (blockForMs > 0) {
        await Promise.race([
            categoryMediaPrefetch.promise,
            new Promise(resolve => setTimeout(resolve, blockForMs))
        ]);
    }
}

function prefetchPEOnlineMedia() {
    if (peOnlineMediaPrefetchPromise) return peOnlineMediaPrefetchPromise;
    peOnlineMediaPrefetchPromise = (async () => {
        const rows = await apiRequest("pe-online-questions?view=all-media");
        if (!Array.isArray(rows) || !rows.length) return;
        cacheMediaRows(rows);
    })().catch(error => {
        peOnlineMediaPrefetchPromise = null;
        console.error("PE Online media prefetch failed:", error);
    });
    return peOnlineMediaPrefetchPromise;
}

async function prepareExamAssetsBeforeTimer(questions, label = "Preparing exam media…") {
    let mediaLoaderVisible = false;
    const mediaLoaderDelay = setTimeout(() => {
        mediaLoaderVisible = true;
        showLoading(true, "Connecting...");
        setLoaderProgress(18);
    }, 450);

    try {
        await fetchSelectedQuestionMedia(questions);
        const hasMedia = (questions || []).some(q => q.imageCode || q.audioCode);
        clearTimeout(mediaLoaderDelay);
        if (!hasMedia) return;

        if (!mediaLoaderVisible) {
            mediaLoaderVisible = true;
            showLoading(true, "Connecting...");
            setLoaderProgress(18);
        }
        setLoaderProgress(45);
        await Promise.race([
            warmQuestionAssets(questions),
            new Promise(resolve => setTimeout(resolve, 12000))
        ]);
        setLoaderProgress(100);
    } catch (e) {
        clearTimeout(mediaLoaderDelay);
        console.error("Exam media preload failed:", e);
        showToast("Some media is slow. Starting with available files.", "info");
    } finally {
        clearTimeout(mediaLoaderDelay);
        if (mediaLoaderVisible) setTimeout(() => showLoading(false), 180);
    }
}

async function loadDatabase(options = {}) {
    const silent = Boolean(options.silent);
    if (databaseReady) return true;
    if (databaseLoadPromise) {
        if (!silent) showLoading(true, "Opening PE...");
        const loaded = await databaseLoadPromise;
        if (!silent) showLoading(false);
        return loaded;
    }
    databaseLoading = true;
    databaseLoadPromise = loadDatabaseOnce(silent).finally(() => {
        databaseLoading = false;
        databaseLoadPromise = null;
    });
    return databaseLoadPromise;
}

async function loadDatabaseOnce(silent) {

    // ── Cache-first: render instantly if we have data ──
    const cached = sessionStorage.getItem(DB_CACHE_KEY) || localStorage.getItem(DB_CACHE_KEY);
    if (cached) {
        try {
            processData(JSON.parse(cached));
            databaseReady = true;
            if (!examPreparing && !silent) showLoading(false);
            // Refresh in background silently (no spinner)
            fetchQuestions()
                .then(data => {
                    saveDatabaseCache(data);
                    processData(data);
                })
                .catch(() => {}); // silent background refresh failure is OK
            return true;
        } catch(e) {
            clearDatabaseCache();
        }
    }

    // ── First-time load with timeout + animated progress ──
    if (!silent) {
        showLoading(true, "Loading question database…");
        setLoaderProgress(10);
    }

    // Animate progress bar while waiting
    let prog = 10;
    const progInterval = setInterval(() => {
        prog = Math.min(prog + (Math.random() * 8 + 3), 85);
        if (!silent) setLoaderProgress(prog);
    }, 400);
    // Use Promise.race for timeout — AbortController causes DataCloneError in sandboxed iframes
    const fetchPromise = fetchQuestions();
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) =>
        timeoutId = setTimeout(() => reject(new Error("TIMEOUT")), DB_TIMEOUT_MS)
    );

    try {
        if (!silent) document.getElementById("loading-text").textContent = "Fetching questions…";
        const data = await Promise.race([fetchPromise, timeoutPromise]);
        clearTimeout(timeoutId);
        clearInterval(progInterval);
        if (!silent) setLoaderProgress(95);

        saveDatabaseCache(data);
        processData(data);
        databaseReady = true;

        if (!silent) {
            document.getElementById("loading-text").textContent = "Ready!";
            setLoaderProgress(100);
            setTimeout(() => {
                if (!examPreparing) showLoading(false);
            }, 300);
        }
        return true;

    } catch (e) {
        clearTimeout(timeoutId);
        clearInterval(progInterval);
        if (!silent) setLoaderProgress(0);
        if (e.message === "TIMEOUT") {
            const fallback = localStorage.getItem(DB_CACHE_KEY);
            if (fallback) {
                processData(JSON.parse(fallback));
                databaseReady = true;
                if (!silent) {
                    showToast("Using saved questions. Internet is slow.", "info");
                    showLoading(false);
                }
                return true;
            }
            if (!silent) {
                showToast("Database is taking too long. Please try again.", "error");
                document.getElementById("loading-text").textContent = "Database is taking too long.";
            }
        } else {
            if (!silent) {
                showToast("Failed to load question database.", "error");
                document.getElementById("loading-text").textContent = "Failed to connect.";
            }
        }
        console.error(e);
        if (!silent) setTimeout(() => showLoading(false), 1500);
        return false;
    }
}

function processData(data) {
    const rows = Array.isArray(data) ? data : [];
    const isCatalogOnly = rows.every(row => row && Object.hasOwn(row, "peType") && Object.hasOwn(row, "topic") && Object.hasOwn(row, "count"));
    questionPool = isCatalogOnly ? [] : rows;
    peQuestionsCache = isCatalogOnly ? [] : questionPool.filter(q => isPECategory(q.category));
    peTopicBuckets = new Map();
    const addPETopicBucket = (info, count = 1) => {
        const typeKey = info.peType;
        const allKey = `all::${info.topic}`;
        const typeTopicKey = `${typeKey}::${info.topic}`;
        if (!peTopicBuckets.has(allKey)) peTopicBuckets.set(allKey, { topic: info.topic, peType: typeKey, count: 0 });
        if (!peTopicBuckets.has(typeTopicKey)) peTopicBuckets.set(typeTopicKey, { topic: info.topic, peType: typeKey, count: 0 });
        peTopicBuckets.get(allKey).count += count;
        peTopicBuckets.get(typeTopicKey).count += count;
    };
    if (isCatalogOnly) {
        rows.forEach(row => addPETopicBucket({ peType: row.peType, topic: row.topic }, Number(row.count || 0)));
    } else {
        peQuestionsCache.forEach(q => {
            const info = parsePECategory(q.category);
            if (!info) return;
            addPETopicBucket(info);
        });
    }
    // Exam categories must exclude PE-tagged questions so the normal
    // exam flow (category select, start exam, counts) is unaffected.
    const examQuestions = questionPool.filter(q => !isPECategory(q.category));
    if (examQuestions.length) {
        categories = [...new Set(examQuestions.map(q => q.category).filter(Boolean))];
        examCategoryCounts = new Map(categories.map(category => [
            category,
            examQuestions.filter(question => question.category === category).length
        ]));
        examCatalogReady = categories.length > 0;
    }
    updateCategorySelects();
    const noData = categories.length === 0;
    const btn = document.getElementById("start-btn");
    btn.disabled = noData;
    if (noData) {
        btn.textContent = "No Questions Available";
    } else if (setupContinued) {
        btn.innerHTML = "<span>Begin Examination</span> →";
    } else {
        btn.innerHTML = "<span>Continue</span> →";
    }
    if (document.getElementById("pe-view") && document.getElementById("pe-view").style.display !== "none") {
        const activePanel = document.querySelector(".pe-content .pe-section.active")?.id;
        if (peActiveTopic) renderPEQuestionList();
        else if (peDIActiveSet) renderPEDIQuestion();
        else if (activePanel) renderPEPanel(activePanel);
    }
}

function updateCategorySelects() {
    ["category-select"].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        sel.innerHTML = categories.length === 0
            ? `<option>No categories available</option>`
            : categories.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join("");
    });
    updateTestSummary();
}

function getCategoryQuestionCount(category) {
    if (examCategoryCounts.has(category)) return examCategoryCounts.get(category);
    return questionPool.filter(q => q.category === category && !isPECategory(q.category)).length;
}

function getTestDurationSeconds(questionCount) {
    return Math.max(questionCount * SECONDS_PER_QUESTION, SECONDS_PER_QUESTION);
}

function formatDurationLabel(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (seconds === 0) return `${minutes} min`;
    return `${minutes} min ${seconds} sec`;
}

function updateTestSummary() {
    const select = document.getElementById("category-select");
    const summary = document.getElementById("time-question-summary");
    if (!select || !summary || !categories.length) {
        if (summary) summary.value = "-";
        return;
    }

    const questionCount = getCategoryQuestionCount(select.value);
    const durationSeconds = getTestDurationSeconds(questionCount);
    summary.value = `${formatDurationLabel(durationSeconds)} / ${questionCount} Q`;

}

function queueSelectedCategoryMediaPrefetch(options = {}) {
    if (!examCatalogReady) return;
    const select = document.getElementById("category-select");
    const category = String(select?.value || "").trim();
    if (!category) return;
    void prefetchCategoryMedia(category, options).catch(() => {});
}

function queuePEOnlineMediaPrefetch() {
    void Promise.resolve(prefetchPEOnlineMedia()).catch(() => {});
}

function getPETopicQuestions(peType, topic) {
    const key = getPETopicPrefetchKey(peType, topic);
    if (peTopicQuestionCache.has(key)) return peTopicQuestionCache.get(key);
    return getPEQuestions().filter(q => {
        const info = parsePECategory(q.category);
        return info.peType === peType && info.topic === topic;
    });
}

function getPETopicPrefetchKey(peType, topic) {
    return `${String(peType || "").trim()}::${String(topic || "").trim()}`;
}

async function prefetchPETopicMedia(peType, topic, { blockForMs = 0 } = {}) {
    if (peType === "Data Interpretation") return;

    const key = getPETopicPrefetchKey(peType, topic);
    if (!key) return;

    if (!peTopicMediaPrefetch.has(key)) {
        const topicQuestions = getPETopicQuestions(peType, topic);
        if (!topicQuestions.length) return;

        const warmable = topicQuestions.filter(q => q.imageCode || q.audioCode).slice(0, 3);
        const promise = (async () => {
            await fetchSelectedQuestionMedia(topicQuestions);
            if (warmable.length) {
                await warmQuestionAssets(warmable, { reportProgress: false });
            }
        })().catch(error => {
            peTopicMediaPrefetch.delete(key);
            console.error("PE topic media prefetch failed:", error);
        });

        peTopicMediaPrefetch.set(key, promise);
    }

    const existingPromise = peTopicMediaPrefetch.get(key);
    if (blockForMs > 0 && existingPromise) {
        await Promise.race([
            existingPromise,
            new Promise(resolve => setTimeout(resolve, blockForMs))
        ]);
    }
}

async function ensurePETopicQuestions(peType, topic, { force = false } = {}) {
    const key = getPETopicPrefetchKey(peType, topic);
    if (!force && peTopicQuestionCache.has(key)) return peTopicQuestionCache.get(key);
    const questions = await fetchPEPracticeTopicQuestions(peType, topic);
    peTopicQuestionCache.set(key, questions);
    return questions;
}

function clearPETopicQuestionsFromMemory(peType, topic) {
    const key = getPETopicPrefetchKey(peType, topic);
    peTopicQuestionCache.delete(key);
    peTopicMediaPrefetch.delete(key);
}

function clearActivePEPracticeMemory() {
    if (peGuideCarouselTimer) {
        clearInterval(peGuideCarouselTimer);
        peGuideCarouselTimer = null;
    }
    if (peActiveTopic) {
        clearPETopicQuestionsFromMemory(peActiveTopic.peType, peActiveTopic.topic);
    }
    if (peDIActiveSet) {
        clearPETopicQuestionsFromMemory("Data Interpretation", peDIActiveSet);
        peDIGraphPrefetch.delete(String(peDIActiveSet || "").trim());
    }
    pePracticeQuestionsByDomId.clear();
    const topicContainer = document.getElementById("pe-questions-container");
    const diContainer = document.getElementById("pe-di-questions-container");
    const diChart = document.getElementById("pe-di-chart-img");
    if (topicContainer) topicContainer.innerHTML = "";
    if (diContainer) diContainer.innerHTML = "";
    if (diChart) diChart.removeAttribute("src");
}

async function prefetchPEDISetGraph(setName, { blockForMs = 0 } = {}) {
    const normalizedSetName = String(setName || "").trim();
    if (!normalizedSetName) return;

    if (!peDIGraphPrefetch.has(normalizedSetName)) {
        const setQuestions = getPEDISetQuestions(normalizedSetName);
        if (!setQuestions.length) return;

        const promise = (async () => {
            // A reused set name can contain more than one chart. Fetch every
            // question's media so each newly uploaded chart can begin its own
            // group instead of silently inheriting the first chart forever.
            await fetchSelectedQuestionMedia(setQuestions, { persistCache: false });
            await preparePEDIGraphFingerprints(normalizedSetName);
            const graphSources = [...new Set(setQuestions
                .map(question => safeMediaURL(question.imageCode, "image"))
                .filter(Boolean))];
            if (graphSources[0]) await preloadImageAsset(graphSources[0]);
            graphSources.slice(1).forEach(source => {
                void preloadImageAsset(source);
            });
            const audioQuestions = setQuestions.filter(q => q.audioCode).slice(0, 2);
            if (audioQuestions.length) {
                await warmQuestionAssets(audioQuestions, { reportProgress: false });
            }
        })().catch(error => {
            peDIGraphPrefetch.delete(normalizedSetName);
            console.error("PE DI graph prefetch failed:", error);
        });

        peDIGraphPrefetch.set(normalizedSetName, promise);
    }

    const existingPromise = peDIGraphPrefetch.get(normalizedSetName);
    if (blockForMs > 0 && existingPromise) {
        await Promise.race([
            existingPromise,
            new Promise(resolve => setTimeout(resolve, blockForMs))
        ]);
    }
}

function handleCategorySelectionChange() {
    updateTestSummary();
    if (!setupContinued) return;
    queueSelectedCategoryMediaPrefetch();
}

// ─── EXAM START ───────────────────────────────────────
async function startExam() {
    if (examPreparing) return;
    const name = document.getElementById("student-name").value.trim();
    if (!name) { showToast("Please enter your full name.", "error"); return; }

    if (!examCatalogReady || !setupContinued) {
        examPreparing = true;
        showLoading(true, "Connecting...");
        setLoaderProgress(10);
        const btn = document.getElementById("start-btn");
        btn.disabled = true;
        const loaded = examCatalogReady || await loadExamCatalog();
        if (!loaded || !categories.length) {
            examPreparing = false;
            showLoading(false);
            btn.disabled = false;
            btn.innerHTML = "<span>Try Again</span> →";
            return;
        }
        try {
            showLoading(true, "Connecting...");
        } finally {
            setupContinued = true;
            document.getElementById("setup-options").style.display = "grid";
            btn.innerHTML = "<span>Begin Examination</span> →";
            btn.disabled = false;
            setPostContinueActionButtons();
            queueSelectedCategoryMediaPrefetch();
            document.getElementById("category-select").focus();
            examPreparing = false;
            showLoading(false);
        }
        return;
    }

	    const cat = document.getElementById("category-select").value;
	    activeCategoryLabel = null;
        normalExamMode = true;
        peOnlineMode = false;

    examPreparing = true;
    showLoading(true, "Connecting...");
    try {
        const session = await startSecureNormalExam(cat);
        if (!session.total || !session.questions.length) {
            throw new Error("The secure exam session did not include any questions.");
        }
        seedNormalExamQuestions(session.total, session.questions);
        const startupQuestions = session.questions.map(entry => entry.question).filter(Boolean);
        await prepareExamAssetsBeforeTimer(startupQuestions, "Preparing selected exam media…");
    } catch (error) {
        examPreparing = false;
        showLoading(false);
        normalExamMode = false;
        showToast(`Could not start secure exam: ${error.message}`, "error");
        return;
    }
    examPreparing = false;
    showLoading(false);

    responses  = new Array(activeData.length).fill(null);
    timeLeft   = getTestDurationSeconds(activeData.length);
    currentIdx = 0;
    document.getElementById("setup-view").style.display = "none";
    hideTopActionButtons();
    // Clear any leftover inline display:none from a prior PE portal visit —
    // inline styles override the .show class and would keep this hidden.
    document.getElementById("exam-view").style.display = "";
    document.getElementById("exam-view").classList.add("show");
    document.getElementById("timer-badge").classList.add("show");

    buildExam();
    startTimer();
}

function retakeExam() {
    clearInterval(timerInterval);
    if (audioQuestionTimer) { clearInterval(audioQuestionTimer); audioQuestionTimer = null; }
    document.querySelectorAll(".q-audio").forEach(el => el.pause());
    activeData = [];
    responses = [];
    currentIdx = 0;
    timeLeft = 0;
    activeCategoryLabel = null;
    activeExamSessionId = "";
    activeExamTotal = 0;
    normalExamMode = false;
    peOnlineMode = false;

    document.getElementById("results-view").classList.remove("show");
    document.getElementById("pe-return-online-btn") && (document.getElementById("pe-return-online-btn").style.display = "none");
    document.getElementById("exam-view").classList.remove("show");
    document.getElementById("exam-view").style.display = "";
    document.getElementById("peo-workspace") && (document.getElementById("peo-workspace").style.display = "none");
    document.getElementById("setup-view").style.display = "block";
    document.getElementById("setup-options").style.display = setupContinued ? "grid" : "none";
    if (setupContinued) setPostContinueActionButtons();
    else setEntryActionButtons();
    document.getElementById("timer-badge").classList.remove("show", "urgent");
    document.getElementById("timer-display").textContent = "--:--";
    document.getElementById("progress-fill").style.width = "0%";
    document.getElementById("score-ring-fill").style.strokeDashoffset = 345;
    document.getElementById("start-btn").innerHTML = "<span>Begin Examination</span> →";
    document.getElementById("start-btn").disabled = categories.length === 0;
    updateTestSummary();
    window.scrollTo({ top: 0, behavior: "auto" });
}

async function returnToPEOnlineTestPage() {
    const shouldReturnToPE = activeCategoryLabel === "PE Online Test";
    retakeExam();
    if (!shouldReturnToPE) return;

    await openPEPortal();
    const onlineItem = document.querySelector('[data-target="pe-online-panel"] a');
    if (onlineItem) onlineItem.onclick();
}

// ─── MOBILE OMR BUBBLE HANDLER ───────────────────────
function selectMobileBubble(questionIndex, optionIndex, element) {
    // Delegate entirely to omrSelect() — the single source of truth.
    // omrSelect handles: responses[] state, sidebar OMR fill, option highlight,
    // progress counters, AND auto-advance to next question.
    // DO NOT call matchingOptionItem.click() — options are .option-readonly
    // (pointer-events:none) so click() is a silent no-op that loses all state.
    void omrSelect(questionIndex, optionIndex);
}

// ─── BUILD EXAM UI ────────────────────────────────────
function buildExam() {
    //ADDED FOR SECURITY: Prevents right-click and copying shortcuts
    document.addEventListener('contextmenu', function(event) {
        event.preventDefault();
    });

    document.addEventListener('keydown', function(event) {
        if (event.ctrlKey || event.metaKey) {
            if (event.key === 'c' || event.key === 'C' || 
                event.key === 'u' || event.key === 'U' || 
                event.key === 's' || event.key === 'S') {
                event.preventDefault();
                alert("Copying and viewing page elements is disabled during the examination.");
            }
        }
        if (event.key === 'F12') {
            event.preventDefault();
        }
    });
    // END OF SECURITY INJECTION
    const qContainer   = document.getElementById("questions-container");
    const omrContainer = document.getElementById("omr-container");
    // OMR sidebar: clicking a bubble selects answer AND auto-advances
    omrContainer.innerHTML = activeData.map((_, i) => `
        <div class="omr-row ${i===0?'active':''}" id="omr-${i}">
            <span class="omr-q-label" data-nav-question="${i}">Q${i+1}</span>
            <div class="omr-bubbles">
                ${[0,1,2,3].map(oi => `<div class="omr-bubble" id="bbl-${i}-${oi}" data-omr-q="${i}" data-omr-opt="${oi}">${ALPHA[oi]}</div>`).join("")}
            </div>
            <div class="omr-status" id="omr-status-${i}"></div>
        </div>`).join("");

    omrContainer.querySelectorAll("[data-nav-question]").forEach((label) => {
        label.addEventListener("click", () => { void navigate(Number(label.dataset.navQuestion)); });
    });
    omrContainer.querySelectorAll("[data-omr-q]").forEach((bubble) => {
        bubble.addEventListener("click", () => {
            void omrSelect(Number(bubble.dataset.omrQ), Number(bubble.dataset.omrOpt));
        });
    });

    renderActiveNormalQuestion();
    refreshNormalOmrState();
    updateProgress();
    syncNormalSubmitVisibility();
    handleQuestionAudio(0); // autoplay/timer for the first question if it has audio
    void prefetchNormalExamQuestion(QUESTION_PREFETCH_AHEAD);
}

function renderActiveNormalQuestion() {
    const qContainer = document.getElementById("questions-container");
    const q = activeData[currentIdx];
    const cat = document.getElementById("category-select").value;
    let card = document.getElementById("normal-question-card");
    if (!card) {
        qContainer.innerHTML = `
            <div class="question-card active" id="normal-question-card">
                <div class="q-meta">
                    <span class="q-pill" id="normal-question-pill"></span>
                    <span class="q-category-tag" id="normal-question-category"></span>
                </div>
                <div id="normal-question-stage"></div>
                <div class="mobile-question-omr">
                    <div class="mobile-omr-title">Tap to save & go to next question</div>
                    <div class="mobile-omr-row">
                        <div class="mobile-omr-label" id="normal-mobile-label"></div>
                        <div class="mobile-omr-bubbles" id="normal-mobile-bubbles"></div>
                    </div>
                </div>
                <div class="nav-actions">
                    <button type="button" class="btn btn-outline" id="normal-prev-btn"><- Previous</button>
                    <div id="normal-nav-right"></div>
                </div>
            </div>`;
        card = document.getElementById("normal-question-card");
        document.getElementById("normal-prev-btn")?.addEventListener("click", () => {
            const idx = Number(document.getElementById("normal-prev-btn")?.dataset.navPrev || "-1");
            void navigate(idx);
        });
    }
    if (!q) {
        document.getElementById("normal-question-pill").textContent = `Question ${currentIdx + 1} / ${activeData.length}`;
        document.getElementById("normal-question-category").textContent = cat;
        document.getElementById("normal-question-stage").innerHTML = `<div class="q-text">Loading question...</div>`;
        return;
    }
    const imageSource = safeMediaSource(q.imageCode, "image");
    const audioSource = safeMediaSource(q.audioCode, "audio");
    const imgHtml = imageSource
        ? `<div class="q-image-wrap">
               <img src="${imageSource}" class="q-image" alt="Question image" loading="lazy" decoding="async">
           </div>`
        : "";
    const audioHtml = audioSource
        ? `<div class="q-audio-wrap">
               <audio id="audio-${currentIdx}" src="${audioSource}" class="q-audio" controls></audio>
               <div class="q-audio-timer is-hidden" id="audio-timer-${currentIdx}">⏱ <span id="audio-timer-val-${currentIdx}">30</span>s remaining</div>
           </div>`
        : "";
    const opts = q.options.map((o, oi) => `
        <div class="option-item option-readonly ${responses[currentIdx] === oi ? "selected" : ""}" id="opt-${currentIdx}-${oi}">
            <span class="option-alpha">${ALPHA[oi]}</span>
            <span>${escapeHTML(o)}</span>
        </div>`).join("");
    const navRight = `
        ${currentIdx === activeData.length - 1 ? "" : `<button type="button" class="btn btn-outline btn-nav-hint normal-submit-hint" disabled title="Tick answer on OMR sheet →">
              <span class="omr-hint-copy">← Mark answer on OMR sheet</span>
           </button>`}
        <button type="button" class="btn btn-green normal-submit-btn normal-inline-submit-btn is-hidden" data-submit-exam>Submit Exam ✓</button>
    `;
    const mobileOmrBubblesHtml = ALPHA.map((label, oi) => `
        <div class="omr-bubble ${responses[currentIdx] === oi ? "filled" : ""}"
             data-q="${currentIdx}"
             data-opt="${oi}"
             data-mobile-bubble>
             ${label}
        </div>`).join("");

    card.classList.toggle("has-image", Boolean(q.imageCode));
    document.getElementById("normal-question-pill").textContent = `Question ${currentIdx + 1} / ${activeData.length}`;
    document.getElementById("normal-question-category").textContent = cat;
    document.getElementById("normal-question-stage").innerHTML = `
        <div class="q-text">${escapeHTML(q.question)}</div>
        ${imgHtml}
        ${audioHtml}
        <div class="options-grid">${opts}</div>`;
    document.getElementById("normal-mobile-label").textContent = `Q. No ${currentIdx + 1}`;
    document.getElementById("normal-mobile-bubbles").innerHTML = mobileOmrBubblesHtml;
    const prevBtn = document.getElementById("normal-prev-btn");
    if (prevBtn) {
        prevBtn.dataset.navPrev = String(currentIdx - 1);
        prevBtn.disabled = currentIdx === 0;
    }
    document.getElementById("normal-nav-right").innerHTML = navRight;

    qContainer.querySelectorAll("[data-submit-exam]").forEach((button) => {
        button.addEventListener("click", submitExam);
    });
    document.getElementById("normal-mobile-bubbles")?.querySelectorAll("[data-mobile-bubble]").forEach((bubble) => {
        bubble.addEventListener("click", () => {
            const qIndex = Number(bubble.dataset.q);
            const optionIndex = Number(bubble.dataset.opt);
            selectMobileBubble(qIndex, optionIndex, bubble);
        });
    });
    syncNormalSubmitVisibility();
}

function refreshNormalOmrState() {
    for (let i = 0; i < activeData.length; i += 1) {
        const row = document.getElementById(`omr-${i}`);
        if (!row) continue;
        row.classList.toggle("active", i === currentIdx);
        row.querySelectorAll(".omr-bubble").forEach((el, optionIndex) => {
            el.classList.toggle("filled", responses[i] === optionIndex);
        });
        document.getElementById(`omr-status-${i}`)?.classList.toggle("answered", responses[i] !== null);
    }
}

function updateActiveNormalQuestionSelection(selectedOptionIndex) {
    const activeCard = document.getElementById("normal-question-stage");
    if (!activeCard) return;
    activeCard.querySelectorAll(".option-item").forEach((el, optionIndex) => {
        el.classList.toggle("selected", optionIndex === selectedOptionIndex);
    });
    activeCard.querySelectorAll('.mobile-question-omr .omr-bubble[data-q]').forEach((el) => {
        el.classList.toggle("filled", Number(el.dataset.opt) === selectedOptionIndex);
    });
}

function resetAnimatedPresentation(element) {
    if (!element) return;
    if (typeof element.getAnimations === "function") {
        element.getAnimations().forEach((animation) => {
            try { animation.cancel(); } catch {}
        });
    }
    element.style.opacity = "";
    element.style.transform = "";
}

function animateContentIn(element, {
    fromOpacity = 0.42,
    duration = 240,
    easing = "cubic-bezier(0.22, 1, 0.36, 1)"
} = {}) {
    if (!element || typeof element.animate !== "function") return;
    resetAnimatedPresentation(element);
    element.animate(
        [
            { opacity: fromOpacity },
            { opacity: 1 }
        ],
        { duration, easing }
    );
}

function syncNormalSubmitVisibility() {
    if (!activeData.length) return;
    const canSubmit = responses[activeData.length - 1] !== null;
    document.querySelectorAll(".normal-submit-btn").forEach(btn => {
        btn.classList.toggle("is-hidden", !canSubmit);
    });
    document.querySelectorAll(".normal-submit-hint").forEach(hint => {
        hint.classList.toggle("is-hidden", canSubmit);
    });
}

function syncPEOSubmitVisibility() {
    const submitBlock = document.getElementById("peo-submit-block");
    if (!submitBlock || !activeData.length) return;
    submitBlock.style.display = responses[activeData.length - 1] !== null ? "block" : "none";
}

// Called ONLY from OMR bubbles — selects answer + auto-advances
async function omrSelect(qi, oi) {
    if (qi !== currentIdx) {
        await navigate(qi);
    }
    responses[qi] = oi;
    if (qi === currentIdx) updateActiveNormalQuestionSelection(oi);
    refreshNormalOmrState();
    updateProgress();
    syncNormalSubmitVisibility();
    if (qi < activeData.length - 1) {
        setTimeout(() => { void navigate(qi + 1); }, 90);
    }
}

async function navigate(idx) {
    if (idx < 0 || idx >= activeData.length) return;
    if (idx === currentIdx) {
        syncNormalSubmitVisibility();
        return;
    }
    await ensureNormalExamQuestionLoaded(idx);
    currentIdx = idx;
    renderActiveNormalQuestion();
    refreshNormalOmrState();
    const activeCard = document.getElementById("normal-question-stage");
    if (window.innerWidth < 768 && activeCard) {
        activeCard.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    handleQuestionAudio(currentIdx);
    void prefetchNormalExamQuestion(currentIdx + QUESTION_PREFETCH_AHEAD);
}

// Music/audio questions autoplay for exactly 30 seconds as soon as the
// question becomes active. Any previously-playing question audio (and its
// countdown) is stopped first so only one ever plays at a time.
const AUDIO_QUESTION_SECONDS = 30;

function stopQuestionAudio() {
    // Stop whatever audio/timer was running for the previous question
    if (audioQuestionTimer) {
        clearInterval(audioQuestionTimer);
        audioQuestionTimer = null;
    }
    document.querySelectorAll(".q-audio").forEach(el => {
        el.pause();
        el.currentTime = 0;
    });
    document.querySelectorAll(".q-audio-timer").forEach(el => { el.style.display = "none"; });
}

function handleQuestionAudio(idx) {
    stopQuestionAudio();

    const audioEl = document.getElementById(`audio-${idx}`);
    if (!audioEl) return; // this question has no audio

    const timerBadge   = document.getElementById(`audio-timer-${idx}`);
    const timerValueEl = document.getElementById(`audio-timer-val-${idx}`);
    let secondsLeft = AUDIO_QUESTION_SECONDS;

    if (timerBadge) timerBadge.style.display = "inline-block";
    if (timerValueEl) timerValueEl.textContent = secondsLeft;

    // Autoplay — browsers may block autoplay-with-sound in rare cases;
    // the visible Play button on the <audio> element still works as a fallback.
    audioEl.currentTime = 0;
    const playPromise = audioEl.play();
    if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => { /* autoplay blocked — controls remain available */ });
    }

    audioQuestionTimer = setInterval(() => {
        secondsLeft--;
        if (timerValueEl) timerValueEl.textContent = Math.max(secondsLeft, 0);
        if (secondsLeft <= 0) {
            clearInterval(audioQuestionTimer);
            audioQuestionTimer = null;
            audioEl.pause();
            if (timerBadge) timerBadge.style.display = "none";
        }
    }, 1000);

    // If the audio clip itself ends before 30 seconds, stop the countdown too
    audioEl.onended = () => {
        if (audioQuestionTimer) {
            clearInterval(audioQuestionTimer);
            audioQuestionTimer = null;
        }
        if (timerBadge) timerBadge.style.display = "none";
    };
}

function updateProgress() {
    const answered = responses.filter(r => r !== null).length;
    const total    = activeData.length;
    const pct      = total ? (answered / total) * 100 : 0;
    document.getElementById("progress-fill").style.width = pct + "%";
    document.getElementById("stat-answered").textContent  = answered;
    document.getElementById("stat-remaining").textContent = total - answered;
}

// ─── TIMER ────────────────────────────────────────────
function startTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        timeLeft--;
        const m = String(Math.floor(timeLeft/60)).padStart(2,"0");
        const s = String(timeLeft % 60).padStart(2,"0");
        document.getElementById("timer-display").textContent = `${m}:${s}`;
        const badge = document.getElementById("timer-badge");
        if (timeLeft <= 60)  badge.classList.add("urgent");
        if (timeLeft <= 0)  { clearInterval(timerInterval); submitExam(); }
    }, 1000);
}

// ─── SUBMIT ───────────────────────────────────────────
async function submitExam() {
    if (submitInProgress) return;
    submitInProgress = true;
    clearInterval(timerInterval);
    if (audioQuestionTimer) { clearInterval(audioQuestionTimer); audioQuestionTimer = null; }
    document.querySelectorAll(".q-audio").forEach(el => el.pause());
    document.getElementById("peo-workspace") && (document.getElementById("peo-workspace").style.display = "none");
    showLoading(true, "Processing results and saving to cloud…");

    let gradedResult;
    try {
        const response = await apiRequest("responses", {
            method: "POST",
            body: {
                session_id: activeExamSessionId,
                time_stamp: new Date().toISOString(),
                student_name: document.getElementById("student-name").value.trim(),
                category_track: activeCategoryLabel || document.getElementById("category-select").value,
                selections: responses
            }
        });
        gradedResult = response.result;
    } catch (e) {
        console.error("Submit error:", e);
        if (activeCategoryLabel === "PE Online Test") {
            document.getElementById("peo-workspace").style.display = "flex";
        }
        showLoading(false);
        showToast(
            e.status === 429
                ? "Submission is temporarily rate-limited. Please try again shortly."
                : `Result not saved: ${e.message}`,
            "error"
        );
        submitInProgress = false;
        return;
    }

    try {
    const correct = gradedResult.correct;
    const wrong = gradedResult.wrong;
    const skipped = gradedResult.skipped;
    const total = gradedResult.total;
    const pct = Math.round((correct / total) * 100);

    // Build results UI
    document.getElementById("result-fraction").textContent = `${correct}/${total}`;
    document.getElementById("result-pct").textContent      = `${pct}%`;
    document.getElementById("res-correct").textContent  = correct;
    document.getElementById("res-wrong").textContent    = wrong;
    document.getElementById("res-skipped").textContent  = skipped;

    const titles = pct>=90 ? "Outstanding Performance!" : pct>=70 ? "Well Done!" : pct>=50 ? "Good Effort!" : "Keep Practicing!";
    const subs   = pct>=90 ? `Excellent work, ${document.getElementById("student-name").value.split(" ")[0]}. Exceptional score!`
                 : pct>=70 ? "You've demonstrated a solid understanding of the material."
                 : pct>=50 ? "You passed! Review the incorrect answers below."
                 : "Don't give up — review the material and try again.";
    document.getElementById("result-title").textContent    = titles;
    document.getElementById("result-subtitle").textContent = subs;
    const peReturnBtn = document.getElementById("pe-return-online-btn");
    if (peReturnBtn) {
        peReturnBtn.style.display = activeCategoryLabel === "PE Online Test" ? "inline-flex" : "none";
    }

    // Animate score ring
    const circumference = 345;
    const offset = circumference - (pct/100)*circumference;
    const ring = document.getElementById("score-ring-fill");

    // Review cards
    document.getElementById("review-container").innerHTML = activeData.map((q, i) => {
        const ans = responses[i];
        const isCorrect = gradedResult.grading?.[i]?.status === "CORRECT";
        const isSkipped = ans === null;
        const cls = isSkipped ? "skipped" : isCorrect ? "correct" : "wrong";
        const verdict = isSkipped
            ? `<span class="review-verdict skipped">— Skipped</span>`
            : isCorrect
            ? `<span class="review-verdict correct">✓ Correct</span>`
            : `<span class="review-verdict wrong">✕ Incorrect</span>`;
        return `
        <div class="review-item ${cls}">
            <div class="review-q-text">Q${i+1}: ${escapeHTML(q?.question || `Question ${i + 1}`)}</div>
            <div class="review-answers">
                ${!isSkipped ? `<span class="answer-tag ${isCorrect?'correct-ans':'wrong-ans'}">Your answer: ${ALPHA[ans]}) ${escapeHTML(q?.options?.[ans] || "Answer recorded")}</span>` : ''}
                ${isSkipped ? `<span class="answer-tag your-ans">Not answered</span>` : ''}
                ${verdict}
            </div>
        </div>`;
    }).join("");

    // Transition views
    document.getElementById("exam-view").classList.remove("show");
    document.getElementById("exam-view").style.display = "none";
    document.getElementById("timer-badge").classList.remove("show");
    // Clear any leftover inline display style from a prior PE portal visit —
    // inline styles override the .show class and would keep this hidden.
    document.getElementById("results-view").style.display = "";
    document.getElementById("results-view").classList.add("show");
    showLoading(false);
    showToast("Exam graded and saved securely.", "success");

    // Animate ring after render
    setTimeout(() => { ring.style.strokeDashoffset = offset; }, 300);
    } catch (error) {
        console.error("Result display error:", error);
        document.getElementById("exam-view").classList.remove("show");
        document.getElementById("exam-view").style.display = "none";
        document.getElementById("results-view").style.display = "";
        document.getElementById("results-view").classList.add("show");
        showToast("Your score was saved, but some review details could not be displayed.", "error");
    } finally {
        submitInProgress = false;
        showLoading(false);
    }
}


let contactCaptchaAnswer = 0;

function refreshContactCaptcha() {
    const first = Math.floor(Math.random() * 8) + 2;
    const second = Math.floor(Math.random() * 8) + 2;
    contactCaptchaAnswer = first + second;
    const question = document.getElementById("contact-captcha-question");
    const answer = document.getElementById("contact-captcha");
    if (question) question.textContent = `${first} + ${second} = ?`;
    if (answer) answer.value = "";
}

function openContactModal() {
    refreshContactCaptcha();
    document.getElementById("contact-modal").classList.add("open");
}

function closeContactModal() {
    document.getElementById("contact-modal").classList.remove("open");
}

function handleContactBackdropClick(e) {
    if (e.target === document.getElementById("contact-modal")) closeContactModal();
}

async function submitContactForm() {
    const form = document.getElementById("contact-form");
    const submitBtn = document.getElementById("contact-submit-btn");
    const captchaInput = document.getElementById("contact-captcha");
    const honeyInput = document.getElementById("contact-company");
    if (!form || !form.reportValidity()) return;

    if (location.protocol === "file:" || location.protocol === "content:") {
        showToast("Contact delivery works only from the published website.", "error");
        return;
    }

    if (honeyInput && honeyInput.value.trim()) {
        form.reset();
        closeContactModal();
        return;
    }

    if (Number(captchaInput.value) !== contactCaptchaAnswer) {
        showToast("Please enter the correct human-check answer.", "error");
        refreshContactCaptcha();
        captchaInput.focus();
        return;
    }

    const subject = document.getElementById("contact-subject").value.trim();
    const payload = {
        name: document.getElementById("contact-name").value.trim(),
        email: document.getElementById("contact-email").value.trim(),
        subject,
        inquiry_type: document.getElementById("contact-type").value,
        message: document.getElementById("contact-message").value.trim()
    };

    submitBtn.disabled = true;
    submitBtn.textContent = "Sending...";
    try {
        await apiRequest("contact", { method: "POST", body: payload });
        form.reset();
        closeContactModal();
        showToast("Message submitted successfully.", "success");
    } catch (error) {
        console.error("Contact form error:", error);
        const needsActivation = /activation|activate form/i.test(String(error.message || ""));
        const rateLimited = error.status === 429;
        showToast(
            rateLimited
                ? "Too many messages were sent. Please wait and try again."
                : needsActivation
                ? "Activate the contact form from the receiver email first."
                : "Message could not be sent. Please try again.",
            "error"
        );
        refreshContactCaptcha();
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit";
    }
}

// ─── CURRENT AFFAIR FLASHCARD WALL MODULE ──────────────

const cafSubcategories = {
    Bhutan: ["Sports", "Authors & Book", "Art & Culture", "Environment", "Politics", "Technology", "Awards & Honor", "Person"],
    International: ["Person", "Authors & Books", "Awards & Honor", "Sports"]
};

const cafSeedNotes = [];

let cafNotes = [];
let cafSelectedScope = "Bhutan";
let cafFilteredItems = [];
let cafActiveTimers = {};

function cafCategoriesForScope(scope) {
    const categories = [
        ...(cafSubcategories[scope] || []),
        ...cafNotes
            .filter(note => note.scope === scope)
            .map(note => String(note.category || "").trim())
            .filter(Boolean)
    ];
    const seen = new Set();
    return categories.filter(category => {
        const key = category.toLocaleLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function cafNormalizeRows(rows) {
    return (rows || []).map((row, idx) => ({
        id: row.id || null,
        scope: row.scope || "Bhutan",
        category: row.category || "Sports",
        date: row.date_stamp || row.date || "",
        examFocus: row.exam_focus || row.examFocus || "",
        answer: row.answer || "",
        created_at: row.created_at || "",
        _seedIndex: idx
    })).filter(item => item.examFocus);
}

async function caLoadState({ render = true, force = false } = {}) {
    if (!force && cafStatePromise) {
        await cafStatePromise;
        if (render) caRenderAll();
        return;
    }
    cafStatePromise = (async () => {
        try {
            const rows = await apiRequest("flashcards");
            cafNotes = cafNormalizeRows(rows);
            if (document.getElementById("pe-home-panel")?.classList.contains("active")) renderPEHomeDashboard();
        } catch (e) {
            cafNotes = cafSeedNotes.map((item, idx) => ({ ...item, id: null, _seedIndex: idx }));
        }
        if (!cafNotes.length) cafNotes = [];
        cafStateLoaded = true;
    })();
    try {
        await cafStatePromise;
        if (render) caRenderAll();
    } finally {
        cafStatePromise = null;
    }
}

function caRenderAll() {
    cafUpdateDropdownOptions(cafSelectedScope);
    cafFilterData(false);
    renderDailyQuoteTicker();
}

function cafUpdateDropdownOptions(scope) {
    const dropdown = document.getElementById("caf-category-dropdown");
    if (!dropdown) return;
    const previous = dropdown.value;
    const categoriesForScope = cafCategoriesForScope(scope);
    dropdown.innerHTML = categoriesForScope.map(cat => `<option value="${escapePEHtml(cat)}">${escapePEHtml(cat)}</option>`).join("");
    if (previous && categoriesForScope.includes(previous)) dropdown.value = previous;
}

function cafSelectRegion(region) {
    cafSelectedScope = region;
    document.getElementById("caf-bhutan-box")?.classList.toggle("active", region === "Bhutan");
    document.getElementById("caf-intl-box")?.classList.toggle("active", region === "International");
    const label = document.getElementById("caf-dropdown-label");
    if (label) label.textContent = `Select ${region} Category:`;
    cafUpdateDropdownOptions(region);
    cafFilterData(true);
}

function cafFilterData(resetPage = true) {
    const selectedCategory = document.getElementById("caf-category-dropdown")?.value || cafCategoriesForScope(cafSelectedScope)[0] || "";
    cafFilteredItems = shuffleArray(cafNotes.filter(note => note.scope === cafSelectedScope && note.category === selectedCategory));
    cafClearAllTimers();
    cafRenderPageGrid();
    if (resetPage) document.getElementById("caf-note-wall")?.scrollTo({ left: 0, top: 0 });
}

function cafClearAllTimers() {
    Object.keys(cafActiveTimers).forEach(id => clearTimeout(cafActiveTimers[id]));
    cafActiveTimers = {};
}

function cafChangePage(direction) {
    const wall = document.getElementById("caf-note-wall");
    if (!wall) return;
    const isMobile = window.matchMedia("(max-width: 560px)").matches;
    const distance = isMobile ? Math.round(wall.clientHeight * 0.82) : Math.round(wall.clientWidth * 0.82);
    wall.scrollBy({
        left: isMobile ? 0 : direction * distance,
        top: isMobile ? direction * distance : 0,
        behavior: "smooth"
    });
}

function cafSyncScrollControls() {
    const wall = document.getElementById("caf-note-wall");
    const leftBtn = document.getElementById("caf-slide-left");
    const rightBtn = document.getElementById("caf-slide-right");
    if (!wall || !leftBtn || !rightBtn || !cafFilteredItems.length) return;
    const isMobile = window.matchMedia("(max-width: 560px)").matches;
    const current = isMobile ? wall.scrollTop : wall.scrollLeft;
    const max = isMobile ? wall.scrollHeight - wall.clientHeight : wall.scrollWidth - wall.clientWidth;
    leftBtn.disabled = max <= 2 || current <= 2;
    rightBtn.disabled = max <= 2 || current >= max - 2;
}

function cafPlayWooshSound() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        const duration = 0.35;
        const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.setValueAtTime(350, ctx.currentTime);
        filter.frequency.exponentialRampToValueAtTime(1100, ctx.currentTime + 0.12);
        filter.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + duration);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.08);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duration);
        noise.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        noise.start();
    } catch (e) {}
}

async function cafCardFlipHandler(container, cardId, data, answerElement) {
    const wasFlipped = container.classList.contains("flipped");
    if (!wasFlipped && !data.answer) {
        if (!data.id) return;
        container.style.pointerEvents = "none";
        try {
            const result = await apiRequest(`flashcard-answer?id=${encodeURIComponent(data.id)}`);
            data.answer = result.answer || "";
            answerElement.textContent = data.answer;
        } catch (error) {
            showToast(`Could not load answer: ${error.message}`, "error");
            return;
        } finally {
            container.style.pointerEvents = "";
        }
    }
    const flipped = container.classList.toggle("flipped");
    if (!wasFlipped && flipped) cafPlayWooshSound();
    if (cafActiveTimers[cardId]) clearTimeout(cafActiveTimers[cardId]);
    if (flipped) {
        cafActiveTimers[cardId] = setTimeout(() => {
            container.classList.remove("flipped");
            delete cafActiveTimers[cardId];
        }, 8000);
    }
}

function cafRenderPageGrid() {
    const wall = document.getElementById("caf-note-wall");
    const leftBtn = document.getElementById("caf-slide-left");
    const rightBtn = document.getElementById("caf-slide-right");
    const indicator = document.getElementById("caf-page-number");
    if (!wall || !leftBtn || !rightBtn || !indicator) return;
    wall.innerHTML = "";

    if (!cafFilteredItems.length) {
        wall.innerHTML = `<div class="caf-empty-wall">No flashcards loaded for this category.</div>`;
        leftBtn.disabled = true;
        rightBtn.disabled = true;
        indicator.textContent = "0 cards";
        return;
    }

    indicator.textContent = `${cafFilteredItems.length} card${cafFilteredItems.length === 1 ? "" : "s"}`;
    leftBtn.disabled = false;
    rightBtn.disabled = false;
    wall.onscroll = cafSyncScrollControls;

    cafFilteredItems.forEach((data, index) => {
        const globalIndex = index;
        const cardId = `caf-card-${globalIndex}`;
        const card = document.createElement("div");
        card.className = "caf-card-container caf-card-entry";
        card.innerHTML = `
            <div class="caf-hanging-card">
                <div class="caf-card-face caf-card-front caf-note-color-${index % 6}">
                    <div><div class="caf-card-number">Question Item ${String(globalIndex + 1).padStart(2, "0")}</div></div>
                    <div class="caf-question-wrapper"><div class="caf-question-text">${escapePEHtml(data.examFocus)}</div></div>
                    <div>
                        <div class="caf-card-footer"><span>${escapePEHtml(data.date || "")}</span><span>Check Answer</span></div>
                    </div>
                </div>
                <div class="caf-card-face caf-card-back caf-note-color-${index % 6}">
                    <div><div class="caf-card-number">Verified Answer</div></div>
                    <div class="caf-answer-wrapper"><div class="caf-answer-text">${escapePEHtml(data.answer || "")}</div></div>
                    <div>
                        <div class="caf-card-footer"><span>${escapePEHtml(data.date || "")}</span><span>${escapePEHtml(data.category)}</span></div>
                    </div>
                </div>
            </div>
        `;
        const answerElement = card.querySelector(".caf-answer-text");
        card.onclick = () => cafCardFlipHandler(card, cardId, data, answerElement);
        wall.appendChild(card);
    });
    requestAnimationFrame(cafSyncScrollControls);
}


function renderDailyQuoteTicker() {
    const track = document.getElementById("daily-quote-track");
    const strip = document.getElementById("daily-quote-strip");
    if (!track || !strip) return;
    if (dailyQuoteExpiryTimer) clearTimeout(dailyQuoteExpiryTimer);
    const queue = dailyQuotes.flatMap(item => [
        { text: item.english, language: "english" },
        { text: item.dzongkha, language: "dzongkha" }
    ]).filter(item => item.text);
    if (!queue.length) {
        strip.style.visibility = "hidden";
        strip.setAttribute("aria-hidden", "true");
        track.className = "daily-quote-track is-empty";
        track.textContent = "";
        track.onanimationiteration = null;
        return;
    }

    strip.style.visibility = "visible";
    strip.setAttribute("aria-hidden", "false");
    const nextExpiry = Math.min(...dailyQuotes.map(item => item.expiresAt));
    dailyQuoteExpiryTimer = setTimeout(() => {
        loadDailyQuotes({ fresh: true }).then(() => {
            dailyQuoteTickerIndex = 0;
            renderDailyQuoteTicker();
        });
    }, Math.max(0, nextExpiry - Date.now()) + 50);
    dailyQuoteTickerIndex %= queue.length;
    const showCurrentQuote = () => {
        const current = queue[dailyQuoteTickerIndex];
        track.className = `daily-quote-track${current.language === "dzongkha" ? " is-dzongkha" : ""}`;
        track.textContent = current.text;
    };
    showCurrentQuote();
    track.onanimationiteration = () => {
        dailyQuoteTickerIndex = (dailyQuoteTickerIndex + 1) % queue.length;
        showCurrentQuote();
    };
}

async function loadDailyQuotes({ fresh = false } = {}) {
    try {
        const path = fresh ? `quotes?refresh=${Date.now()}` : "quotes";
        const rows = await apiRequest(path);
        dailyQuotes = (rows || []).map(row => ({
            id: String(row.id),
            english: row.english_quote || "",
            dzongkha: row.dzongkha_quote || "",
            expiresAt: new Date(row.expires_at).getTime()
        })).filter(item => (item.english || item.dzongkha) && item.expiresAt > Date.now());
    } catch (e) {
        dailyQuotes = [];
    }
}

// PE practice navigation state. These declarations are public-page logic
// and must remain independent from the separate admin application.
let peActiveTopic = null;
let peSidebarWired = false;
const pePracticeQuestionsByDomId = new Map();

function renderPEPanel(panelId) {
    if (panelId === "pe-home-panel") renderPEHomeGrid();
    else if (panelId === "pe-current-affair-panel") {
        if (cafStateLoaded) caRenderAll();
        else caLoadState().catch(() => {});
    }
    else if (panelId === "pe-mock-panel") renderPEMockGrid();
    else if (panelId === "pe-past-panel") renderPEPastGrid();
    else if (panelId === "pe-di-panel") renderPEDIGrid();
    else if (panelId === "pe-online-panel") updatePEOnlineCount();
}

function wirePESidebar() {
    if (peSidebarWired) return; // only attach listeners once
    peSidebarWired = true;

    const menuToggle = document.getElementById("pe-menu-toggle");
    const navigation = document.getElementById("pe-navigation");
    const spacer = document.getElementById("pe-navigation-spacer");
    const desktopSidebarMedia = typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(min-width: 901px)")
        : null;
    const syncPESidebarState = (open) => {
        if (!navigation) return;
        navigation.classList.toggle("open", open);
        if (spacer) spacer.classList.toggle("open", open);
    };

    if (menuToggle && navigation) {
        menuToggle.onclick = () => {
            if (desktopSidebarMedia?.matches) return;
            const nextOpen = !navigation.classList.contains("open");
            syncPESidebarState(nextOpen);
        };
    }

    if (navigation) {
        navigation.addEventListener("mouseenter", () => {
            if (!desktopSidebarMedia?.matches) return;
            syncPESidebarState(true);
        });
        navigation.addEventListener("mouseleave", () => {
            if (!desktopSidebarMedia?.matches) return;
            syncPESidebarState(false);
        });
        navigation.addEventListener("focusin", () => {
            if (!desktopSidebarMedia?.matches) return;
            syncPESidebarState(true);
        });
        navigation.addEventListener("focusout", (event) => {
            if (!desktopSidebarMedia?.matches) return;
            if (navigation.contains(event.relatedTarget)) return;
            syncPESidebarState(false);
        });
    }

    const listItems = document.querySelectorAll("#pe-list .pe-list-item");
    const contentSections = document.querySelectorAll(".pe-content .pe-section");

    listItems.forEach((item) => {
        item.querySelector("a").onclick = (event) => {
            event.preventDefault();
            listItems.forEach((li) => li.classList.remove("active"));
            item.classList.add("active");

            clearActivePEPracticeMemory();
            peActiveTopic = null; // returning to a top-level panel exits question view
            peDIActiveSet = null;
            peDIActiveGraphIndex = 0;

            const targetPanelId = item.getAttribute("data-target");
            contentSections.forEach((section) => section.classList.remove("active"));
            document.getElementById(targetPanelId).classList.add("active");

            // Sidebar stays exactly as it is (open or collapsed) — only the
            // ☰ toggle should open/close it. Switching panels by clicking a
            // label must not force-collapse it.

            // Let the panel switch paint first, then do any heavier rendering work.
            requestAnimationFrame(() => renderPEPanel(targetPanelId));
        };
    });
}

async function openPEPortal() {
    document.getElementById("setup-view").style.display = "none";
    document.getElementById("exam-view") && document.getElementById("exam-view").classList.remove("show");
    document.getElementById("results-view") && document.getElementById("results-view").classList.remove("show");
    document.getElementById("pe-view").style.display = "block";
    hideTopActionButtons();
    document.getElementById("pe-back-btn").style.display = "block";

    wirePESidebar();

    // Reset to Home panel and a collapsed sidebar every time PE is opened.
    // On desktop the hover handlers will expand it when the cursor enters.
    clearActivePEPracticeMemory();
    peTopicQuestionCache = new Map();
    peActiveTopic = null;
    peDIActiveSet = null;
    document.getElementById("pe-navigation").classList.remove("open");
    document.getElementById("pe-navigation-spacer").classList.remove("open");
    document.querySelectorAll("#pe-list .pe-list-item").forEach(li => {
        li.classList.toggle("active", li.dataset.target === "pe-home-panel");
    });
    document.querySelectorAll(".pe-content .pe-section").forEach(s => s.classList.remove("active"));
    document.getElementById("pe-home-panel").classList.add("active");

    const databaseWasReady = databaseReady;
    if (!databaseReady) {
        showLoading(true, "Opening PE...");
        const loaded = await loadDatabase();
        showLoading(false);
        if (!loaded) {
            closePEPortal();
            return;
        }
    }

    // A newly completed database load renders the active panel in processData.
    // Only render here when the cached data was already ready before opening.
    if (databaseWasReady) renderPEHomeGrid();

    loadPEOnlineQuestionBank()
        .then(() => {
            updatePEOnlineCount();
            queuePEOnlineMediaPrefetch();
        })
        .catch(error => {
            peOnlineCatalog.total = 0;
            console.error("PE Online question bank load failed:", error);
        });
}

function closePEPortal() {
    document.getElementById("pe-view").style.display = "none";
    document.getElementById("setup-view").style.display = "block";
    document.getElementById("setup-options").style.display = setupContinued ? "grid" : "none";
    if (setupContinued) setPostContinueActionButtons();
    else setEntryActionButtons();
    document.getElementById("pe-back-btn").style.display = "none";
}

function getPEQuestions() {
    return peQuestionsCache || [];
}

// ─── Folder grid builders (one per panel) ──────────────────
function buildPETopicList(peTypeFilter, searchTerm) {
    const prefix = peTypeFilter === "all" ? "all::" : `${peTypeFilter}::`;
    let topics = [...peTopicBuckets.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => ({ ...value }));
    const term = (searchTerm || "").trim().toLowerCase();
    if (term) topics = topics.filter(t => t.topic.toLowerCase().includes(term));
    topics.sort((a, b) => a.topic.localeCompare(b.topic));
    return topics;
}

function renderPETopicGrid(gridId, peTypeFilter, searchInputId, accentColor) {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    const searchTerm = document.getElementById(searchInputId)?.value || "";
    const topics = buildPETopicList(peTypeFilter, searchTerm);

    if (topics.length === 0) {
        grid.innerHTML = '<div class="pe-empty-msg">No PE questions are available here yet.</div>';
        return;
    }

    const accentClass = accentClassFromColor(accentColor);
    grid.innerHTML = topics.map(t => `
        <div class="pe-card ${accentClass}"
             data-pe-type="${escapeHTML(t.peType)}"
             data-pe-topic="${escapeHTML(t.topic)}">
            <i class="bi bi-folder-fill pe-card-icon"></i>
            <div class="pe-card-info">
                <div class="pe-card-title">${escapePEHtml(t.topic)}</div>
                <div class="pe-card-meta">${escapeHTML(t.peType)} • ${t.count} question${t.count === 1 ? "" : "s"}</div>
            </div>
        </div>
    `).join("");

    grid.querySelectorAll(".pe-card[data-pe-type][data-pe-topic]").forEach(card => {
        card.addEventListener("click", () => {
            openPETopic(card.dataset.peType || "", card.dataset.peTopic || "");
        });
    });
}

const PE_NOTE_DRAFT_KEY = "examportal_pe_self_note_draft_v1";

function getPEOverview(type) {
    return peOverviewCatalog.find(item => item.type === type) || { questions: 0, graphs: 0 };
}

async function loadPEHomeDashboard() {
    if (peHomeDashboardLoadPromise) return peHomeDashboardLoadPromise;
    peHomeDashboardLoadPromise = Promise.all([
        apiRequest("pe-overview"),
        apiRequest("pe-resources")
    ]).then(([overview, resources]) => {
        peOverviewCatalog = Array.isArray(overview?.categories) ? overview.categories : [];
        peResourcesCatalog = Array.isArray(resources) ? resources : [];
        renderPEHomeDashboard();
    }).catch(error => {
        console.error("PE home dashboard load failed:", error);
        renderPEHomeDashboard();
    }).finally(() => {
        peHomeDashboardLoadPromise = null;
    });
    return peHomeDashboardLoadPromise;
}

function renderPEHomeDashboard() {
    const overview = document.getElementById("pe-overview-card");
    if (!overview) return;
    const bcss = getPEOverview(PE_BCSC_MAIN_TYPE);
    const past = getPEOverview("Past Paper");
    const di = getPEOverview("Data Interpretation");
    const currentAffairs = Array.isArray(cafNotes) ? cafNotes.length : 0;
    const cards = [
        ["bi-clipboard-check", "BCSC(main)", bcss.questions, "Questions"],
        ["bi-book", "Past Paper", past.questions, "Questions"],
        ["bi-bar-chart-line", "Data Interpretation", di.questions, `${di.questions === 1 ? "Question" : "Questions"} · ${di.graphs} graph${di.graphs === 1 ? "" : "s"}`],
        ["bi-newspaper", "Current Affairs", currentAffairs, "Questions"]
    ];
    const questionTotal = cards.reduce((total, [, , count]) => total + Number(count || 0), 0);
    overview.innerHTML = `
        <div class="pe-overview-circles">
            ${cards.map(([icon, label, count, detail]) => `
                <div class="pe-overview-item">
                    <div class="pe-overview-circle">
                        <i class="bi ${icon}" aria-hidden="true"></i>
                        <strong class="pe-overview-value">${Number(count || 0)}</strong>
                        <span class="pe-overview-label">${escapeHTML(detail)}</span>
                    </div>
                    <span>${escapeHTML(label)}</span>
                </div>
            `).join("")}
        </div>
        <p class="pe-overview-total">Total available: <strong>${questionTotal} questions</strong> · <strong>${di.graphs} graph${di.graphs === 1 ? "" : "s"}</strong></p>
    `;
    renderPEResourceTabs();
}

function renderPEResourceTabs() {
    document.querySelectorAll("[data-pe-resource-tab]").forEach(button => {
        const active = button.dataset.peResourceTab === peActiveResourceTab;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
    });
    const panels = {
        formula: document.getElementById("pe-resource-formula"),
        guide: document.getElementById("pe-resource-guide"),
        note: document.getElementById("pe-resource-note")
    };
    Object.entries(panels).forEach(([name, panel]) => {
        if (panel) panel.hidden = name !== peActiveResourceTab;
    });
    renderPEFormulaPanel(panels.formula);
    renderPEGuidePanel(panels.guide);
    renderPESelfNotePanel(panels.note);
}

function renderPEFormulaPanel(panel) {
    if (!panel) return;
    const formula = peResourcesCatalog.find(item => item.kind === "formula");
    if (!formula) {
        panel.innerHTML = '<div class="pe-empty-msg">Formula sheets will appear here when published.</div>';
        return;
    }
    const prompt = String(formula.practice_prompt || "").trim();
    const documentUrl = safeResourceUrl(formula.document_url);
    panel.innerHTML = `
        <h3>${escapeHTML(formula.title || "Formula Sheet")}</h3>
        <div class="pe-resource-document">${escapeHTML(formula.content || "").replace(/\n/g, "<br>") || "No formula text has been published yet."}</div>
        ${documentUrl ? `<div class="pe-resource-actions"><a class="pe-di-graph-btn" href="${escapeHTML(documentUrl)}" target="_blank" rel="noopener noreferrer">Open document</a></div>` : ""}
        ${prompt ? `
            <div class="pe-resource-practice">
                <h3>Practice</h3>
                <label>${escapeHTML(prompt)}</label>
                <div><input type="text" class="pe-resource-answer" aria-label="Formula practice answer" data-formula-answer></div>
                <div class="pe-resource-actions">
                    <button type="button" class="pe-di-graph-btn primary" data-pe-resource-action="check-formula" data-formula-id="${escapeHTML(String(formula.id || ""))}">Check answer</button>
                    <span class="pe-resource-feedback" data-formula-feedback aria-live="polite"></span>
                </div>
            </div>
        ` : ""}
    `;
}

function safeResourceUrl(value) {
    const source = String(value || "").trim();
    return /^https:\/\/[^\s]+$/i.test(source) ? source : "";
}

function renderPEGuidePanel(panel) {
    if (!panel) return;
    const guides = peResourcesCatalog.filter(item => item.kind === "guide");
    if (peGuideCarouselTimer) {
        clearInterval(peGuideCarouselTimer);
        peGuideCarouselTimer = null;
    }
    if (!guides.length) {
        panel.innerHTML = '<div class="pe-empty-msg">Published guides will appear here.</div>';
        return;
    }
    peGuideCarouselIndex %= guides.length;
    const guide = guides[peGuideCarouselIndex];
    const documentUrl = safeResourceUrl(guide.document_url);
    const websiteUrl = safeResourceUrl(guide.website_url);
    const guideLinkUrl = documentUrl || websiteUrl;
    const preview = safeMediaURL(guide.preview_url, "image")
        || (/\.(?:jpe?g|png|webp)(?:$|[?#])/i.test(documentUrl) ? documentUrl : "");
    const previewBody = `
        <div class="pe-guide-preview">
            ${preview ? `<img src="${escapeHTML(preview)}" alt="${escapeHTML(guide.title || "Guide preview")}" loading="lazy">` : '<div class="pe-guide-placeholder"><i class="bi bi-file-earmark-text" aria-hidden="true"></i><div>Document preview</div></div>'}
        </div>
    `;
    const guideBody = `
        ${guideLinkUrl ? `<a class="pe-guide-link" href="${escapeHTML(guideLinkUrl)}" target="_blank" rel="noopener noreferrer">${previewBody}</a>` : previewBody}
        <h3>${escapeHTML(guide.title || "Guide")}</h3>
        <p class="pe-guide-meta">${documentUrl ? "Opens supporting document" : websiteUrl ? "Opens external website" : "Document preview"}</p>
    `;
    panel.innerHTML = `
        <div class="pe-guide-carousel">
            ${guideBody}
            <p class="pe-guide-meta">Guide ${peGuideCarouselIndex + 1} of ${guides.length}</p>
        </div>
    `;
    if (guides.length > 1 && peActiveResourceTab === "guide" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        peGuideCarouselTimer = setInterval(() => {
            peGuideCarouselIndex = (peGuideCarouselIndex + 1) % guides.length;
            renderPEGuidePanel(panel);
        }, 4000);
    }
}

function renderPESelfNotePanel(panel) {
    if (!panel) return;
    let draft = "";
    try { draft = sessionStorage.getItem(PE_NOTE_DRAFT_KEY) || ""; } catch (e) {}
    panel.innerHTML = `
        <h3>Self Note</h3>
        <div class="pe-note-toolbar" aria-label="Text formatting">
            <button type="button" class="pe-di-graph-btn" data-note-command="bold" aria-label="Bold">B</button>
            <button type="button" class="pe-di-graph-btn" data-note-command="italic" aria-label="Italic">I</button>
            <button type="button" class="pe-di-graph-btn" data-note-command="underline" aria-label="Underline">U</button>
            <button type="button" class="pe-di-graph-btn" data-note-command="insertUnorderedList">List</button>
        </div>
        <div class="pe-note-editor" id="pe-note-editor" contenteditable="true" role="textbox" aria-multiline="true"></div>
        <div class="pe-resource-actions">
            <button type="button" class="pe-di-graph-btn" data-pe-resource-action="save-draft">Save draft</button>
            <button type="button" class="pe-di-graph-btn primary" data-pe-resource-action="export-note">Export DOCX</button>
            <span class="pe-resource-feedback" data-note-feedback aria-live="polite"></span>
        </div>
    `;
    const editor = panel.querySelector("#pe-note-editor");
    if (editor) {
        const safeDraft = sanitizePESelfNoteHtml(draft);
        if (safeDraft) editor.innerHTML = safeDraft;
        else editor.textContent = "Write your notes here...";
    }
}

function handlePEHomeDashboardClick(event) {
    const tab = event.target.closest("[data-pe-resource-tab]");
    if (tab) {
        peActiveResourceTab = tab.dataset.peResourceTab || "formula";
        renderPEResourceTabs();
        return;
    }
    const noteCommand = event.target.closest("[data-note-command]");
    if (noteCommand) {
        document.getElementById("pe-note-editor")?.focus();
        document.execCommand(noteCommand.dataset.noteCommand || "", false, null);
        return;
    }
    const action = event.target.closest("[data-pe-resource-action]")?.dataset.peResourceAction;
    if (action === "check-formula") {
        void checkPEFormulaAnswer(event.target.closest("[data-formula-id]")?.dataset.formulaId || "");
    } else if (action === "save-draft") {
        const editor = document.getElementById("pe-note-editor");
        try { sessionStorage.setItem(PE_NOTE_DRAFT_KEY, sanitizePESelfNoteHtml(editor?.innerHTML || "")); } catch (e) {}
        const feedback = document.querySelector("[data-note-feedback]");
        if (feedback) feedback.textContent = "Draft saved for this browser session";
    } else if (action === "export-note") {
        exportPESelfNoteDocx();
    }
}

function sanitizePESelfNoteHtml(value) {
    const allowedTags = new Set(["b", "strong", "i", "em", "u", "ul", "ol", "li", "p", "div", "br"]);
    const template = document.createElement("template");
    template.innerHTML = String(value || "");
    const sanitizeNode = node => {
        if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue || "");
        if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
        const tag = node.tagName.toLowerCase();
        const target = allowedTags.has(tag) ? document.createElement(tag) : document.createDocumentFragment();
        [...node.childNodes].forEach(child => target.appendChild(sanitizeNode(child)));
        return target;
    };
    const container = document.createElement("div");
    [...template.content.childNodes].forEach(node => container.appendChild(sanitizeNode(node)));
    return container.innerHTML;
}

function handlePESelfNotePaste(event) {
    if (!event.target.closest?.("#pe-note-editor")) return;
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") || "";
    document.execCommand("insertText", false, text);
}

async function checkPEFormulaAnswer(id) {
    const answer = document.querySelector("[data-formula-answer]")?.value.trim() || "";
    const feedback = document.querySelector("[data-formula-feedback]");
    if (!id || !answer) {
        if (feedback) feedback.textContent = "Enter an answer first";
        return;
    }
    if (feedback) feedback.textContent = "Checking...";
    try {
        const result = await apiRequest("pe-resource-answer", { method: "POST", body: { id, answer } });
        if (feedback) feedback.textContent = result?.correct ? "Correct" : "Try again";
    } catch (error) {
        if (feedback) feedback.textContent = "Could not check answer";
    }
}

function xmlEscape(value) {
    return String(value || "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function buildStoredZip(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    const write16 = value => Uint8Array.of(value & 255, (value >>> 8) & 255);
    const write32 = value => Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255);
    for (const [name, body] of files) {
        const nameBytes = encoder.encode(name);
        const bodyBytes = encoder.encode(body);
        const crc = crc32(bodyBytes);
        const local = [write32(0x04034b50), write16(20), write16(0), write16(0), write16(0), write16(0), write32(crc), write32(bodyBytes.length), write32(bodyBytes.length), write16(nameBytes.length), write16(0), nameBytes, bodyBytes];
        chunks.push(...local);
        central.push(write32(0x02014b50), write16(20), write16(20), write16(0), write16(0), write16(0), write16(0), write32(crc), write32(bodyBytes.length), write32(bodyBytes.length), write16(nameBytes.length), write16(0), write16(0), write16(0), write16(0), write32(0), write32(offset), nameBytes);
        offset += local.reduce((total, part) => total + part.length, 0);
    }
    const centralSize = central.reduce((total, part) => total + part.length, 0);
    const end = [write32(0x06054b50), write16(0), write16(0), write16(files.length), write16(files.length), write32(centralSize), write32(offset), write16(0)];
    return new Blob([...chunks, ...central, ...end], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

function buildDocxParagraphs(editor) {
    const paragraphs = [[]];
    const current = () => paragraphs[paragraphs.length - 1];
    const finish = () => { if (current().length) paragraphs.push([]); };
    const addText = (value, format) => {
        const parts = String(value || "").replace(/\r/g, "").split("\n");
        parts.forEach((part, index) => {
            if (part) current().push({ text: part, format });
            if (index < parts.length - 1) finish();
        });
    };
    const visit = (node, format = {}) => {
        if (node.nodeType === Node.TEXT_NODE) {
            addText(node.nodeValue, format);
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = node.tagName.toLowerCase();
        if (tag === "br") {
            finish();
            return;
        }
        const nextFormat = {
            bold: format.bold || tag === "b" || tag === "strong",
            italic: format.italic || tag === "i" || tag === "em",
            underline: format.underline || tag === "u"
        };
        if (tag === "ul" || tag === "ol") {
            [...node.children].forEach((item, index) => {
                if (item.tagName?.toLowerCase() !== "li") return;
                addText(tag === "ol" ? `${index + 1}. ` : "• ", nextFormat);
                [...item.childNodes].forEach(child => visit(child, nextFormat));
                finish();
            });
            return;
        }
        [...node.childNodes].forEach(child => visit(child, nextFormat));
        if (tag === "p" || tag === "div") finish();
    };
    [...editor.childNodes].forEach(node => visit(node));
    return paragraphs.filter(paragraph => paragraph.length).map(runs => `<w:p>${runs.map(run => {
        const properties = run.format.bold || run.format.italic || run.format.underline
            ? `<w:rPr>${run.format.bold ? "<w:b/>" : ""}${run.format.italic ? "<w:i/>" : ""}${run.format.underline ? '<w:u w:val="single"/>' : ""}</w:rPr>`
            : "";
        return `<w:r>${properties}<w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`;
    }).join("")}</w:p>`).join("");
}

function exportPESelfNoteDocx() {
    const editor = document.getElementById("pe-note-editor");
    const text = String(editor?.innerText || "").trim();
    const feedback = document.querySelector("[data-note-feedback]");
    if (!text) {
        if (feedback) feedback.textContent = "Write a note before exporting";
        return;
    }
    const paragraphs = buildDocxParagraphs(editor);
    const files = [
        ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
        ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
        ["word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`]
    ];
    const url = URL.createObjectURL(buildStoredZip(files));
    const link = document.createElement("a");
    link.href = url;
    link.download = "examportal-self-note.docx";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    if (feedback) feedback.textContent = "DOCX exported";
}

function renderPEHomeGrid() {
    renderPEHomeDashboard();
    void loadPEHomeDashboard();
}
function renderPEMockGrid() {
    renderPETopicGrid("pe-mock-grid", PE_BCSC_MAIN_TYPE, "pe-mock-search", "#00bcd4");
}
function renderPEPastGrid() {
    renderPETopicGrid("pe-past-grid", "Past Paper", "pe-past-search", "#4caf50");
}

// ─── Online Test (timed full-length simulation) ─────────────
const PE_ONLINE_SECONDS_PER_QUESTION = 65; // 1 minute 5 seconds per PE Online Test question
async function loadPEOnlineQuestionBank() {
    const catalog = await apiRequest("pe-online-questions?view=catalog");
    peOnlineCatalog = {
        counts: { ...peOnlineCatalog.counts, ...(catalog.counts || {}) },
        total: Number(catalog.total || 0)
    };
}

function updatePEOnlineCount() {
    const pastCount = Number(peOnlineCatalog.counts["Past Paper"] || 0);
    const diCount = Number(peOnlineCatalog.counts["Data Interpretation"] || 0);
    const caCount = Number(peOnlineCatalog.counts["Current Affairs"] || 0);

    const pastEl = document.getElementById("pe-online-past-count");
    if (pastEl) pastEl.textContent = pastCount;
    const diEl = document.getElementById("pe-online-di-count");
    if (diEl) diEl.textContent = diCount;
    const caEl = document.getElementById("pe-online-ca-count");
    if (caEl) caEl.textContent = caCount;

    const el = document.getElementById("pe-online-qcount");
    if (el) el.textContent = peOnlineCatalog.total;

    const timeEl = document.getElementById("pe-online-time-limit");
    if (timeEl) timeEl.textContent = formatPEOnlineDuration(peOnlineCatalog.total * PE_ONLINE_SECONDS_PER_QUESTION);
}

function formatPEOnlineDuration(totalSeconds) {
    const totalMinutes = Math.round(totalSeconds / 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (h <= 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}

async function startPEOnlineTest() {
    if (examPreparing) return;
    const name = document.getElementById("student-name").value.trim();
    if (!name) {
        showToast("Please enter your full name on the home screen first.", "error");
        return;
    }

    examPreparing = true;
    showLoading(true, "Connecting...");
    try {
        await loadPEOnlineQuestionBank();
    } catch (error) {
        examPreparing = false;
        showLoading(false);
        showToast(`Could not load PE Online questions: ${error.message}`, "error");
        return;
    }

    if (peOnlineCatalog.total === 0) {
        examPreparing = false;
        showLoading(false);
        showToast("No questions found in the separate PE Online question bank.", "error");
        return;
    }
    const startBtn = document.querySelector(".pe-online-start-btn");
    if (startBtn) startBtn.disabled = true;
    try {
        showLoading(true, "Connecting...");
        const session = await startSecurePEOnlineExam();
        normalExamMode = false;
        peOnlineMode = true;
        if (!session.total || !session.questions.length) {
            throw new Error("The secure PE Online session did not include any questions.");
        }
        seedNormalExamQuestions(session.total, session.questions);
        responses = new Array(activeData.length).fill(null);
        timeLeft = activeData.length * PE_ONLINE_SECONDS_PER_QUESTION;
        currentIdx = 0;
        activeCategoryLabel = "PE Online Test";
        stopQuestionAudio();
        const startupQuestions = session.questions.map(entry => entry.question).filter(Boolean);
        await prepareExamAssetsBeforeTimer(startupQuestions, "Preparing PE online test…");
    } catch (error) {
        showToast(`Could not start secure PE test: ${error.message}`, "error");
        showLoading(false);
        return;
    } finally {
        examPreparing = false;
        if (startBtn) startBtn.disabled = false;
        showLoading(false);
    }

    document.getElementById("pe-view").style.display = "none";
    document.getElementById("pe-back-btn").style.display = "none";
    hideTopActionButtons();
    document.getElementById("timer-badge").classList.add("show");

    document.getElementById("peo-workspace").style.display = "flex";
    await peoSyncWorkspaceView();
    startTimer();
}

// PE ONLINE TEST — SPLIT-SCREEN WORKSPACE RENDERER
// Mirrors the OMR-Driven Sticky Mobile Testing Engine reference exactly: // the graph panel is collapsed by default and expands into a 60/40 split
// only when the active question carries a chart image (Data Interpretation // questions). Operates on the same activeData/responses/currentIdx state
// the normal exam flow uses, so submitExam() works unmodified.
	
function peoInitOMRSheet() {
    const wrapper = document.getElementById("peo-omr-rows");
    wrapper.innerHTML = "";
    activeData.forEach((_, index) => {
        const row = document.createElement("div");
        row.className = "peo-omr-row";
        row.id = `peo-omr-row-${index}`;

        const label = document.createElement("div");
        label.className = "peo-omr-q-num";
        label.textContent = `Q${index + 1}`;
        label.onclick = () => { void peoJumpToQuestion(index); };

        const bubblesContainer = document.createElement("div");
        bubblesContainer.className = "peo-omr-bubbles";

        ALPHA.forEach((letter, letterIdx) => {
            const bubble = document.createElement("div");
            bubble.className = "peo-bubble";
            bubble.textContent = letter;
            bubble.id = `peo-bubble-${index}-${letterIdx}`;
            bubble.onclick = () => { void peoSelectOption(index, letterIdx); };
            bubblesContainer.appendChild(bubble);
        });

        row.appendChild(label);
        row.appendChild(bubblesContainer);
        wrapper.appendChild(row);
    });
    peoUpdateCounters();
}

async function peoSyncWorkspaceView() {
    // Build the OMR sheet fresh the first time this is called for a session
    if (document.getElementById("peo-omr-rows").children.length !== activeData.length) {
        peoInitOMRSheet();
    }

    await ensurePEOnlineQuestionLoaded(currentIdx);
    const q = activeData[currentIdx];
    if (!q) return;
    const workspace = document.getElementById("peo-workspace");
    const imgNode = document.getElementById("peo-graph-img");
    let stage = document.getElementById("peo-question-stage");
    if (!stage) {
        stage = document.createElement("div");
        stage.id = "peo-question-stage";
        const textNode = document.getElementById("peo-question-text");
        const audioNode = document.getElementById("peo-question-audio");
        const optionsNode = document.getElementById("peo-options-wrapper");
        if (textNode) stage.appendChild(textNode);
        if (audioNode) stage.appendChild(audioNode);
        if (optionsNode) stage.appendChild(optionsNode);
        document.getElementById("peo-question-content")?.appendChild(stage);
    }
    const graphSource = safeMediaURL(q.imageCode, "image");
    const currentGraphSource = imgNode?.getAttribute("src") || "";

    if (graphSource) {
        if (imgNode && currentGraphSource !== graphSource) {
            if (imgNode.dataset.graphTimer) {
                clearTimeout(Number(imgNode.dataset.graphTimer));
                delete imgNode.dataset.graphTimer;
            }
            const hadGraph = Boolean(currentGraphSource);
            if (hadGraph) imgNode.style.opacity = "0";
            const applyGraph = () => {
                imgNode.src = graphSource;
                imgNode.style.opacity = "1";
                delete imgNode.dataset.graphTimer;
            };
            if (hadGraph) {
                imgNode.dataset.graphTimer = String(setTimeout(applyGraph, 120));
            } else {
                applyGraph();
            }
        } else if (imgNode) {
            imgNode.style.opacity = "1";
        }
        workspace.classList.add("split-mode");
    } else {
        workspace.classList.remove("split-mode");
        if (imgNode && currentGraphSource) {
            if (imgNode.dataset.graphTimer) {
                clearTimeout(Number(imgNode.dataset.graphTimer));
                delete imgNode.dataset.graphTimer;
            }
            imgNode.style.opacity = "0";
            imgNode.dataset.graphTimer = String(setTimeout(() => {
                imgNode.src = "";
                delete imgNode.dataset.graphTimer;
            }, 250));
        }
    }

    for (let i = 0; i < activeData.length; i++) {
        const row = document.getElementById(`peo-omr-row-${i}`);
        if (row) row.classList.remove("focused-row");
    }
    const activeRow = document.getElementById(`peo-omr-row-${currentIdx}`);
    if (activeRow) {
        activeRow.classList.add("focused-row");
        if (window.innerWidth <= 768) {
            activeRow.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        }
    }

    const peInfo = parsePECategory(q.category);
    document.getElementById("peo-question-badge").textContent = `Question ${currentIdx + 1} / ${activeData.length}`;
    document.getElementById("peo-category-badge").textContent = peInfo ? peInfo.peType.toUpperCase() : (q.category || "");
    document.getElementById("peo-question-text").textContent = q.question;
    const peoAudio = document.getElementById("peo-question-audio");
    const audioSource = safeMediaSource(q.audioCode, "audio");
    peoAudio.innerHTML = audioSource
        ? `<div class="q-audio-wrap"><audio src="${audioSource}" class="q-audio" controls preload="metadata"></audio></div>`
        : "";

    const optionsWrapper = document.getElementById("peo-options-wrapper");
    optionsWrapper.innerHTML = "";
    q.options.forEach((optText, optIdx) => {
        const row = document.createElement("div");
        row.className = `peo-option-row ${responses[currentIdx] === optIdx ? "selected" : ""}`;
        const letterCircle = document.createElement("div");
        letterCircle.className = "peo-option-letter";
        letterCircle.textContent = ALPHA[optIdx];
        const textSpan = document.createElement("span");
        textSpan.textContent = optText;
        row.appendChild(letterCircle);
        row.appendChild(textSpan);
        optionsWrapper.appendChild(row);
    });

    // Re-trigger the question-content fade-in on every render (new question// or a split-mode switch) by removing and re-adding the element from
    // the DOM flow — toggling a class alone won't restart a CSS animation // that's already finished, but a reflow via offsetWidth will.
    if (stage) {
        stage.style.animation = "none";
        void stage.offsetWidth; // force reflow
        stage.style.animation = "";
        animateContentIn(stage, {
            fromOpacity: 0.5,
            duration: 220,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)"
        });
    }

    // Make sure every OMR bubble reflects the ACTUAL saved answer for its
    // row (not just whatever was last clicked) — this runs on every render // so navigating around the sheet never shows stale or leftover highlights.
    for (let i = 0; i < activeData.length; i++) {
        for (let letterIdx = 0; letterIdx < ALPHA.length; letterIdx++) {
            const bubble = document.getElementById(`peo-bubble-${i}-${letterIdx}`);
            if (bubble) bubble.classList.toggle("active", responses[i] === letterIdx);
        }
    }

    document.getElementById("peo-btn-prev").disabled = currentIdx === 0;

    syncPEOSubmitVisibility();

    stopQuestionAudio();
    void prefetchPEOnlineQuestion(currentIdx + 1);
}

async function peoSelectOption(qIdx, choiceIdx) {
    if (qIdx !== currentIdx) {
        await peoJumpToQuestion(qIdx);
    }
    responses[qIdx] = choiceIdx;
    peoUpdateCounters();

    // Immediate visual feedback so the click feels responsive even before
    // the full re-render runs (matters most during the auto-advance delay // below, so the person can see their answer register).
    for (let i = 0; i < ALPHA.length; i++) {
        const bubble = document.getElementById(`peo-bubble-${qIdx}-${i}`);
        if (bubble) bubble.classList.toggle("active", i === choiceIdx);
    }
    if (qIdx === currentIdx) {
        const optRows = document.querySelectorAll("#peo-options-wrapper .peo-option-row");
        optRows.forEach((row, i) => row.classList.toggle("selected", i === choiceIdx));
    }

    // Auto-advance to the next question. On the last question, keep the view
    // stable and only reveal Submit instead of re-rendering the same question.
    if (qIdx === currentIdx && currentIdx < activeData.length - 1) {
        currentIdx++;
        setTimeout(() => { void peoSyncWorkspaceView(); }, 90);
    } else {
        syncPEOSubmitVisibility();
    }
}

async function peoNavigateBack() {
    if (currentIdx > 0) {
        currentIdx--;
        await peoSyncWorkspaceView();
    }
}

async function peoJumpToQuestion(targetIndex) {
    await ensurePEOnlineQuestionLoaded(targetIndex);
    currentIdx = targetIndex;
    await peoSyncWorkspaceView();
}

function peoUpdateCounters() {
    let answeredCount = 0;
    responses.forEach(r => { if (r !== null) answeredCount++; });
    document.getElementById("peo-count-answered").textContent = answeredCount;
    document.getElementById("peo-count-remaining").textContent = activeData.length - answeredCount;
}

function peoSubmitOnlineTest() {
    document.getElementById("peo-workspace").style.display = "none";
    submitExam(); // shared scoring/save/results logic — operates on the same activeData/responses
}

// ─── Opening a topic → question attempt screen ─────────────
async function openPETopic(peType, topic) {
    clearActivePEPracticeMemory();
    if (peType === "Data Interpretation") {
        openPEDIViewer(topic);
        return;
    }
    peActiveTopic = { peType, topic };
    document.querySelectorAll(".pe-content .pe-section").forEach(s => s.classList.remove("active"));
    document.getElementById("pe-question-screen").classList.add("active");
    const container = document.getElementById("pe-questions-container");
    if (container) container.innerHTML = '<div class="pe-empty-msg">Loading questions…</div>';

    try {
        await ensurePETopicQuestions(peType, topic);
    } catch (error) {
        console.error("PE topic question load failed:", error);
        if (container) container.innerHTML = '<div class="pe-empty-msg">Could not load this topic. Please try again.</div>';
        showToast("Could not load this topic. Please try again.", "error");
        return;
    }

    if (!peActiveTopic || peActiveTopic.peType !== peType || peActiveTopic.topic !== topic) return;
    renderPEQuestionList();

    try {
        await prefetchPETopicMedia(peType, topic, { blockForMs: 900 });
        if (peActiveTopic && peActiveTopic.peType === peType && peActiveTopic.topic === topic) {
            renderPEQuestionList();
        }
    } catch (error) {
        console.error("PE topic media load failed:", error);
        showToast("The questions loaded, but some media could not be downloaded.", "info");
    }
}

function showPEFolderScreen() {
    if (!peActiveTopic) return;
    const returnType = peActiveTopic.peType;
    clearActivePEPracticeMemory();
    peActiveTopic = null;

    const targetPanelId = returnType === PE_BCSC_MAIN_TYPE ? "pe-mock-panel"
        : returnType === "Past Paper" ? "pe-past-panel"
        : "pe-home-panel";

    document.querySelectorAll("#pe-list .pe-list-item").forEach(li => {
        li.classList.toggle("active", li.dataset.target === targetPanelId);
    });
    document.querySelectorAll(".pe-content .pe-section").forEach(s => s.classList.remove("active"));
    document.getElementById(targetPanelId).classList.add("active");
}

// ─── DATA INTERPRETATION: split-screen viewer ──────────────────
// Chart pane stays fixed on the left (position: sticky) while the
// question pane on the right shows one question at a time with // Next/Previous — same model GMAT/GRE/CAT use for chart-based sets.
let peDIActiveSet = null; // the set/topic name currently open in the viewer
let peDIQuestionObserver = null;
let peDIActiveGraphIndex = 0;

function renderPEDIGrid() {
    const grid = document.getElementById("pe-di-grid");
    if (!grid) return;
    const searchTerm = document.getElementById("pe-di-search")?.value || "";
    const sets = buildPETopicList("Data Interpretation", searchTerm);

    if (sets.length === 0) {
        grid.innerHTML = '<div class="pe-empty-msg">No Data Interpretation sets are available yet.</div>';
        return;
    }

    grid.innerHTML = sets.map(s => `
            <div class="pe-card accent-purple" data-di-topic="${escapeHTML(s.topic)}">
                <i class="bi bi-bar-chart-line pe-card-icon"></i>
                <div class="pe-card-info">
                    <div class="pe-card-title">${escapePEHtml(s.topic)}</div>
                    <div class="pe-card-meta"> ${s.count} question${s.count === 1 ? "" : "s"}</div>
                </div>
            </div>
    `).join("");

    grid.querySelectorAll(".pe-card[data-di-topic]").forEach(card => {
        card.addEventListener("click", () => {
            openPEDIViewer(card.dataset.diTopic || "");
        });
    });
}

async function openPEDIViewer(setName) {
    clearActivePEPracticeMemory();
    peDIActiveSet = setName;
    peDIActiveGraphIndex = 0;

    document.querySelectorAll(".pe-content .pe-section").forEach(s => s.classList.remove("active"));
    document.getElementById("pe-di-viewer-screen").classList.add("active");

    const chartImg = document.getElementById("pe-di-chart-img");
    document.getElementById("pe-di-set-title").textContent = setName;
    document.getElementById("pe-di-questions-container").innerHTML = '<div class="pe-empty-msg">Loading questions…</div>';

    let setQuestions = [];
    try {
        setQuestions = await ensurePETopicQuestions("Data Interpretation", setName);
    } catch (error) {
        console.error("Data Interpretation question load failed:", error);
        if (peDIActiveSet === setName) {
            document.getElementById("pe-di-questions-container").innerHTML = '<div class="pe-empty-msg">Could not load this set. Please try again.</div>';
            showPEDIChart("");
            renderPEDIGraphControls(0);
            showToast("Could not load this Data Interpretation set. Please try again.", "error");
        }
        return;
    }
    if (peDIActiveSet !== setName) return;
    renderPEDIQuestion();

    const firstCachedGraph = setQuestions
        .map(question => safeMediaURL(question.imageCode, "image"))
        .find(Boolean) || "";
    if (firstCachedGraph) chartImg.src = firstCachedGraph;
    else chartImg.removeAttribute("src");
    if (!setQuestions.length) return;
    try {
        await prefetchPEDISetGraph(setName, { blockForMs: 1200 });
        // The short wait keeps opening responsive; then finish the queued
        // media request so a slower second/third chart is never skipped.
        const mediaPromise = peDIGraphPrefetch.get(String(setName || "").trim());
        if (mediaPromise) await mediaPromise;
        if (peDIActiveSet !== setName) return;
        // Re-render after media arrives. This assigns every question to the
        // correct sequential chart group and resets numbering for that group.
        renderPEDIQuestion();
    } catch (error) {
        console.error("Data Interpretation graph load failed:", error);
        if (peDIActiveSet === setName) {
            showToast("The questions opened, but the graph could not be downloaded.", "info");
        }
    }
}

function closePEDIViewer() {
    peDIQuestionObserver?.disconnect();
    peDIQuestionObserver = null;
    clearActivePEPracticeMemory();
    peDIActiveSet = null;
    peDIActiveGraphIndex = 0;
    document.querySelectorAll("#pe-list .pe-list-item").forEach(li => {
        li.classList.toggle("active", li.dataset.target === "pe-di-panel");
    });
    document.querySelectorAll(".pe-content .pe-section").forEach(s => s.classList.remove("active"));
    document.getElementById("pe-di-panel").classList.add("active");
    renderPEDIGrid();
}

function getPEDISetQuestions(setName) {
    return getPETopicQuestions("Data Interpretation", setName);
}

function isPEWrittenAnswer(question) {
    return question?.answerType === "written";
}

function writtenAnswerControlHtml(qId) {
    return `
        <div class="pe-written-answer" id="${qId}-written-wrap">
            <label for="${qId}-written-input">Your answer</label>
            <input type="text" id="${qId}-written-input" autocomplete="off" spellcheck="false" placeholder="Write your answer">
        </div>
    `;
}

function writtenAnswerActionHtml(qId) {
    return `
        <button type="button" class="pe-answer-toggle" data-pe-written-answer-qid="${qId}">Check answer</button>
        <div class="pe-feedback-msg" id="${qId}-feedback"></div>
    `;
}

function setPEWrittenAnswerLoading(qId, loading) {
    const input = document.getElementById(`${qId}-written-input`);
    const button = document.querySelector(`[data-pe-written-answer-qid="${qId}"]`);
    if (input) input.disabled = loading;
    if (button) button.disabled = loading;
}

function lockPEWrittenAnswer(qId) {
    const input = document.getElementById(`${qId}-written-input`);
    const button = document.querySelector(`[data-pe-written-answer-qid="${qId}"]`);
    if (input) input.disabled = true;
    if (button) button.disabled = true;
}

async function answerPEWrittenQuestion(qId) {
    const input = document.getElementById(`${qId}-written-input`);
    const writtenAnswer = String(input?.value || "");
    if (!writtenAnswer.trim()) {
        showToast("Please write your answer first.", "info");
        input?.focus();
        return;
    }
    setPEWrittenAnswerLoading(qId, true);
    let result;
    try {
        const question = pePracticeQuestionsByDomId.get(qId);
        if (!question) throw new Error("Question is no longer available.");
        result = await apiRequest("question-solution", {
            method: "POST",
            body: { id: String(question.id), written_answer: writtenAnswer }
        });
    } catch (error) {
        setPEWrittenAnswerLoading(qId, false);
        showToast(`Could not check answer: ${error.message}`, "error");
        return;
    }
    lockPEWrittenAnswer(qId);
    const feedback = document.getElementById(`${qId}-feedback`);
    const solutionText = document.getElementById(`${qId}-solution`)?.querySelector(".pe-solution-text");
    const serverExplanation = typeof result.explanation === "string" ? result.explanation.trim() : "";
    if (serverExplanation && solutionText) solutionText.textContent = serverExplanation;
    togglePESolution(qId, true);
    if (result.correct === true) {
        if (feedback) { feedback.textContent = "Correct!"; feedback.className = "pe-feedback-msg correct"; }
    } else if (feedback) {
        feedback.textContent = "Not quite.";
        feedback.className = "pe-feedback-msg incorrect";
    }
}

function hammingDistance(a, b) {
    if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
    let distance = 0;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) distance += 1;
    }
    return distance;
}

function isSamePEDIGraphKey(nextKey, activeKey) {
    if (!nextKey || !activeKey) return false;
    if (nextKey === activeKey) return true;
    if (nextKey.startsWith("hash:") && activeKey.startsWith("hash:")) {
        // 16x16 average hash = 256 bits. Re-uploaded copies of the same chart
        // can differ a little after compression/cropping, so allow a small gap.
        return hammingDistance(nextKey.slice(5), activeKey.slice(5)) <= 18;
    }
    return false;
}

async function getPEDIGraphFingerprint(source) {
    source = String(source || "").trim();
    if (!source) return "";
    if (peDIGraphFingerprintCache.has(source)) return peDIGraphFingerprintCache.get(source);

    const promise = new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            try {
                const size = 16;
                const canvas = document.createElement("canvas");
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                ctx.drawImage(img, 0, 0, size, size);
                const data = ctx.getImageData(0, 0, size, size).data;
                const grayscale = [];
                for (let i = 0; i < data.length; i += 4) {
                    grayscale.push((data[i] * 0.299) + (data[i + 1] * 0.587) + (data[i + 2] * 0.114));
                }
                const average = grayscale.reduce((sum, value) => sum + value, 0) / grayscale.length;
                resolve(`hash:${grayscale.map(value => value >= average ? "1" : "0").join("")}`);
            } catch (error) {
                // If the browser blocks canvas reads for a remote image, fall
                // back to the exact source string. Data/blob images still hash.
                resolve(`src:${source}`);
            }
        };
        img.onerror = () => resolve(`src:${source}`);
        img.src = source;
    });

    peDIGraphFingerprintCache.set(source, promise);
    const key = await promise;
    peDIGraphFingerprintCache.set(source, key);
    return key;
}

async function preparePEDIGraphFingerprints(setName) {
    const setQuestions = getPEDISetQuestions(setName);
    await Promise.all(setQuestions.map(async question => {
        const source = safeMediaURL(question.imageCode, "image");
        question._diGraphSource = source;
        question._diGraphKey = source ? await getPEDIGraphFingerprint(source) : "";
    }));
}

function buildPEDIQuestionGroups(setQuestions) {
    let activeGraph = "";
    let activeGraphKey = "";
    const groups = [];

    (setQuestions || []).forEach(question => {
        const uploadedGraph = safeMediaURL(question.imageCode, "image");
        const uploadedGraphKey = question._diGraphKey || uploadedGraph;
        if (!groups.length || (uploadedGraph && !isSamePEDIGraphKey(uploadedGraphKey, activeGraphKey))) {
            activeGraph = uploadedGraph;
            activeGraphKey = uploadedGraphKey;
            groups.push({ graphSource: activeGraph, questions: [] });
        }
        groups[groups.length - 1].questions.push(question);
    });

    return groups.map(group => ({
        ...group,
        questions: [...group.questions].sort((a, b) => (a._peRandomSort || 0) - (b._peRandomSort || 0))
    }));
}

function showPEDIChart(graphSource) {
    const chartImg = document.getElementById("pe-di-chart-img");
    if (!chartImg) return;
    graphSource = String(graphSource || "").trim();
    if (graphSource && chartImg.src !== graphSource) chartImg.src = graphSource;
    else if (!graphSource) chartImg.removeAttribute("src");
}

function ensurePEDIGraphControls() {
    const title = document.getElementById("pe-di-set-title");
    if (!title || !title.parentElement) return null;
    let controls = document.getElementById("pe-di-graph-controls");
    if (!controls) {
        controls = document.createElement("div");
        controls.id = "pe-di-graph-controls";
        controls.className = "pe-di-graph-controls";
        title.insertAdjacentElement("afterend", controls);
    }
    return controls;
}

function renderPEDIGraphControls(groupCount) {
    const controls = ensurePEDIGraphControls();
    if (!controls) return;
    if (groupCount <= 1) {
        controls.innerHTML = "";
        return;
    }

    controls.innerHTML = `
        <div class="pe-di-graph-count">Graph ${peDIActiveGraphIndex + 1} of ${groupCount}</div>
        <div class="pe-di-graph-buttons">
            <button type="button" class="pe-di-graph-btn" data-di-graph-nav="prev" ${peDIActiveGraphIndex <= 0 ? "disabled" : ""}>Previous graph</button>
            <button type="button" class="pe-di-graph-btn primary" data-di-graph-nav="next" ${peDIActiveGraphIndex >= groupCount - 1 ? "disabled" : ""}>Next graph</button>
        </div>
    `;

    controls.querySelectorAll("[data-di-graph-nav]").forEach(button => {
        button.addEventListener("click", () => {
            const direction = button.dataset.diGraphNav === "next" ? 1 : -1;
            peDIActiveGraphIndex = Math.min(groupCount - 1, Math.max(0, peDIActiveGraphIndex + direction));
            renderPEDIQuestion();
            document.querySelector(".pe-di-split-right")?.scrollTo({ top: 0, behavior: "smooth" });
        });
    });
}

function observePEDIChartGroups(container) {
    peDIQuestionObserver?.disconnect();
    peDIQuestionObserver = null;
    const cards = [...container.querySelectorAll("[data-di-graph-src]")];
    if (!cards.length) return;

    showPEDIChart(cards[0].dataset.diGraphSrc || "");
}

function renderPEDIQuestion() {
    const container = document.getElementById("pe-di-questions-container");
    if (!peDIActiveSet) {
        container.innerHTML = "";
        renderPEDIGraphControls(0);
        showPEDIChart("");
        return;
    }

    const setQuestions = getPEDISetQuestions(peDIActiveSet);
    if (setQuestions.length === 0) {
        container.innerHTML = '<div class="pe-empty-msg">No questions in this set.</div>';
        renderPEDIGraphControls(0);
        showPEDIChart("");
        return;
    }

    pePracticeQuestionsByDomId.clear();
    const groupedQuestions = buildPEDIQuestionGroups(setQuestions);
    peDIActiveGraphIndex = Math.min(groupedQuestions.length - 1, Math.max(0, peDIActiveGraphIndex));
    const activeGroup = groupedQuestions[peDIActiveGraphIndex] || { graphSource: "", questions: [] };
    renderPEDIGraphControls(groupedQuestions.length);
    showPEDIChart(activeGroup.graphSource);

    container.innerHTML = activeGroup.questions.map((q, questionIndex) => {
        const options = Array.isArray(q.options) ? q.options : [];
        const isWritten = isPEWrittenAnswer(q);
        const qId = `pe-di-g-${peDIActiveGraphIndex}-q-${questionIndex}`;
        pePracticeQuestionsByDomId.set(qId, q);
        const optionsHtml = options.slice(0, 4).map((opt, optionIndex) => `
            <button type="button" class="pe-option" id="${qId}-opt-${optionIndex}"
                data-pe-answer-qid="${qId}" data-pe-answer-opt="${optionIndex}">
                ${ALPHA[optionIndex]}. ${escapePEHtml(opt || "")}
            </button>
        `).join("");
        return `
            <div class="pe-question-card accent-purple"
                 data-di-graph-src="${escapeHTML(activeGroup.graphSource)}"
                 data-di-graph-group="${peDIActiveGraphIndex}">
                <div class="pe-question-meta">
                    <div class="pe-question-num">${questionIndex + 1}</div>
                    <span class="pe-question-tag">Data Interpretation</span>
                    <span class="pe-question-tag">${escapePEHtml(peDIActiveSet)}</span>
                </div>
                <div class="pe-question-text">${escapePEHtml(q.question || "")}</div>
                ${safeMediaSource(q.audioCode, "audio") ? `<div class="q-audio-wrap"><audio src="${safeMediaSource(q.audioCode, "audio")}" class="q-audio" controls preload="metadata"></audio></div>` : ""}
                ${isWritten ? writtenAnswerControlHtml(qId) : `<div class="pe-options-grid" id="${qId}-options">${optionsHtml}</div>`}
                <div class="pe-question-actions">
                    ${isWritten ? writtenAnswerActionHtml(qId) : `<button type="button" class="pe-answer-toggle" data-pe-solution-toggle="${qId}" aria-expanded="false">Show answer</button><div class="pe-feedback-msg" id="${qId}-feedback"></div>`}
                </div>
                <div class="pe-solution-box accent-purple" id="${qId}-solution">
                    <div class="pe-solution-title">💡 Solution &amp; Explanation</div>
                    <div class="pe-solution-text">${escapePEHtml(q.explanation || "No explanation has been added yet.")}</div>
                </div>
            </div>
        `;
    }).join("");

    container.querySelectorAll("[data-pe-answer-qid]").forEach((button) => {
        button.addEventListener("click", () => answerPEQuestion(button.dataset.peAnswerQid || "", Number(button.dataset.peAnswerOpt)));
    });
    container.querySelectorAll("[data-pe-written-answer-qid]").forEach((button) => {
        button.addEventListener("click", () => answerPEWrittenQuestion(button.dataset.peWrittenAnswerQid || ""));
    });
    bindPESolutionToggles(container);
    observePEDIChartGroups(container);
}

// ─── Question attempt flow (attempt first, then reveal) ────
function renderPEQuestionList() {
    const container = document.getElementById("pe-questions-container");
    if (!peActiveTopic) { container.innerHTML = ""; return; }

    const list = getPETopicQuestions(peActiveTopic.peType, peActiveTopic.topic);

    if (list.length === 0) {
        container.innerHTML = '<div class="pe-empty-msg">No questions in this topic yet.</div>';
        return;
    }

    pePracticeQuestionsByDomId.clear();
    container.innerHTML = list.map((q, idx) => {
        const peInfo = parsePECategory(q.category);
        const options = Array.isArray(q.options) ? q.options : [];
        const isWritten = isPEWrittenAnswer(q);
        const qId = `pe-q-${idx}`;
        const accent = peInfo.peType === "Past Paper" ? "#4caf50" : "#00bcd4";
        pePracticeQuestionsByDomId.set(qId, q);

        // Options render as plain, un-revealed buttons — the correct
        // answer is never marked in the initial HTML.
        const optionsHtml = options.slice(0, 4).map((opt, i) => `
            <button type="button" class="pe-option" id="${qId}-opt-${i}"
                data-pe-answer-qid="${qId}" data-pe-answer-opt="${i}">
                ${ALPHA[i]}. ${escapePEHtml(opt || "")}
            </button>
        `).join("");

        const accentClass = accentClassFromColor(accent);
        const explanationHtml = `
            <div class="pe-solution-box ${accentClass}" id="${qId}-solution">
                <div class="pe-solution-title">💡 Solution &amp; Explanation</div>
                <div class="pe-solution-text">${escapePEHtml(q.explanation || "No explanation has been added yet.")}</div>
            </div>
        `;

        return `
            <div class="pe-question-card ${accentClass}">
                <div class="pe-question-meta">
                    <div class="pe-question-num">${idx + 1}</div>
                    <span class="pe-question-tag">${escapeHTML(peInfo.peType)}</span>
                    <span class="pe-question-tag">${escapePEHtml(peInfo.topic)}</span>
                </div>
                <div class="pe-question-text">${escapePEHtml(q.question || "")}</div>
                ${safeMediaSource(q.imageCode, "image") ? `<img src="${safeMediaSource(q.imageCode, "image")}" class="pe-question-image" alt="Question image" loading="lazy" decoding="async">` : ""}
                ${safeMediaSource(q.audioCode, "audio") ? `<div class="q-audio-wrap"><audio src="${safeMediaSource(q.audioCode, "audio")}" class="q-audio" controls preload="metadata"></audio></div>` : ""}
                ${isWritten ? writtenAnswerControlHtml(qId) : `<div class="pe-options-grid" id="${qId}-options">${optionsHtml}</div>`}
                <div class="pe-question-actions">
                    ${isWritten ? writtenAnswerActionHtml(qId) : `<button type="button" class="pe-answer-toggle" data-pe-solution-toggle="${qId}" aria-expanded="false">Show answer</button><div class="pe-feedback-msg" id="${qId}-feedback"></div>`}
                </div>
                ${explanationHtml}
            </div>
        `;
    }).join("");

    container.querySelectorAll("[data-pe-answer-qid]").forEach((button) => {
        button.addEventListener("click", () => answerPEQuestion(button.dataset.peAnswerQid || "", Number(button.dataset.peAnswerOpt)));
    });
    container.querySelectorAll("[data-pe-written-answer-qid]").forEach((button) => {
        button.addEventListener("click", () => answerPEWrittenQuestion(button.dataset.peWrittenAnswerQid || ""));
    });
    bindPESolutionToggles(container);
}

function togglePESolution(qId, forceOpen = null) {
    const solution = document.getElementById(`${qId}-solution`);
    const toggle = [...document.querySelectorAll("[data-pe-solution-toggle]")]
        .find(button => button.dataset.peSolutionToggle === qId);
    if (!solution) return;
    const shouldOpen = forceOpen === null ? !solution.classList.contains("open") : Boolean(forceOpen);
    solution.classList.toggle("open", shouldOpen);
    if (toggle) {
        toggle.textContent = shouldOpen ? "Hide answer" : "Show answer";
        toggle.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
    }
}

function bindPESolutionToggles(container) {
    container.querySelectorAll("[data-pe-solution-toggle]").forEach(button => {
        button.addEventListener("click", () => togglePESolution(button.dataset.peSolutionToggle || ""));
    });
}

function lockPEOptions(qId) {
    document.querySelectorAll(`#${qId}-options .pe-option`).forEach(btn => {
        btn.classList.add("pe-locked");
        btn.disabled = true;
    });
}

function setPEQuestionLoading(qId, loading) {
    document.querySelectorAll(`#${qId}-options .pe-option`).forEach(button => {
        button.disabled = loading;
    });
}

async function answerPEQuestion(qId, chosenIndex) {
    setPEQuestionLoading(qId, true);
    let result;
    try {
        const question = pePracticeQuestionsByDomId.get(qId);
        if (!question) throw new Error("Question is no longer available.");
        const originalOptionIndexes = Array.isArray(question._optionOriginalIndexes) ? question._optionOriginalIndexes : [];
        const originalSelectedIndex = Number.isInteger(originalOptionIndexes[chosenIndex])
            ? originalOptionIndexes[chosenIndex]
            : chosenIndex;
        result = await apiRequest("question-solution", {
            method: "POST",
            body: { id: String(question.id), selected_index: originalSelectedIndex }
        });
    } catch (error) {
        setPEQuestionLoading(qId, false);
        showToast(`Could not check answer: ${error.message}`, "error");
        return;
    }
    lockPEOptions(qId);
    const chosenBtn = document.getElementById(`${qId}-opt-${chosenIndex}`);
    const feedback = document.getElementById(`${qId}-feedback`);
    const solutionText = document.getElementById(`${qId}-solution`)?.querySelector(".pe-solution-text");
    const serverExplanation = typeof result.explanation === "string" ? result.explanation.trim() : "";
    if (serverExplanation && solutionText) {
        solutionText.textContent = serverExplanation;
    }
    togglePESolution(qId, true);

    if (result.correct === true) {
        chosenBtn?.classList.add("pe-correct");
        if (feedback) { feedback.textContent = "✓ Correct!"; feedback.className = "pe-feedback-msg correct"; }
    } else {
        chosenBtn?.classList.add("pe-incorrect");
        if (feedback) { feedback.textContent = "✕ Not quite."; feedback.className = "pe-feedback-msg incorrect"; }
    }
}

function escapePEHtml(text) {
    return escapeHTML(text);
}

function accentClassFromColor(color) {
    switch (String(color || "").toLowerCase()) {
        case "#f44336": return "accent-red";
        case "#38bdf8": return "accent-sky";
        case "#00bcd4": return "accent-cyan";
        case "#4caf50": return "accent-green";
        case "#9c27b0": return "accent-purple";
        case "#ff9800": return "accent-orange";
        default: return "";
    }
}
