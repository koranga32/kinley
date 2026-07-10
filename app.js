// ─── CONFIG ──────────────────────────────────────────
// All database access is routed through same-origin Cloudflare API functions.
// Supabase secrets and privileged credentials never belong in this file.
const ALPHA = ["A","B","C","D"];
const DB_TIMEOUT_MS = 60000;
const API_TIMEOUT_MS = 20000;
const DB_CACHE_KEY = "supabase_exam_pool_v2_no_answers";
const ADMIN_SESSION_KEY = "examportal_admin_session_v1";
const ADMIN_LOGIN_EMAIL_KEY = "examportal_admin_login_email_v1";
const ADMIN_QUESTION_CONTEXT_KEY = "examportal_admin_question_context_v1";
const ADMIN_FLASHCARD_CONTEXT_KEY = "examportal_admin_flashcard_context_v1";
const ADMIN_THEME_MODE_KEY = "examportal_admin_theme_mode_v1";
const ADMIN_PROFILE_KEY = "examportal_admin_profile_v1";
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
let publicApiCache = new Map();
let peQuestionsCache = [];
let peTopicBuckets = new Map();
let cafStateLoaded = false;
let cafStatePromise = null;
let adminSessionActive = false;
let adminRecoveryAccessToken = "";
let adminOtpState = null;
let adminAuthenticationPending = false;
let adminPrincipal = null;
let adminProfile = null;
let adminRoles = [];
let activeAdminSection = "questions";
let activeAdminAccountPanel = "profile";
let adminSessionRefreshTimer = null;
let adminSessionRefreshPromise = null;
let adminSessionExpiryNoticeShown = false;
let editingCafCardId = "";
let editingQuoteId = "";
let adminPEResources = [];
let editingQuestionIndex = null;
let submitInProgress = false;
const QUESTION_PREFETCH_AHEAD = 5;
let adminSidebarHoverOpenTimer = null;
let adminSidebarHoverCloseTimer = null;

function bindStaticUiEvents() {
    document.getElementById("admin-email-input")?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") authenticateAdmin();
    });
    document.getElementById("admin-pw-input")?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") authenticateAdmin();
    });
    document.getElementById("admin-email-input")?.addEventListener("input", (event) => {
        rememberAdminLoginEmail(event.target.value);
    });
    document.getElementById("pw-eye")?.addEventListener("click", togglePwVisibility);
    getAdminOtpDigitInputs().forEach((input, index) => {
        input.addEventListener("input", (event) => handleAdminOtpDigitInput(event, index));
        input.addEventListener("keydown", (event) => handleAdminOtpDigitKeydown(event, index));
    });
    document.getElementById("admin-modal-clear-btn")?.addEventListener("click", clearAdminGatewayFields);
    document.getElementById("admin-modal-auth-btn")?.addEventListener("click", authenticateAdmin);
    document.getElementById("password-recovery-form")?.addEventListener("submit", submitRecoveredPassword);
    document.getElementById("password-recovery-cancel-btn")?.addEventListener("click", closePasswordRecovery);
    document.getElementById("admin-modal")?.addEventListener("pointerdown", keepAdminModalLocked);
    document.getElementById("admin-modal")?.addEventListener("click", keepAdminModalLocked);
    document.getElementById("admin-shell")?.classList.remove("is-hover-expanded");
    document.getElementById("admin-shell")?.classList.add("is-collapsed");
    document.querySelector(".admin-bank-sidebar")?.addEventListener("mouseenter", () => queueAdminSidebarHover(true));
    document.querySelector(".admin-bank-sidebar")?.addEventListener("mouseleave", () => queueAdminSidebarHover(false));
    document.querySelectorAll("[data-admin-section-link]").forEach((button) => {
        button.addEventListener("click", () => setAdminSection(button.dataset.adminSectionLink || "questions"));
    });
    document.getElementById("admin-account-trigger")?.addEventListener("click", toggleAdminAccountMenu);
    document.querySelectorAll("[data-admin-account-panel]").forEach((button) => {
        button.addEventListener("click", () => setAdminAccountPanel(button.dataset.adminAccountPanel || "profile"));
    });
    document.querySelectorAll("[data-admin-theme]").forEach((button) => {
        button.addEventListener("click", () => applyThemeMode(button.dataset.adminTheme || "light"));
    });
    document.getElementById("admin-profile-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void saveAdminProfileCard();
    });
    document.getElementById("admin-profile-upload-btn")?.addEventListener("click", () => {
        document.getElementById("admin-profile-avatar-file")?.click();
    });
    document.getElementById("admin-profile-avatar-file")?.addEventListener("change", handleAdminProfileAvatarUpload);

    document.getElementById("question-view-modal")?.addEventListener("click", handleQuestionViewBackdropClick);
    document.getElementById("question-view-close-btn")?.addEventListener("click", closeQuestionView);

    document.getElementById("contact-modal")?.addEventListener("click", handleContactBackdropClick);
    document.getElementById("contact-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        submitContactForm();
    });
    document.getElementById("contact-modal-close-btn")?.addEventListener("click", closeContactModal);

    document.getElementById("theme-toggle-btn")?.addEventListener("click", toggleThemeMode);
    document.getElementById("contact-btn")?.addEventListener("click", openContactModal);
    document.getElementById("pe-btn")?.addEventListener("click", openPEPortal);
    document.getElementById("admin-btn")?.addEventListener("click", openAdminPortal);
    document.getElementById("admin-back-btn")?.addEventListener("click", closeAdminPortal);
    document.getElementById("admin-profile-logout-btn")?.addEventListener("click", closeAdminPortal);
    document.getElementById("pe-back-btn")?.addEventListener("click", closePEPortal);

    document.getElementById("student-name")?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") startExam();
    });
    document.getElementById("category-select")?.addEventListener("change", updateTestSummary);
    document.getElementById("start-btn")?.addEventListener("click", startExam);
    document.getElementById("normal-sidebar-submit-btn")?.addEventListener("click", submitExam);

    document.getElementById("peo-btn-prev")?.addEventListener("click", () => { void peoNavigateBack(); });
    document.getElementById("peo-submit-btn")?.addEventListener("click", peoSubmitOnlineTest);
    document.getElementById("pe-return-online-btn")?.addEventListener("click", returnToPEOnlineTestPage);
    document.getElementById("results-return-home-btn")?.addEventListener("click", retakeExam);

    document.getElementById("admin-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        saveQuestion();
    });
    document.querySelectorAll('input[name="dest-mode"]').forEach((input) => {
        input.addEventListener("change", onDestModeChange);
    });
    document.querySelectorAll('input[name="pe-type"]').forEach((input) => {
        input.addEventListener("change", onPeTypeChange);
    });
    document.querySelectorAll('input[name="cat-mode"]').forEach((input) => {
        input.addEventListener("change", onCatModeChange);
    });
    document.getElementById("adm-cat-select")?.addEventListener("change", () => rememberAdminQuestionContext());
    document.getElementById("adm-cat-select")?.addEventListener("change", updateBulkImportPreview);
    document.getElementById("adm-cat-input")?.addEventListener("input", () => { rememberAdminQuestionContext(); updateBulkImportPreview(); });
    document.getElementById("adm-pe-topic")?.addEventListener("input", () => { rememberAdminQuestionContext(); updateBulkImportPreview(); });
    document.getElementById("adm-img-file")?.addEventListener("change", (event) => handleImageUpload(event.target));
    document.getElementById("adm-audio-file")?.addEventListener("change", (event) => handleAudioUpload(event.target));
    document.getElementById("cancel-edit-btn")?.addEventListener("click", cancelQuestionEdit);

    document.getElementById("caf-admin-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        cafSaveAdminCard();
    });
    document.getElementById("caf-admin-scope")?.addEventListener("change", cafPopulateAdminCategories);
    document.getElementById("caf-admin-scope")?.addEventListener("change", () => rememberAdminFlashcardContext());
    document.getElementById("caf-admin-category")?.addEventListener("change", () => rememberAdminFlashcardContext());
    document.getElementById("caf-admin-category-new")?.addEventListener("input", () => rememberAdminFlashcardContext());
    document.querySelectorAll('input[name="caf-cat-mode"]').forEach((input) => {
        input.addEventListener("change", cafApplyAdminCategoryMode);
    });
    document.getElementById("caf-admin-clear-btn")?.addEventListener("click", cafResetAdminForm);
    document.getElementById("caf-admin-cancel-btn")?.addEventListener("click", cafCancelEdit);

    document.getElementById("quote-admin-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        saveDailyQuote();
    });
    document.getElementById("quote-admin-cancel-btn")?.addEventListener("click", cancelDailyQuoteEdit);
    document.getElementById("pe-resource-admin-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void saveAdminPEResource();
    });
    document.getElementById("pe-resource-clear-btn")?.addEventListener("click", resetAdminPEResourceForm);
    document.getElementById("pe-resource-document-file")?.addEventListener("change", (event) => {
        void readPEResourceDocumentFile(event.target, "pe-resource-document");
    });
    document.getElementById("pe-resource-preview-file")?.addEventListener("change", (event) => {
        void readPEResourceImageFile(event.target, "pe-resource-preview");
    });
    document.getElementById("admin-role-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        saveAdminRole();
    });
    document.getElementById("admin-role-cancel-btn")?.addEventListener("click", resetAdminRoleForm);

    document.getElementById("bulk-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        saveBulkQuestions();
    });
    document.getElementById("bulk-questions")?.addEventListener("input", updateBulkImportPreview);

    document.getElementById("pe-home-search")?.addEventListener("input", renderPEHomeGrid);
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
    "#adm-img-preview",
    ".q-image",
    ".pe-question-image",
    ".question-view-image"
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
        localStorage.removeItem(ADMIN_PROFILE_KEY);
        applyThemeMode(localStorage.getItem(ADMIN_THEME_MODE_KEY) || "light");
        bindStaticUiEvents();
        const copyrightEl = document.getElementById("site-copyright");
        if (copyrightEl) copyrightEl.textContent = `© ${new Date().getFullYear()}`;
        caHydrateAdminControls();
        hydrateAdminProfileCard();
        if (capturePasswordRecoverySession()) return;
        if (await restoreAdminSession()) {
            // Reveal the saved admin workspace immediately. Authentication and
            // fresh data are verified quietly so refreshes do not flash a
            // full-screen "Connecting" overlay.
            closeAdminModal();
            document.body.classList.add("admin-mode");
            document.getElementById("setup-view").style.display = "none";
            document.getElementById("admin-view")?.classList.remove("is-hidden");
            document.getElementById("admin-top-tools")?.classList.remove("is-hidden");
            document.getElementById("admin-back-btn")?.classList.remove("is-hidden");
            hideTopActionButtons();
            try {
                await restoreAdminPortal();
                return;
            } catch (error) {
                if (error?.status === 401 || error?.status === 403) clearAdminSession();
                document.body.classList.remove("admin-mode");
                document.getElementById("admin-view")?.classList.add("is-hidden");
                document.getElementById("admin-top-tools")?.classList.add("is-hidden");
                document.getElementById("admin-back-btn")?.classList.add("is-hidden");
                showToast(
                    error?.status === 401 || error?.status === 403
                        ? "Admin session expired. Please sign in again."
                        : "Admin data could not be loaded. Refresh to retry your saved session.",
                    "info"
                );
            }
        }
	    openAdminPortal();
	}

    function capturePasswordRecoverySession() {
        const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        const accessToken = String(params.get("access_token") || "");
        const recoveryType = params.get("type") === "recovery";
        if (!recoveryType || !accessToken) return false;
        adminRecoveryAccessToken = accessToken;
        history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        closeAdminModal();
        document.getElementById("password-recovery-modal")?.classList.add("open");
        setTimeout(() => document.getElementById("recovery-password")?.focus(), 100);
        return true;
    }

    function closePasswordRecovery() {
        adminRecoveryAccessToken = "";
        document.getElementById("password-recovery-form")?.reset();
        document.getElementById("password-recovery-modal")?.classList.remove("open");
        openAdminPortal();
    }

    async function submitRecoveredPassword(event) {
        event.preventDefault();
        const password = document.getElementById("recovery-password")?.value || "";
        const confirmation = document.getElementById("recovery-password-confirm")?.value || "";
        const error = document.getElementById("recovery-password-error");
        if (password.length < 8 || password !== confirmation) {
            error.textContent = password.length < 8 ? "Use at least 8 characters." : "Passwords do not match.";
            error.classList.add("visible");
            return;
        }
        if (!adminRecoveryAccessToken) {
            error.textContent = "This recovery link is invalid or expired.";
            error.classList.add("visible");
            return;
        }
        error.classList.remove("visible");
        showLoading(true, "Updating password...");
        try {
            await apiRequest("admin-password-recovery", {
                method: "POST",
                body: { access_token: adminRecoveryAccessToken, password }
            });
            clearAdminSession();
            closePasswordRecovery();
            showToast("Password updated. Sign in with your new password.", "success");
        } catch (requestError) {
            error.textContent = requestError?.message || "Password could not be updated.";
            error.classList.add("visible");
        } finally {
            showLoading(false);
        }
    }

    document.addEventListener("pointerdown", () => {
        touchAdminSession();
    });

    document.addEventListener("keydown", () => {
        touchAdminSession();
    });

    document.addEventListener("click", (event) => {
        const account = document.getElementById("admin-account");
        if (account && !account.contains(event.target)) closeAdminAccountMenu();
    });

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden && adminSessionActive) {
            void refreshAdminSession({ reason: "tab-active" }).catch(() => {});
        }
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && shouldLockAdminGateway()) {
            event.preventDefault();
            focusAdminGatewayPrimaryField();
        }
    });

    function applyThemeMode(mode) {
        const useDark = mode === "dark";
        document.documentElement.classList.add("theme-switch-instant");
        document.body.classList.toggle("dark-theme", useDark);
        const btn = document.getElementById("theme-toggle-btn");
        if (btn) btn.textContent = useDark ? "☀ Light" : "🌙 Dark";
        document.querySelectorAll("[data-admin-theme]").forEach((button) => {
            button.classList.toggle("active", button.dataset.adminTheme === (useDark ? "dark" : "light"));
        });
        try {
            localStorage.setItem(ADMIN_THEME_MODE_KEY, useDark ? "dark" : "light");
        } catch (e) {}
        void document.body.offsetWidth;
        requestAnimationFrame(() => document.documentElement.classList.remove("theme-switch-instant"));
    }

    function toggleThemeMode() {
        const nextMode = document.body.classList.contains("dark-theme") ? "light" : "dark";
        applyThemeMode(nextMode);
    }

    function persistAdminSession() {
        clearLegacyAdminTokenStorage();
    }

    async function restoreAdminSession() {
        try {
            clearLegacyAdminTokenStorage();
            const restored = await refreshAdminSession({ reason: "restore", forceLogout: false });
            adminSessionActive = Boolean(restored?.principal);
            return true;
        } catch (e) {
            adminSessionActive = false;
            return false;
        }
    }

function clearLegacyAdminTokenStorage() {
        try { sessionStorage.removeItem(ADMIN_SESSION_KEY); } catch (e) {}
        try { localStorage.removeItem(ADMIN_SESSION_KEY); } catch (e) {}
    }

function clearAdminSession() {
        clearLegacyAdminTokenStorage();
        adminSessionActive = false;
        stopAdminSessionAutoRefresh();
    }

function startAdminSessionAutoRefresh() {
        stopAdminSessionAutoRefresh();
        if (!adminSessionActive) return;
        // Renew the backend-held admin session before its cookie expires.
        adminSessionRefreshTimer = setInterval(() => {
            if (document.hidden) return;
            void refreshAdminSession({ reason: "background" }).catch(() => {});
        }, 45 * 60 * 1000);
    }

function stopAdminSessionAutoRefresh() {
        if (adminSessionRefreshTimer) clearInterval(adminSessionRefreshTimer);
        adminSessionRefreshTimer = null;
        adminSessionRefreshPromise = null;
    }

async function refreshAdminSession({ reason = "manual", forceLogout = false } = {}) {
        if (adminSessionRefreshPromise) return adminSessionRefreshPromise;
        adminSessionRefreshPromise = (async () => {
            const refreshed = await apiRequest("admin-session-refresh", {
                method: "POST",
                body: {}
            });
            if (!refreshed?.principal) {
                throw new Error("Admin session refresh returned incomplete profile.");
            }
            adminSessionActive = true;
            adminPrincipal = refreshed.principal;
            adminSessionExpiryNoticeShown = false;
            clearLegacyAdminTokenStorage();
            startAdminSessionAutoRefresh();
            return refreshed;
        })().catch(async error => {
            if (!(reason === "restore" && error?.status === 401)) {
                console.error(`Admin session refresh failed (${reason})`, error);
            }
            if (forceLogout) await handleAdminSessionExpired();
            throw error;
        }).finally(() => {
            adminSessionRefreshPromise = null;
        });
        return adminSessionRefreshPromise;
    }

async function handleAdminSessionExpired() {
        if (adminSessionExpiryNoticeShown) return;
        adminSessionExpiryNoticeShown = true;
        showToast("Admin session expired. Please sign in again.", "info");
        await closeAdminPortal();
    }

function safeParseStorage(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
}

function rememberAdminLoginEmail(value) {
    try {
        localStorage.setItem(ADMIN_LOGIN_EMAIL_KEY, String(value || "").trim().toLowerCase());
    } catch (e) {}
}

function restoreAdminLoginEmail() {
    const input = document.getElementById("admin-email-input");
    if (!input) return;
    try {
        input.value = localStorage.getItem(ADMIN_LOGIN_EMAIL_KEY) || "";
    } catch (e) {
        input.value = "";
    }
}

function getAdminProfileState() {
    const fallbackName = adminPrincipal?.email ? String(adminPrincipal.email).split("@")[0] : "Admin";
    const fallbackEmail = adminPrincipal?.email || "";
    const stored = adminProfile || {};
    return {
        displayName: String(stored?.display_name || fallbackName || "Admin"),
        contactEmail: String(stored?.contact_email || fallbackEmail),
        phone: String(stored?.phone || ""),
        avatar: String(stored?.avatar_url || "")
    };
}

function saveAdminProfileState(profile) {
    adminProfile = profile || null;
}

function buildAdminRoleLabel() {
    if (!adminPrincipal) return "Admin";
    return adminPrincipal.is_super_admin ? "Super Admin" : "Delegated Admin";
}

function buildAdminPermissionBadges() {
    if (!adminPrincipal) return [];
    return [buildAdminRoleLabel(), ...getAdminRoleFeatureLabels(adminPrincipal.permissions)];
}

function getAdminRoleFeatureLabels(permissions = {}) {
    const labels = [];
    if (permissions?.questions_view) labels.push("Questions · View");
    if (permissions?.questions_create) labels.push("Questions · Add");
    if (permissions?.questions_edit) labels.push("Questions · Edit");
    if (permissions?.questions_bulk) labels.push("Questions · Bulk");
    if (permissions?.flashcards_view) labels.push("Flashcards · View");
    if (permissions?.flashcards_create) labels.push("Flashcards · Add");
    if (permissions?.flashcards_edit) labels.push("Flashcards · Edit");
    if (permissions?.quotes_view) labels.push("Quotes · View");
    if (permissions?.quotes_create) labels.push("Quotes · Publish");
    if (permissions?.quotes_edit) labels.push("Quotes · Edit");
    if (permissions?.roles) labels.push("User Role");
    return labels;
}

function renderAdminAvatar(targetId, profile) {
    const target = document.getElementById(targetId);
    if (!target) return;
    const initials = String(profile.displayName || adminPrincipal?.email || "Admin")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(part => part[0]?.toUpperCase() || "")
        .join("") || "EP";
    if (profile.avatar) {
        target.innerHTML = `<img src="${escapeHTML(profile.avatar)}" alt="Profile">`;
    } else {
        target.textContent = initials;
    }
}

function hydrateAdminProfileCard() {
    const profile = getAdminProfileState();
    const roleLabel = buildAdminRoleLabel();
    renderAdminAvatar("admin-avatar-header", profile);
    renderAdminAvatar("admin-avatar-panel", profile);
    const accountName = document.getElementById("admin-account-name");
    const accountRole = document.getElementById("admin-account-role");
    const summaryName = document.getElementById("admin-profile-summary-name");
    const summaryEmail = document.getElementById("admin-profile-summary-email");
    const nameInput = document.getElementById("admin-profile-name");
    const contactEmailInput = document.getElementById("admin-profile-contact-email");
    const phoneInput = document.getElementById("admin-profile-phone");
    const loginEmailInput = document.getElementById("admin-profile-login-email");
    if (accountName) accountName.textContent = profile.displayName;
    if (accountRole) accountRole.textContent = roleLabel;
    if (summaryName) summaryName.textContent = profile.displayName;
    if (summaryEmail) summaryEmail.textContent = adminPrincipal?.email || profile.contactEmail || "No login email";
    if (nameInput) nameInput.value = profile.displayName;
    if (contactEmailInput) contactEmailInput.value = profile.contactEmail;
    if (phoneInput) phoneInput.value = profile.phone;
    if (loginEmailInput) loginEmailInput.value = adminPrincipal?.email || "";
    renderAdminRoleSummary();
}

function renderAdminRoleSummary() {
    const title = document.getElementById("admin-role-summary-title");
    const copy = document.getElementById("admin-role-summary-copy");
    const badges = document.getElementById("admin-role-summary-badges");
    if (title) title.textContent = buildAdminRoleLabel();
    if (copy) copy.textContent = adminPrincipal?.email
        ? `${adminPrincipal.email} can currently access the permissions below.`
        : "Permission details will appear here after sign in.";
    if (badges) {
        badges.innerHTML = buildAdminPermissionBadges().map(label => `<span class="admin-role-summary-badge">${escapeHTML(label)}</span>`).join("");
    }
}

function setAdminAccountPanel(panel) {
    activeAdminAccountPanel = panel === "role" ? "role" : "profile";
    document.querySelectorAll("[data-admin-account-panel]").forEach((button) => {
        button.classList.toggle("active", button.dataset.adminAccountPanel === activeAdminAccountPanel);
    });
    document.getElementById("admin-account-panel-profile").hidden = activeAdminAccountPanel !== "profile";
    document.getElementById("admin-account-panel-role").hidden = activeAdminAccountPanel !== "role";
}

function toggleAdminAccountMenu(event) {
    event?.stopPropagation();
    const account = document.getElementById("admin-account");
    const trigger = document.getElementById("admin-account-trigger");
    if (!account || !trigger) return;
    const open = account.classList.toggle("open");
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
        hydrateAdminProfileCard();
        setAdminAccountPanel(activeAdminAccountPanel);
    }
}

function closeAdminAccountMenu() {
    const account = document.getElementById("admin-account");
    const trigger = document.getElementById("admin-account-trigger");
    if (!account || !account.classList.contains("open")) return;
    account.classList.remove("open");
    trigger?.setAttribute("aria-expanded", "false");
}

async function saveAdminProfileCard() {
    const profile = {
        display_name: document.getElementById("admin-profile-name")?.value.trim() || "Admin",
        contact_email: document.getElementById("admin-profile-contact-email")?.value.trim() || "",
        phone: document.getElementById("admin-profile-phone")?.value.trim() || "",
        avatar: getAdminProfileState().avatar
    };
    try {
        const result = await adminApiRequest("admin-profile", { method: "POST", body: profile });
        saveAdminProfileState(result?.profile || null);
        hydrateAdminProfileCard();
        showToast("Profile saved.", "success");
    } catch (error) {
        showToast(`Could not save profile: ${error.message || "Unknown error"}`, "error");
    }
}

async function handleAdminProfileAvatarUpload(event) {
    const file = event.target?.files?.[0];
    if (!file) return;
    if (!String(file.type || "").toLowerCase().startsWith("image/")) {
        showToast("Please choose an image file for the profile picture.", "error");
        event.target.value = "";
        return;
    }
    if (file.size > 2 * 1024 * 1024) {
        showToast("Profile image should be no larger than 2 MB.", "error");
        event.target.value = "";
        return;
    }
    try {
        const avatar = await optimizeAdminImageFile(file);
        if (event.target?.files?.[0] !== file) return;
        const profile = {
            display_name: getAdminProfileState().displayName,
            contact_email: getAdminProfileState().contactEmail,
            phone: getAdminProfileState().phone,
            avatar_url: avatar
        };
        saveAdminProfileState(profile);
        hydrateAdminProfileCard();
        showToast("Profile picture ready. Select Save Profile to keep it.", "info");
    } catch (error) {
        event.target.value = "";
        showToast("Profile image could not be processed.", "error");
    }
}

function captureAdminQuestionContext() {
    return {
        destMode: document.querySelector("[name='dest-mode']:checked")?.value || "exam",
        peType: document.querySelector("[name='pe-type']:checked")?.value || PE_BCSC_MAIN_TYPE,
        catMode: document.querySelector("[name='cat-mode']:checked")?.value || "exist",
        existingCategory: document.getElementById("adm-cat-select")?.value || "",
        newCategory: document.getElementById("adm-cat-input")?.value.trim() || "",
        peTopic: document.getElementById("adm-pe-topic")?.value.trim() || ""
    };
}

function rememberAdminQuestionContext(context = captureAdminQuestionContext()) {
    try {
        localStorage.setItem(ADMIN_QUESTION_CONTEXT_KEY, JSON.stringify(context));
    } catch (e) {}
}

function restoreAdminQuestionContext() {
    const context = safeParseStorage(ADMIN_QUESTION_CONTEXT_KEY, null);
    if (!context) return;
    const destInput = document.querySelector(`[name='dest-mode'][value='${context.destMode || "exam"}']`);
    if (destInput) destInput.checked = true;
    const restoredPeType = context.peType === "Mock" ? PE_BCSC_MAIN_TYPE : (context.peType || PE_BCSC_MAIN_TYPE);
    const peTypeInput = document.querySelector(`[name='pe-type'][value='${restoredPeType}']`);
    if (peTypeInput) peTypeInput.checked = true;
    const catModeInput = document.querySelector(`[name='cat-mode'][value='${context.catMode || "exist"}']`);
    if (catModeInput) catModeInput.checked = true;
    onDestModeChange();
    onPeTypeChange();
    onCatModeChange();
    if (typeof context.peTopic === "string") {
        const peTopic = document.getElementById("adm-pe-topic");
        if (peTopic) peTopic.value = context.peTopic;
    }
    const categorySelect = document.getElementById("adm-cat-select");
    if (categorySelect && context.existingCategory && [...categorySelect.options].some(option => option.value === context.existingCategory)) {
        categorySelect.value = context.existingCategory;
    }
    const newCategoryInput = document.getElementById("adm-cat-input");
    if (newCategoryInput && typeof context.newCategory === "string") {
        newCategoryInput.value = context.newCategory;
    }
    rememberAdminQuestionContext(captureAdminQuestionContext());
}

function captureAdminFlashcardContext() {
    return {
        scope: document.getElementById("caf-admin-scope")?.value || "Bhutan",
        catMode: document.querySelector('[name="caf-cat-mode"]:checked')?.value || "exist",
        existingCategory: document.getElementById("caf-admin-category")?.value || "",
        newCategory: document.getElementById("caf-admin-category-new")?.value.trim() || ""
    };
}

function rememberAdminFlashcardContext(context = captureAdminFlashcardContext()) {
    try {
        localStorage.setItem(ADMIN_FLASHCARD_CONTEXT_KEY, JSON.stringify(context));
    } catch (e) {}
}

function restoreAdminFlashcardContext() {
    const context = safeParseStorage(ADMIN_FLASHCARD_CONTEXT_KEY, null);
    if (!context) return;
    const scope = document.getElementById("caf-admin-scope");
    if (scope) scope.value = context.scope || "Bhutan";
    cafPopulateAdminCategories();
    cafSetAdminCategoryMode(context.catMode || "exist");
    const existingCategory = document.getElementById("caf-admin-category");
    if (existingCategory && context.existingCategory && [...existingCategory.options].some(option => option.value === context.existingCategory)) {
        existingCategory.value = context.existingCategory;
    }
    const newCategory = document.getElementById("caf-admin-category-new");
    if (newCategory && typeof context.newCategory === "string") {
        newCategory.value = context.newCategory;
    }
    rememberAdminFlashcardContext(captureAdminFlashcardContext());
}

function adminHasPermission(permission) {
    return Boolean(adminPrincipal?.permissions?.[permission]);
}

function getAdminAllowedSections() {
    const sections = [];
    if (adminHasPermission("questions")) sections.push("questions");
    if (adminHasPermission("flashcards")) sections.push("flashcards");
    if (adminHasPermission("quotes")) sections.push("quotes");
    if (adminHasPermission("questions")) sections.push("resources");
    if (adminHasPermission("roles")) sections.push("roles");
    return sections;
}

function setAdminSection(section) {
    const allowedSections = getAdminAllowedSections();
    const nextSection = allowedSections.includes(section) ? section : allowedSections[0] || "questions";
    activeAdminSection = nextSection;
    document.querySelectorAll("[data-admin-section-link]").forEach((button) => {
        const isActive = button.dataset.adminSectionLink === nextSection;
        button.classList.toggle("active", isActive);
        button.setAttribute("aria-current", isActive ? "page" : "false");
    });
    document.querySelectorAll("[data-admin-section]").forEach((panel) => {
        const isActive = panel.dataset.adminSection === nextSection;
        panel.hidden = !isActive;
        panel.style.display = isActive ? "" : "none";
    });
    const bulkStack = document.querySelector(".admin-side-stack.admin-section-panel[data-admin-section='questions']");
    if (bulkStack) {
        const showBulk = nextSection === "questions" && adminHasPermission("questions_bulk");
        bulkStack.hidden = !showBulk;
        bulkStack.style.display = showBulk ? "" : "none";
    }
    if (nextSection === "resources") void loadAdminPEResources();
}

function applyAdminPermissions() {
    const roleOnly = document.querySelector('[data-admin-section-link="roles"]');
    document.querySelectorAll("[data-admin-section-link]").forEach((button) => {
        const section = button.dataset.adminSectionLink || "";
        const allowed = getAdminAllowedSections().includes(section);
        button.hidden = !allowed;
    });
    if (roleOnly) roleOnly.hidden = !adminHasPermission("roles");
    const questionRegistry = document.querySelector(".admin-question-registry-inline");
    if (questionRegistry) questionRegistry.hidden = !adminHasPermission("questions_view");
    const bulkStack = document.querySelector(".admin-side-stack.admin-section-panel[data-admin-section='questions']");
    if (bulkStack) bulkStack.hidden = !adminHasPermission("questions_bulk");
    const flashcardRegistry = document.getElementById("caf-admin-registry");
    if (flashcardRegistry) flashcardRegistry.hidden = !adminHasPermission("flashcards_view");
    const quoteRegistry = document.getElementById("quote-admin-registry");
    if (quoteRegistry) quoteRegistry.hidden = !adminHasPermission("quotes_view");
    const questionSave = document.getElementById("admin-submit-btn");
    if (questionSave) questionSave.style.display = (adminHasPermission("questions_create") || adminHasPermission("questions_edit")) ? "" : "none";
    const flashcardSave = document.getElementById("caf-admin-save-btn");
    if (flashcardSave) flashcardSave.style.display = (adminHasPermission("flashcards_create") || adminHasPermission("flashcards_edit")) ? "" : "none";
    const quoteSave = document.getElementById("quote-admin-save-btn");
    if (quoteSave) quoteSave.style.display = (adminHasPermission("quotes_create") || adminHasPermission("quotes_edit")) ? "flex" : "none";
    const resourceSave = document.getElementById("pe-resource-save-btn");
    if (resourceSave) resourceSave.style.display = (adminHasPermission("questions_create") || adminHasPermission("questions_edit")) ? "" : "none";
    setAdminSection(activeAdminSection);
}

function setAdminSidebarHover(expanded) {
    const shell = document.getElementById("admin-shell");
    if (!shell || window.innerWidth <= 820) return;
    shell.classList.toggle("is-hover-expanded", Boolean(expanded));
}

function queueAdminSidebarHover(expanded) {
    if (adminSidebarHoverOpenTimer) {
        clearTimeout(adminSidebarHoverOpenTimer);
        adminSidebarHoverOpenTimer = null;
    }
    if (adminSidebarHoverCloseTimer) {
        clearTimeout(adminSidebarHoverCloseTimer);
        adminSidebarHoverCloseTimer = null;
    }
    if (expanded) {
        adminSidebarHoverOpenTimer = setTimeout(() => {
            setAdminSidebarHover(true);
            adminSidebarHoverOpenTimer = null;
        }, 18);
        return;
    }
    adminSidebarHoverCloseTimer = setTimeout(() => {
        setAdminSidebarHover(false);
        adminSidebarHoverCloseTimer = null;
    }, 165);
}

async function loadAdminProfile() {
    const result = await adminApiRequest("admin-profile", { method: "GET" });
    adminPrincipal = result?.principal || null;
    saveAdminProfileState(result?.profile || null);
    return adminPrincipal;
}

async function loadAdminRoles() {
    if (!adminHasPermission("roles")) {
        adminRoles = [];
        renderAdminRoleRegistry();
        return [];
    }
    const result = await adminApiRequest("admin-roles", { method: "GET" });
    adminRoles = Array.isArray(result?.roles) ? result.roles : [];
    renderAdminRoleRegistry();
    return adminRoles;
}

function resetAdminRoleForm() {
    const form = document.getElementById("admin-role-form");
    if (form) form.reset();
    const active = document.getElementById("admin-role-active");
    if (active) active.checked = true;
    const password = document.getElementById("admin-role-password");
    if (password) password.value = "";
    const saveBtn = document.getElementById("admin-role-save-btn");
    if (saveBtn) saveBtn.textContent = "Save Role";
}

function startAdminRoleEdit(email) {
    const role = adminRoles.find(item => String(item.email || "").toLowerCase() === String(email || "").toLowerCase());
    if (!role || role.is_super_admin) return;
    document.getElementById("admin-role-email").value = role.email || "";
    document.getElementById("admin-role-password").value = "";
    document.getElementById("admin-role-questions-view").checked = Boolean(role.can_questions_view);
    document.getElementById("admin-role-questions-create").checked = Boolean(role.can_questions_create);
    document.getElementById("admin-role-questions-edit").checked = Boolean(role.can_questions_edit);
    document.getElementById("admin-role-questions-bulk").checked = Boolean(role.can_questions_bulk);
    document.getElementById("admin-role-flashcards-view").checked = Boolean(role.can_flashcards_view);
    document.getElementById("admin-role-flashcards-create").checked = Boolean(role.can_flashcards_create);
    document.getElementById("admin-role-flashcards-edit").checked = Boolean(role.can_flashcards_edit);
    document.getElementById("admin-role-quotes-view").checked = Boolean(role.can_quotes_view);
    document.getElementById("admin-role-quotes-create").checked = Boolean(role.can_quotes_create);
    document.getElementById("admin-role-quotes-edit").checked = Boolean(role.can_quotes_edit);
    document.getElementById("admin-role-active").checked = Boolean(role.active);
    const saveBtn = document.getElementById("admin-role-save-btn");
    if (saveBtn) saveBtn.textContent = "Update Role";
    setAdminSection("roles");
    document.getElementById("admin-role-form")?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function renderAdminRoleRegistry() {
    const registry = document.getElementById("admin-role-registry");
    if (!registry) return;
    if (!adminHasPermission("roles")) {
        registry.innerHTML = `<div class="empty-state"><p>Role management is available only to the primary super-admin.</p></div>`;
        return;
    }
    if (!adminRoles.length) {
        registry.innerHTML = `<div class="empty-state"><p>No delegated admin roles have been assigned yet.</p></div>`;
        return;
    }
    registry.innerHTML = adminRoles.map((role) => {
        const badges = [];
        const features = [];
        if (role.is_super_admin) badges.push(`<span class="role-badge">Super Admin</span>`);
        badges.push(`<span class="role-badge">${role.active ? "Active" : "Inactive"}</span>`);
        if (role.can_questions_view) features.push(`<span class="role-feature-pill">Questions · View</span>`);
        if (role.can_questions_create) features.push(`<span class="role-feature-pill">Questions · Add</span>`);
        if (role.can_questions_edit) features.push(`<span class="role-feature-pill">Questions · Edit</span>`);
        if (role.can_questions_bulk) features.push(`<span class="role-feature-pill">Questions · Bulk</span>`);
        if (role.can_flashcards_view) features.push(`<span class="role-feature-pill">Flashcards · View</span>`);
        if (role.can_flashcards_create) features.push(`<span class="role-feature-pill">Flashcards · Add</span>`);
        if (role.can_flashcards_edit) features.push(`<span class="role-feature-pill">Flashcards · Edit</span>`);
        if (role.can_quotes_view) features.push(`<span class="role-feature-pill">Quotes · View</span>`);
        if (role.can_quotes_create) features.push(`<span class="role-feature-pill">Quotes · Publish</span>`);
        if (role.can_quotes_edit) features.push(`<span class="role-feature-pill">Quotes · Edit</span>`);
        return `
            <div class="role-row">
                <div class="role-row-email">
                    <strong>${escapeHTML(role.email || "")}</strong>
                </div>
                <div>
                    <div class="role-badges">${badges.join("")}</div>
                    <div class="role-feature-list">${features.join("") || `<span class="role-feature-pill">No active permissions</span>`}</div>
                </div>
                <div class="admin-question-actions">${role.is_super_admin
                    ? `<span class="role-badge">Protected</span>`
                    : `<button type="button" class="btn-view-sm" data-role-edit-email="${escapeHTML(role.email || "")}">Edit</button>
                       <button type="button" class="btn-view-sm" data-role-delete-email="${escapeHTML(role.email || "")}">Delete</button>`}
                </div>
            </div>
        `;
    }).join("");
    registry.querySelectorAll("[data-role-edit-email]").forEach((button) => {
        button.addEventListener("click", () => startAdminRoleEdit(button.dataset.roleEditEmail || ""));
    });
    registry.querySelectorAll("[data-role-delete-email]").forEach((button) => {
        button.addEventListener("click", () => { void deleteAdminRole(button.dataset.roleDeleteEmail || ""); });
    });
}

async function deleteAdminRole(email) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail || !window.confirm(`Delete delegated admin ${normalizedEmail}? This removes both login access and its role.`)) return;
    showLoading(true, "Deleting delegated admin...");
    try {
        await adminApiRequest("admin-roles", { method: "DELETE", body: { email: normalizedEmail } });
        await loadAdminRoles();
        resetAdminRoleForm();
        showToast("Delegated admin deleted.", "success");
    } catch (error) {
        showToast(`Could not delete delegated admin: ${error.message || "Unknown error"}`, "error");
    } finally {
        showLoading(false);
    }
}

async function saveAdminRole() {
    const payload = {
        email: document.getElementById("admin-role-email")?.value.trim().toLowerCase() || "",
        password: document.getElementById("admin-role-password")?.value || "",
        can_questions_view: document.getElementById("admin-role-questions-view")?.checked || false,
        can_questions_create: document.getElementById("admin-role-questions-create")?.checked || false,
        can_questions_edit: document.getElementById("admin-role-questions-edit")?.checked || false,
        can_questions_bulk: document.getElementById("admin-role-questions-bulk")?.checked || false,
        can_flashcards_view: document.getElementById("admin-role-flashcards-view")?.checked || false,
        can_flashcards_create: document.getElementById("admin-role-flashcards-create")?.checked || false,
        can_flashcards_edit: document.getElementById("admin-role-flashcards-edit")?.checked || false,
        can_quotes_view: document.getElementById("admin-role-quotes-view")?.checked || false,
        can_quotes_create: document.getElementById("admin-role-quotes-create")?.checked || false,
        can_quotes_edit: document.getElementById("admin-role-quotes-edit")?.checked || false,
        active: document.getElementById("admin-role-active")?.checked || false
    };
    if (!payload.email) {
        showToast("Enter the delegated admin email first.", "error");
        return;
    }
    if (payload.password && payload.password.trim().length < 6) {
        showToast("Delegated admin password must be at least 6 characters.", "error");
        return;
    }
    try {
        await adminApiRequest("admin-roles", { method: "POST", body: payload });
        await loadAdminRoles();
        resetAdminRoleForm();
        showToast("Admin role saved successfully.", "success");
    } catch (error) {
        showToast(`Could not save admin role: ${error.message || "Unknown error"}`, "error");
    }
}

    function touchAdminSession() {
        if (!adminSessionActive || !document.body.classList.contains("admin-mode")) return;
        persistAdminSession();
    }

	function formatOptionText(value) {
	    const text = String(value || "").trim();
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

function getAdminCategory() {
	    const destMode = document.querySelector("[name='dest-mode']:checked")?.value || "exam";
	    if (destMode === "pe" || destMode === "pe-online") {
	        let peType = document.querySelector("[name='pe-type']:checked")?.value || PE_BCSC_MAIN_TYPE;
            if (destMode === "pe-online" && peType === PE_BCSC_MAIN_TYPE) peType = "Past Paper";
	        const topic = document.getElementById("adm-pe-topic").value.trim() || "General";
	        return `__PE__::${peType}::${topic}`;
	    }
	    const mode = document.querySelector("[name='cat-mode']:checked").value;
	    return mode === "exist"
	        ? document.getElementById("adm-cat-select").value
	        : document.getElementById("adm-cat-input").value.trim();
	}

    function getAdminTargetTable(question = null) {
        if (question?.sourceTable === "PEOnlineExam") return "PEOnlineExam";
        const destMode = document.querySelector("[name='dest-mode']:checked")?.value || "exam";
        return destMode === "pe-online" ? "PEOnlineExam" : "Exam";
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
    const adminBtn = document.getElementById("admin-btn");
    const themeBtn = document.getElementById("theme-toggle-btn");
    if (themeBtn) themeBtn.style.display = "inline-flex";
    if (contactBtn) contactBtn.style.display = "block";
    if (adminBtn) adminBtn.style.display = "block";
    if (peBtn) peBtn.style.display = "none";
}

function setPostContinueActionButtons() {
    const contactBtn = document.getElementById("contact-btn");
    const peBtn = document.getElementById("pe-btn");
    const adminBtn = document.getElementById("admin-btn");
    const themeBtn = document.getElementById("theme-toggle-btn");
    if (themeBtn) themeBtn.style.display = "inline-flex";
    if (contactBtn) contactBtn.style.display = "none";
    if (adminBtn) adminBtn.style.display = "none";
    if (peBtn) peBtn.style.display = "block";
}

function hideTopActionButtons() {
    const contactBtn = document.getElementById("contact-btn");
    const peBtn = document.getElementById("pe-btn");
    const adminBtn = document.getElementById("admin-btn");
    const themeBtn = document.getElementById("theme-toggle-btn");
    if (themeBtn) themeBtn.style.display = "none";
    if (contactBtn) contactBtn.style.display = "none";
    if (adminBtn) adminBtn.style.display = "none";
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

async function adminApiRequest(path, { method = "POST", body } = {}) {
    if (!adminSessionActive) {
        throw new Error("Admin session is missing. Please sign in again.");
    }
    const request = () => apiRequest(path, { method, body });
    try {
        return await request();
    } catch (error) {
        if (error?.status !== 401) {
            if (error?.status === 403) await handleAdminSessionExpired();
            throw error;
        }
        await refreshAdminSession({ reason: `retry:${path}`, forceLogout: true });
        return request();
    }
}

function getPublicApiCacheTTL(path) {
    if (path === "questions?view=catalog") return 5 * 60 * 1000;
    if (path === "questions?view=pe-practice") return 5 * 60 * 1000;
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

function decodeQuestionWithExplanation(rawQuestion) {
    const text = rawQuestion || "";
    const idx = text.indexOf(EXPLANATION_DELIM);
    if (idx === -1) return { question: text, explanation: "" };
    return {
        question: text.slice(0, idx),
        explanation: text.slice(idx + EXPLANATION_DELIM.length)
    };
}

function mapExamRows(rows, sourceTable = "Exam") {
    return (rows || []).map(row => {
        const { question, explanation } = decodeQuestionWithExplanation(row.question);
        return {
            id: row.id,
            sourceTable,
            category: row.category,
            question,
            explanation,
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
        options: Array.isArray(row.options) ? row.options.slice(0, 4) : [],
        answer: -1,
        imageCode: "",
        audioCode: ""
    }));
}

async function fetchQuestions() {
    // Lightweight fetch — excludes image/audio columns, which can each hold
    // multi-megabyte base64 data. This keeps initial load fast; media is
    // fetched separately afterward without blocking first render.
    if (adminSessionActive) {
        const adminRows = await fetchAdminQuestions();
        return adminRows.filter(row => row.sourceTable === "Exam");
    }
    const rows = await apiRequest("questions?view=pe-practice");
    return mapExamRows(rows);
}

async function fetchAdminQuestions() {
    const result = await adminApiRequest("admin-questions", { method: "GET" });
    const examRows = result?.exam || [];
    const peOnlineRows = result?.peOnline || [];
    return [
        ...mapExamRows(examRows, "Exam"),
        ...mapExamRows(peOnlineRows, "PEOnlineExam")
    ].map(row => ({ ...row, _adminMediaLoaded: false }));
}

async function loadExamCatalog() {
    const rows = await apiRequest("questions?view=catalog");
    examCategoryCounts = new Map((rows || []).map(row => [row.category, Number(row.count || 0)]));
    categories = [...examCategoryCounts.keys()];
    examCatalogReady = categories.length > 0;
    updateCategorySelects();
    const total = [...examCategoryCounts.values()].reduce((sum, count) => sum + count, 0);
    document.getElementById("q-count").textContent = total;
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
    if (!peOnlineMode || activeData[index]) return activeData[index];
    await fetchPEOnlineQuestionWindow(index);
    if (activeData[index]) {
        await fetchSelectedQuestionMedia([activeData[index]]);
    }
    return activeData[index];
}

async function prefetchPEOnlineQuestion(index) {
    if (!peOnlineMode || index < 0 || index >= activeData.length || activeData[index]) return;
    try {
        const rows = await fetchPEOnlineQuestionWindow(index);
        const warmable = rows.map(entry => entry.question).filter(Boolean);
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

async function loadDatabase() {
    if (databaseReady) return true;
    if (databaseLoading) return false;
    databaseLoading = true;

    // ── Cache-first: render instantly if we have data ──
    const cached = sessionStorage.getItem(DB_CACHE_KEY) || localStorage.getItem(DB_CACHE_KEY);
    if (cached) {
        try {
            processData(JSON.parse(cached));
            databaseReady = true;
            databaseLoading = false;
            if (!examPreparing) showLoading(false);
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
    showLoading(true, "Loading question database…");
    setLoaderProgress(10);

    // Animate progress bar while waiting
    let prog = 10;
    const progInterval = setInterval(() => {
        prog = Math.min(prog + (Math.random() * 8 + 3), 85);
        setLoaderProgress(prog);
    }, 400);
    // Use Promise.race for timeout — AbortController causes DataCloneError in sandboxed iframes
    const fetchPromise = fetchQuestions();
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) =>
        timeoutId = setTimeout(() => reject(new Error("TIMEOUT")), DB_TIMEOUT_MS)
    );

    try {
        document.getElementById("loading-text").textContent = "Fetching questions…";
        const data = await Promise.race([fetchPromise, timeoutPromise]);
        clearTimeout(timeoutId);
        clearInterval(progInterval);
        setLoaderProgress(95);

        saveDatabaseCache(data);
        processData(data);
        databaseReady = true;

        document.getElementById("loading-text").textContent = "Ready!";
        setLoaderProgress(100);
        setTimeout(() => {
            if (!examPreparing) showLoading(false);
        }, 300);
        databaseLoading = false;
        return true;

    } catch (e) {
        clearTimeout(timeoutId);
        clearInterval(progInterval);
        setLoaderProgress(0);
        if (e.message === "TIMEOUT") {
            const fallback = localStorage.getItem(DB_CACHE_KEY);
            if (fallback) {
                processData(JSON.parse(fallback));
                databaseReady = true;
                databaseLoading = false;
                showToast("Using saved questions. Internet is slow.", "info");
                showLoading(false);
                return true;
            }
            showToast("Database is taking too long. Please try again.", "error");
            document.getElementById("loading-text").textContent = "Database is taking too long.";
        } else {
            showToast("Failed to load question database.", "error");
            document.getElementById("loading-text").textContent = "Failed to connect.";
        }
        console.error(e);
        databaseLoading = false;
        setTimeout(() => showLoading(false), 1500);
        return false;
    }
}

function processData(data) {
    questionPool = data || [];
    peQuestionsCache = questionPool.filter(q => isPECategory(q.category));
    peTopicBuckets = new Map();
    peQuestionsCache.forEach(q => {
        const info = parsePECategory(q.category);
        if (!info) return;
        const typeKey = info.peType;
        const allKey = `all::${info.topic}`;
        const typeTopicKey = `${typeKey}::${info.topic}`;
        if (!peTopicBuckets.has(allKey)) peTopicBuckets.set(allKey, { topic: info.topic, peType: typeKey, count: 0 });
        if (!peTopicBuckets.has(typeTopicKey)) peTopicBuckets.set(typeTopicKey, { topic: info.topic, peType: typeKey, count: 0 });
        peTopicBuckets.get(allKey).count += 1;
        peTopicBuckets.get(typeTopicKey).count += 1;
    });
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
    renderAdminTable();
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
    const catalogTotal = [...examCategoryCounts.values()].reduce((sum, count) => sum + count, 0);
    document.getElementById("q-count").textContent = examQuestions.length || catalogTotal;
    if (document.getElementById("pe-view") && document.getElementById("pe-view").style.display !== "none") {
        renderPEHomeGrid();
        renderPEMockGrid();
        renderPEPastGrid();
        renderPEDIGrid();
        updatePEOnlineCount();
        if (peActiveTopic) renderPEQuestionList();
        if (peDIActiveSet) renderPEDIQuestion();
    }
}

function updateCategorySelects() {
    ["category-select", "adm-cat-select"].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        sel.innerHTML = categories.length === 0
            ? `<option>No categories available</option>`
            : categories.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join("");
    });
    restoreAdminQuestionContext();
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
        btn.style.display = canSubmit ? "" : "none";
    });
    document.querySelectorAll(".normal-submit-hint").forEach(hint => {
        hint.style.display = canSubmit ? "none" : "";
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

// ─── ADMIN ────────────────────────────────────────────
function openAdminPortal() {
    if (adminSessionActive) {
        restoreAdminPortal();
        return;
    }
    document.body.classList.remove("admin-mode");
    document.getElementById("admin-view")?.classList.add("is-hidden");
    document.getElementById("admin-top-tools")?.classList.add("is-hidden");
    document.getElementById("admin-back-btn")?.classList.add("is-hidden");
    resetAdminGateway();
    restoreAdminLoginEmail();
    setAdminAuthMode("password");
    const emailInput = document.getElementById("admin-email-input");
    const input = document.getElementById("admin-pw-input");
    const errMsg = document.getElementById("pw-error");
    const passwordEye = document.getElementById("pw-eye");
    ensureAdminModalOpen();
    if (input) input.type = "password";
    if (passwordEye) passwordEye.textContent = "👁";
    errMsg?.classList.remove("visible");
    emailInput?.classList.remove("error-shake");
    input?.classList.remove("error-shake");
    setTimeout(() => (emailInput?.value ? input : emailInput)?.focus(), 280);
}

function closeAdminModal() {
    document.getElementById("admin-modal").classList.remove("open");
}

function shouldLockAdminGateway() {
    const modal = document.getElementById("admin-modal");
    return Boolean(modal && !adminSessionActive && document.body.classList.contains("admin-site"));
}

function ensureAdminModalOpen() {
    const modal = document.getElementById("admin-modal");
    if (!modal) return;
    modal.classList.add("open");
}

function focusAdminGatewayPrimaryField() {
    if (adminOtpState) {
        focusAdminOtpDigit(0);
        return;
    }
    const emailInput = document.getElementById("admin-email-input");
    const passwordInput = document.getElementById("admin-pw-input");
    const target = emailInput?.value ? passwordInput : emailInput;
    target?.focus();
}

function keepAdminModalLocked(event) {
    if (!shouldLockAdminGateway()) return;
    const modal = document.getElementById("admin-modal");
    const modalBox = document.getElementById("modal-box");
    if (!modal || !modalBox) return;
    ensureAdminModalOpen();
    if (event.target === modal || !modalBox.contains(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        setTimeout(() => focusAdminGatewayPrimaryField(), 0);
    }
}

function clearAdminGatewayFields() {
    const errorMessage = document.getElementById("pw-error");
    errorMessage?.classList.remove("visible");

    if (adminOtpState) {
        clearAdminOtpDigits();
        document.getElementById("admin-mfa-input")?.classList.remove("error-shake");
        focusAdminOtpDigit(0);
        return;
    }

    const emailInput = document.getElementById("admin-email-input");
    const passwordInput = document.getElementById("admin-pw-input");
    if (emailInput) {
        emailInput.value = "";
        emailInput.classList.remove("error-shake");
    }
    if (passwordInput) {
        passwordInput.value = "";
        passwordInput.classList.remove("error-shake");
    }
    emailInput?.focus();
}

function resetAdminGateway() {
    adminOtpState = null;
    restoreAdminLoginEmail();
    const passwordInput = document.getElementById("admin-pw-input");
    const otpInput = document.getElementById("admin-mfa-input");
    const errMsg = document.getElementById("pw-error");
    const authBtn = document.getElementById("admin-modal-auth-btn");
    if (passwordInput) {
        passwordInput.value = "";
        passwordInput.disabled = false;
        passwordInput.classList.remove("error-shake");
    }
    if (otpInput) {
        otpInput.value = "";
        otpInput.disabled = false;
        otpInput.classList.remove("error-shake");
    }
    clearAdminOtpDigits();
    if (authBtn) {
        authBtn.disabled = false;
        authBtn.classList.remove("is-hidden");
        authBtn.style.display = "";
        authBtn.setAttribute("aria-hidden", "false");
        authBtn.closest(".modal-btn-row")?.classList.remove("is-otp-mode");
    }
    if (errMsg) {
        errMsg.textContent = "⚠ Incorrect password. Please try again.";
        errMsg.classList.remove("visible");
    }
}

function setAdminAuthMode(mode) {
    const subtitle = document.getElementById("admin-modal-subtitle");
    const emailWrap = document.getElementById("admin-email-wrap");
    const emailInput = document.getElementById("admin-email-input");
    const passwordWrap = document.getElementById("admin-pw-wrap");
    const passwordInput = document.getElementById("admin-pw-input");
    const passwordEye = document.getElementById("pw-eye");
    const otpWrap = document.getElementById("admin-mfa-wrap");
    const otpInput = document.getElementById("admin-mfa-input");
    const authBtn = document.getElementById("admin-modal-auth-btn");
    const actionRow = authBtn?.closest(".modal-btn-row");
    const isOtp = mode === "otp";
    if (subtitle) {
        subtitle.textContent = isOtp
            ? `Enter the 6-digit code${adminOtpState?.destination ? ` sent to ${adminOtpState.destination}` : ""}`
            : "Enter admin email and password";
    }
    if (emailWrap) emailWrap.classList.toggle("is-hidden", isOtp);
    if (emailInput) emailInput.disabled = isOtp;
    if (passwordWrap) passwordWrap.classList.toggle("is-hidden", isOtp);
    if (passwordInput) passwordInput.disabled = isOtp;
    if (passwordEye) passwordEye.classList.toggle("is-hidden", isOtp);
    if (otpWrap) otpWrap.classList.toggle("is-hidden", !isOtp);
    if (otpInput) otpInput.disabled = !isOtp;
    getAdminOtpDigitInputs().forEach(input => {
        input.disabled = !isOtp;
    });
    if (authBtn) {
        authBtn.classList.toggle("is-hidden", isOtp);
        authBtn.style.display = isOtp ? "none" : "";
        authBtn.setAttribute("aria-hidden", isOtp ? "true" : "false");
        authBtn.disabled = isOtp;
    }
    actionRow?.classList.toggle("is-otp-mode", isOtp);
}

function showAdminAuthError(message) {
    const input = adminOtpState
        ? document.querySelector('.otp-digit-input')
        : document.getElementById("admin-pw-input");
    const errMsg = document.getElementById("pw-error");
    const authBtn = document.getElementById("admin-modal-auth-btn");
    if (input) {
        input.disabled = false;
        if (adminOtpState) {
            clearAdminOtpDigits();
            getAdminOtpDigitInputs().forEach(digitInput => {
                digitInput.classList.remove("error-shake");
                void digitInput.offsetWidth;
                digitInput.classList.add("error-shake");
                digitInput.disabled = false;
            });
        } else {
            input.value = "";
            input.classList.remove("error-shake");
            void input.offsetWidth;
            input.classList.add("error-shake");
        }
    }
    if (authBtn) authBtn.disabled = Boolean(adminOtpState);
    if (errMsg) {
        errMsg.textContent = message;
        errMsg.classList.add("visible");
    }
    ensureAdminModalOpen();
    setTimeout(() => input?.focus(), 120);
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

function togglePwVisibility() {
    const input = document.getElementById("admin-pw-input");
    const eye   = document.getElementById("pw-eye");
    if (!input || !eye) return;
    if (input.type === "password") {
        input.type = "text";
        eye.textContent = "🙈";
    } else {
        input.type = "password";
        eye.textContent = "👁";
    }
    input.focus();
}

function getAdminOtpDigitInputs() {
    return Array.from(document.querySelectorAll(".otp-digit-input"));
}

function syncAdminOtpHiddenValue() {
    const hiddenInput = document.getElementById("admin-mfa-input");
    if (!hiddenInput) return;
    hiddenInput.value = getAdminOtpDigitInputs().map(input => String(input.value || "").replace(/\D/g, "").slice(0, 1)).join("");
}

function focusAdminOtpDigit(index) {
    const inputs = getAdminOtpDigitInputs();
    const target = inputs[index];
    if (target) target.focus();
}

function clearAdminOtpDigits() {
    getAdminOtpDigitInputs().forEach(input => {
        input.value = "";
        input.classList.remove("error-shake");
    });
    syncAdminOtpHiddenValue();
}

function handleAdminOtpDigitInput(event, index) {
    const input = event.target;
    let value = String(input.value || "").replace(/\D/g, "");
    if (value.length > 1) {
        const digits = value.slice(0, 6).split("");
        const inputs = getAdminOtpDigitInputs();
        digits.forEach((digit, offset) => {
            if (inputs[index + offset]) inputs[index + offset].value = digit;
        });
        value = digits[0] || "";
    }
    input.value = value.slice(0, 1);
    syncAdminOtpHiddenValue();
    if (input.value && index < 5) focusAdminOtpDigit(index + 1);
    if (document.getElementById("admin-mfa-input")?.value.length === 6) {
        focusAdminOtpDigit(5);
        authenticateAdmin();
    }
}

function handleAdminOtpDigitKeydown(event, index) {
    const input = event.target;
    if (event.key === "Backspace" && !input.value && index > 0) {
        focusAdminOtpDigit(index - 1);
        return;
    }
    if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        focusAdminOtpDigit(index - 1);
        return;
    }
    if (event.key === "ArrowRight" && index < 5) {
        event.preventDefault();
        focusAdminOtpDigit(index + 1);
        return;
    }
    if (event.key === "Enter") {
        event.preventDefault();
        authenticateAdmin();
    }
}

async function requestAdminEmailOtp(password) {
    const email = document.getElementById("admin-email-input")?.value.trim().toLowerCase() || "";
    rememberAdminLoginEmail(email);
    const result = await apiRequest("admin-otp-request", {
        method: "POST",
        body: { email, password }
    });
    adminOtpState = {
        requestId: String(result.request_id || ""),
        destination: String(result.destination || "")
    };
    return adminOtpState;
}

async function verifyAdminEmailOtp(code) {
    if (!adminOtpState?.requestId) {
        throw new Error("Verification session expired");
    }
    const result = await apiRequest("admin-otp-verify", {
        method: "POST",
        body: {
            request_id: adminOtpState.requestId,
            code
        }
    });
    if (!result?.principal) {
        throw new Error("Verification session expired");
    }
    adminSessionActive = true;
    adminPrincipal = result.principal;
    adminOtpState = null;
    persistAdminSession();
    startAdminSessionAutoRefresh();
}

async function authenticateAdmin() {
    if (adminAuthenticationPending) return;
    const emailInput = document.getElementById("admin-email-input");
    const passwordInput  = document.getElementById("admin-pw-input");
    const otpInput = document.getElementById("admin-mfa-input");
    const otpDigitInputs = getAdminOtpDigitInputs();
    const errMsg = document.getElementById("pw-error");
    const authBtn = document.getElementById("admin-modal-auth-btn");
    const activeInput = adminOtpState ? otpInput : passwordInput;
    const credentialValue = adminOtpState ? otpInput.value.trim() : passwordInput.value;
    if (!adminOtpState && !emailInput?.value.trim()) {
        emailInput?.classList.remove("error-shake");
        void emailInput?.offsetWidth;
        emailInput?.classList.add("error-shake");
        errMsg.textContent = "⚠ Please enter your admin email.";
        errMsg.classList.add("visible");
        emailInput?.focus();
        return;
    }
    if (!credentialValue) {
        activeInput.classList.remove("error-shake");
        void activeInput.offsetWidth;
        activeInput.classList.add("error-shake");
        errMsg.textContent = adminOtpState
            ? "⚠ Please enter the 6-digit verification code."
            : "⚠ Please enter your password.";
        errMsg.classList.add("visible");
        activeInput.focus();
        return;
    }
    adminAuthenticationPending = true;
    errMsg.classList.remove("visible");
    if (emailInput) emailInput.disabled = true;
    passwordInput.disabled = true;
    otpInput.disabled = true;
    otpDigitInputs.forEach(input => { input.disabled = true; });
    if (authBtn) authBtn.disabled = true;
    closeAdminModal();
    showLoading(true, "Connecting...");
    if (adminOtpState) {
        try {
            await verifyAdminEmailOtp(credentialValue);
            try {
                await showAdminPortal();
            } catch (portalError) {
                throw new Error("Admin portal open failed");
            }
            showToast("Admin access granted.", "success");
        } catch (error) {
            adminSessionActive = false;
            document.body.classList.remove("admin-mode");
            const errorText = String(error?.message || "");
            const message = /portal/i.test(errorText)
                ? "⚠ Admin portal could not be opened. Please try again."
                : /expired/i.test(errorText) || /session/i.test(errorText)
                ? "⚠ Verification expired. Please enter password again."
                : error?.status === 429 || /attempt/i.test(errorText)
                ? "⚠ Too many incorrect codes. Please enter password again."
                : "⚠ Incorrect verification code. Please try again.";
            if (/expired|session|attempt/i.test(errorText) || error?.status === 429) {
                resetAdminGateway();
                setAdminAuthMode("password");
            }
            showAdminAuthError(message);
        } finally {
            adminAuthenticationPending = false;
            showLoading(false);
            if (emailInput) emailInput.disabled = false;
            passwordInput.disabled = false;
            otpInput.disabled = false;
            otpDigitInputs.forEach(input => { input.disabled = false; });
            if (authBtn) authBtn.disabled = Boolean(adminOtpState);
        }
        return;
    }
    try {
        const pendingOtp = await requestAdminEmailOtp(credentialValue);
        if (pendingOtp?.requestId) {
            setAdminAuthMode("otp");
            ensureAdminModalOpen();
            showLoading(false);
            passwordInput.disabled = false;
            otpInput.disabled = false;
            otpDigitInputs.forEach(input => { input.disabled = false; });
            if (authBtn) authBtn.disabled = true;
            showToast("Verification code sent to email.", "success");
            setTimeout(() => focusAdminOtpDigit(0), 120);
            return;
        }
    } catch (error) {
        adminSessionActive = false;
        adminOtpState = null;
        document.body.classList.remove("admin-mode");
        const errorText = String(error?.message || "");
        const errorCode = String(error?.code || "");
        const message = errorCode === "security_not_configured"
            ? "⚠ Admin email verification is not configured yet."
            : errorCode === "otp_sender_not_configured"
            ? "⚠ Delegated verification email sender is not configured."
            : error?.status === 429
            ? "⚠ Too many attempts. Please wait 10 minutes and try again."
            : errorCode === "otp_delivery_failed" || /delivery/i.test(errorText)
            ? "⚠ Verification code could not be sent. Please try again."
            : "⚠ Admin password is incorrect. Please try again.";
        showAdminAuthError(message);
    } finally {
        adminAuthenticationPending = false;
        showLoading(false);
        if (emailInput) emailInput.disabled = false;
        passwordInput.disabled = false;
        otpInput.disabled = false;
        otpDigitInputs.forEach(input => { input.disabled = false; });
        if (authBtn) authBtn.disabled = Boolean(adminOtpState);
    }
}

async function showAdminPortal() {
    document.body.classList.add("admin-mode");
    persistAdminSession();
    startAdminSessionAutoRefresh();
    clearPublicApiCache();
    document.getElementById("admin-shell")?.classList.remove("is-hover-expanded");
    document.getElementById("admin-shell")?.classList.add("is-collapsed");
    await loadAdminProfile();
    // The gateway is open by default in the HTML. Close it after the saved
    // token has been verified so a page refresh reveals the restored portal.
    closeAdminModal();
    hydrateAdminProfileCard();
    const topTools = document.getElementById("admin-top-tools");
    topTools?.classList.remove("is-hidden");
    const portalLoads = await Promise.allSettled([
        adminHasPermission("questions_view") ? fetchAdminQuestions() : Promise.resolve([]),
        adminHasPermission("flashcards_view") ? caLoadState({ render: false, force: true }) : Promise.resolve(),
        adminHasPermission("quotes_view") ? loadDailyQuotes({ fresh: true }) : Promise.resolve(),
        adminHasPermission("roles") ? loadAdminRoles() : Promise.resolve([])
    ]);
    const adminQuestions = portalLoads[0].status === "fulfilled" ? portalLoads[0].value : [];
    const failedLoads = portalLoads.filter(result => result.status === "rejected");
    if (failedLoads.length) {
        console.error("Some admin data could not be loaded", failedLoads.map(result => result.reason));
        showToast("Signed in. Some admin data could not be loaded; refresh to retry.", "info");
    }
    questionPool = [];
    categories = [];
    processData(adminQuestions || []);
    if (!adminHasPermission("flashcards")) {
        cafNotes = [];
        cafStateLoaded = false;
    }
    if (!adminHasPermission("quotes")) dailyQuotes = [];
    databaseReady = true;
    document.getElementById("q-count").textContent = questionPool.length;
    caHydrateAdminControls();
    caRenderAll();
    applyAdminPermissions();
    document.getElementById("setup-view").style.display = "none";
    document.getElementById("admin-view")?.classList.remove("is-hidden");
    hideTopActionButtons();
    document.getElementById("admin-back-btn")?.classList.remove("is-hidden");
}

async function loadAdminQuestionMedia(idx) {
    const question = questionPool[idx];
    if (!question || question._adminMediaLoaded || question.id === undefined || question.id === null) return question;
    const table = question.sourceTable === "PEOnlineExam" ? "PEOnlineExam" : "Exam";
    const rows = await adminApiRequest(
        `admin-question-media?table=${encodeURIComponent(table)}&id=${encodeURIComponent(question.id)}`,
        { method: "GET" }
    );
    const media = rows?.[0] || {};
    question.imageCode = typeof media.image === "string" ? media.image : "";
    question.audioCode = typeof media.audio === "string" ? media.audio : "";
    question._adminMediaLoaded = true;
    return question;
}

async function restoreAdminPortal() {
    await showAdminPortal();
}

async function closeAdminPortal() {
    const shouldLogoutBackend = adminSessionActive;
    if (shouldLogoutBackend) {
        await apiRequest("admin-logout", { method: "POST", body: {} }).catch(() => {});
    }
    document.body.classList.remove("admin-mode");
    adminSessionActive = false;
    adminOtpState = null;
    adminPrincipal = null;
    adminRoles = [];
    document.getElementById("admin-shell")?.classList.remove("is-hover-expanded");
    closeAdminAccountMenu();
    clearAdminSession();
    clearDatabaseCache();
    questionPool = [];
    databaseReady = false;
    cancelQuestionEdit();
    const topTools = document.getElementById("admin-top-tools");
    topTools?.classList.add("is-hidden");
    document.getElementById("admin-view")?.classList.add("is-hidden");
    document.getElementById("admin-back-btn")?.classList.add("is-hidden");
    resetAdminGateway();
    setAdminAuthMode("password");
    ensureAdminModalOpen();
    setTimeout(() => document.getElementById("admin-email-input")?.focus(), 120);
}

function onCatModeChange() {
    const isNew = document.querySelector("[name='cat-mode']:checked").value === "new";
    document.getElementById("exist-wrap").style.display = isNew ? "none" : "block";
    document.getElementById("new-wrap").style.display   = isNew ? "block" : "none";
    document.getElementById("pill-exist").classList.toggle("active", !isNew);
    document.getElementById("pill-new").classList.toggle("active", isNew);
    rememberAdminQuestionContext();
    updateBulkImportPreview();
}

function onDestModeChange() {
    const destMode = document.querySelector("[name='dest-mode']:checked").value;
    const isPE = destMode === "pe" || destMode === "pe-online";
    const isPEOnline = destMode === "pe-online";
    document.getElementById("pe-type-wrap").style.display = isPE ? "block" : "none";
    document.getElementById("exam-cat-wrap").style.display = isPE ? "none" : "block";
    document.getElementById("pill-exam").classList.toggle("active", !isPE);
    document.getElementById("pill-pe").classList.toggle("active", destMode === "pe");
    document.getElementById("pill-pe-online").classList.toggle("active", isPEOnline);
    const bcscPill = document.getElementById("pill-pe-mock");
    const bcscInput = bcscPill?.querySelector("input");
    if (bcscPill) bcscPill.style.display = isPEOnline ? "none" : "";
    if (bcscInput) {
        bcscInput.disabled = isPEOnline;
        if (isPEOnline && bcscInput.checked) {
            const pastInput = document.querySelector("[name='pe-type'][value='Past Paper']");
            if (pastInput) pastInput.checked = true;
        }
    }
    // Exam category fields are required only when targeting the exam bank
    document.getElementById("adm-cat-input").required = false;
    onPeTypeChange();
    updateBulkDestinationBanner();
    rememberAdminQuestionContext();
    updateBulkImportPreview();
}

function onPeTypeChange() {
    const peType = document.querySelector("[name='pe-type']:checked")?.value || PE_BCSC_MAIN_TYPE;
    const isPast = peType === "Past Paper";
    const isDI = peType === "Data Interpretation";
    document.getElementById("pill-pe-mock").classList.toggle("active", peType === PE_BCSC_MAIN_TYPE);
    document.getElementById("pill-pe-past").classList.toggle("active", isPast);
    document.getElementById("pill-pe-di").classList.toggle("active", isDI);
    document.getElementById("pe-di-note").style.display = isDI ? "block" : "none";
    document.getElementById("adm-pe-topic-label").textContent = isDI ? "Set Name (same name groups questions under one chart)" : "Topic / Paper Name";
    document.getElementById("adm-pe-topic").placeholder = isDI ? "e.g., Sales Chart 2023, Bar Graph Set 1" : "e.g., Problems on Trains, RCSC 2024 Paper 1";
    updateBulkDestinationBanner();
    rememberAdminQuestionContext();
    updateBulkImportPreview();
}

// Keeps the banner above the bulk-paste textarea in sync with whatever
// the Destination/PE-type/topic controls are currently set to, so it's
// never ambiguous which category bulk-pasted questions will land in.
function updateBulkDestinationBanner() {
    const label = document.getElementById("bulk-destination-label");
    const banner = document.getElementById("bulk-destination-banner");
    if (!label || !banner) return;
    const destMode = document.querySelector("[name='dest-mode']:checked")?.value || "exam";
    if (destMode === "pe" || destMode === "pe-online") {
        const peType = document.querySelector("[name='pe-type']:checked")?.value || PE_BCSC_MAIN_TYPE;
        label.textContent = destMode === "pe-online" ? `🧪 PE Online → ${peType}` : `📚 PE → ${peType}`;
        banner.style.background = "#e8f5e9";
        banner.style.borderColor = "#2f9e44";
        banner.style.color = "#1b5e20";
    } else {
        label.textContent = "Exam Question Bank";
        banner.style.background = "#fff8e1";
        banner.style.borderColor = "#f5d76e";
        banner.style.color = "#7a5c00";
    }
}

// ════════════════════════════════════════════════════════
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
            const rows = await adminApiRequest("admin-flashcards", { method: "GET" });
            cafNotes = cafNormalizeRows(rows);
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

function caHydrateAdminControls() {
    resetAdminForm();
    cafResetAdminForm();
    resetDailyQuoteForm();
    resetAdminRoleForm();
    cafUpdateDropdownOptions(cafSelectedScope);
    cafRenderAdminRegistry();
    renderDailyQuoteAdminRegistry();
    renderAdminRoleRegistry();
}

function caRenderAll() {
    cafUpdateDropdownOptions(cafSelectedScope);
    cafFilterData(false);
    cafRenderAdminRegistry();
    renderDailyQuoteTicker();
    renderDailyQuoteAdminRegistry();
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
    cafFilteredItems = cafNotes.filter(note => note.scope === cafSelectedScope && note.category === selectedCategory);
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

function cafPopulateAdminCategories() {
    const scope = document.getElementById("caf-admin-scope")?.value || "Bhutan";
    const select = document.getElementById("caf-admin-category");
    if (!select) return;
    const previous = select.value;
    const categoriesForScope = cafCategoriesForScope(scope);
    select.innerHTML = categoriesForScope.map(cat => `<option value="${escapePEHtml(cat)}">${escapePEHtml(cat)}</option>`).join("");
    if (previous && categoriesForScope.includes(previous)) select.value = previous;
    cafApplyAdminCategoryMode();
    rememberAdminFlashcardContext();
}

function cafApplyAdminCategoryMode() {
    const isNew = document.querySelector('[name="caf-cat-mode"]:checked')?.value === "new";
    const existingWrap = document.getElementById("caf-exist-wrap");
    const newWrap = document.getElementById("caf-new-wrap");
    const existingPill = document.getElementById("caf-pill-exist");
    const newPill = document.getElementById("caf-pill-new");
    if (existingWrap) existingWrap.style.display = isNew ? "none" : "block";
    newWrap?.classList.toggle("is-hidden", !isNew);
    existingPill?.classList.toggle("active", !isNew);
    newPill?.classList.toggle("active", isNew);
    rememberAdminFlashcardContext();
}

function cafSetAdminCategoryMode(mode) {
    const input = document.querySelector(`[name="caf-cat-mode"][value="${mode}"]`);
    if (input) input.checked = true;
    cafApplyAdminCategoryMode();
}

function cafGetAdminCategory() {
    const scope = document.getElementById("caf-admin-scope")?.value || "Bhutan";
    const isNew = document.querySelector('[name="caf-cat-mode"]:checked')?.value === "new";
    const entered = document.getElementById("caf-admin-category-new")?.value.trim() || "";
    if (!isNew) return document.getElementById("caf-admin-category")?.value || "";
    const existing = cafCategoriesForScope(scope).find(category => category.toLocaleLowerCase() === entered.toLocaleLowerCase());
    return existing || entered;
}

function cafResetAdminForm() {
    const previous = captureAdminFlashcardContext();
    const form = document.getElementById("caf-admin-form");
    if (form) form.reset();
    editingCafCardId = "";
    cafSetAdminCategoryMode("exist");
    const date = document.getElementById("caf-admin-date");
    if (date && !date.value) date.value = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Thimphu" }).format(new Date());
    cafPopulateAdminCategories();
    if (previous.scope || previous.existingCategory || previous.newCategory) restoreAdminFlashcardContext();
    const saveBtn = document.getElementById("caf-admin-save-btn");
    const cancelBtn = document.getElementById("caf-admin-cancel-btn");
    if (saveBtn) saveBtn.textContent = "Save Flashcard";
    cancelBtn?.classList.add("is-hidden");
}

function cafStartEditCard(id) {
    const card = cafNotes.find(item => String(item.id || "") === String(id || ""));
    if (!card) {
        showToast("Flashcard could not be loaded for editing.", "error");
        return;
    }
    editingCafCardId = String(card.id || "");
    document.getElementById("caf-admin-scope").value = card.scope || "Bhutan";
    cafPopulateAdminCategories();
    cafSetAdminCategoryMode("exist");
    document.getElementById("caf-admin-category").value = card.category || "Sports";
    document.getElementById("caf-admin-date").value = card.date || "";
    document.getElementById("caf-admin-question").value = card.examFocus || "";
    document.getElementById("caf-admin-answer").value = card.answer || "";
    const saveBtn = document.getElementById("caf-admin-save-btn");
    const cancelBtn = document.getElementById("caf-admin-cancel-btn");
    if (saveBtn) saveBtn.textContent = "Update Flashcard";
    cancelBtn?.classList.remove("is-hidden");
    document.getElementById("caf-admin-form")?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function cafCancelEdit() {
    cafResetAdminForm();
}

async function cafSaveAdminCard() {
    const wasEditing = Boolean(editingCafCardId);
    const payload = {
        id: editingCafCardId || "",
        scope: document.getElementById("caf-admin-scope")?.value || "Bhutan",
        category: cafGetAdminCategory(),
        date_stamp: document.getElementById("caf-admin-date")?.value.trim(),
        exam_focus: document.getElementById("caf-admin-question")?.value.trim(),
        answer: document.getElementById("caf-admin-answer")?.value.trim()
    };
    if (!payload.category || !payload.date_stamp || !payload.exam_focus || !payload.answer) {
        showToast("Choose or enter a category, then fill date, question, and answer.", "error");
        return;
    }
    try {
        await adminApiRequest("admin-flashcard", { body: payload });
        clearPublicApiCache();
        rememberAdminFlashcardContext({
            scope: payload.scope,
            catMode: "exist",
            existingCategory: payload.category,
            newCategory: ""
        });
        showToast(wasEditing ? "Current Affair flashcard updated." : "Current Affair flashcard saved.", "success");
        cafResetAdminForm();
        await caLoadState();
    } catch (e) {
        showToast("Could not save Current Affair flashcard. Check Supabase table/policies.", "error");
    }
}

function cafRenderAdminRegistry() {
    const registry = document.getElementById("caf-admin-registry");
    if (!registry) return;
    if (!cafNotes.length) {
        registry.innerHTML = `<div class="empty-state"><p>No Current Affair flashcards saved yet.</p></div>`;
        return;
    }
    registry.innerHTML = cafNotes.slice(0, 30).map(item => `
        <div class="caf-admin-row">
            <strong>${escapePEHtml(item.scope)}</strong>
            <span>${escapePEHtml(item.category)}</span>
            <span>${escapePEHtml(item.examFocus)}</span>
            <button type="button" class="btn-view-sm" data-caf-edit-id="${escapeHTML(String(item.id || ""))}">Edit</button>
        </div>
    `).join("");

    registry.querySelectorAll("[data-caf-edit-id]").forEach(button => {
        button.addEventListener("click", () => {
            cafStartEditCard(button.dataset.cafEditId || "");
        });
    });
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
            renderDailyQuoteAdminRegistry();
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
        const path = fresh ? `admin-quotes?refresh=${Date.now()}` : "admin-quotes";
        const rows = await adminApiRequest(path, { method: "GET" });
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

function resetDailyQuoteForm() {
    const form = document.getElementById("quote-admin-form");
    if (form) form.reset();
    editingQuoteId = "";
    const saveBtn = document.getElementById("quote-admin-save-btn");
    const cancelBtn = document.getElementById("quote-admin-cancel-btn");
    if (saveBtn) saveBtn.textContent = "Publish Quote";
    cancelBtn?.classList.add("is-hidden");
}

function startDailyQuoteEdit(id) {
    const quote = dailyQuotes.find(item => String(item.id || "") === String(id || ""));
    if (!quote) {
        showToast("Daily quote could not be loaded for editing.", "error");
        return;
    }
    editingQuoteId = String(quote.id || "");
    document.getElementById("quote-admin-english").value = quote.english || "";
    document.getElementById("quote-admin-dzongkha").value = quote.dzongkha || "";
    const saveBtn = document.getElementById("quote-admin-save-btn");
    const cancelBtn = document.getElementById("quote-admin-cancel-btn");
    if (saveBtn) saveBtn.textContent = "Update Quote";
    cancelBtn?.classList.remove("is-hidden");
    document.getElementById("quote-admin-form")?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function cancelDailyQuoteEdit() {
    resetDailyQuoteForm();
}

async function saveDailyQuote() {
    const wasEditing = Boolean(editingQuoteId);
    const english = document.getElementById("quote-admin-english")?.value.trim();
    const dzongkha = document.getElementById("quote-admin-dzongkha")?.value.trim();
    if (!english && !dzongkha) {
        showToast("Enter an English quote, a Dzongkha quote, or both.", "error");
        return;
    }

    try {
        await adminApiRequest("admin-quote", {
            body: {
                id: editingQuoteId || "",
                english_quote: english,
                dzongkha_quote: dzongkha
            }
        });
        clearPublicApiCache();
        await loadDailyQuotes({ fresh: true });
        dailyQuoteTickerIndex = 0;
        resetDailyQuoteForm();
        renderDailyQuoteTicker();
        renderDailyQuoteAdminRegistry();
        showToast(wasEditing ? "Quote updated successfully." : "Quote published for 24 hours.", "success");
    } catch (e) {
        const message = e?.message ? `Could not save quote: ${e.message}` : "Could not save quote.";
        showToast(message, "error");
    }
}

function renderDailyQuoteAdminRegistry() {
    const registry = document.getElementById("quote-admin-registry");
    if (!registry) return;
    if (!dailyQuotes.length) {
        registry.innerHTML = `<div class="empty-state"><p>No daily quotes published yet.</p></div>`;
        return;
    }
    registry.innerHTML = dailyQuotes.slice(0, 20).map(item => `
        <div class="quote-admin-row">
            <span>${item.english ? escapePEHtml(item.english) : '<span class="form-help">No English quote</span>'}</span>
            <span class="quote-admin-dzongkha">${item.dzongkha ? escapePEHtml(item.dzongkha) : '<span class="form-help">No Dzongkha quote</span>'}</span>
            <button type="button" class="btn-view-sm" data-quote-edit-id="${escapeHTML(String(item.id || ""))}">Edit</button>
        </div>
    `).join("");

    registry.querySelectorAll("[data-quote-edit-id]").forEach(button => {
        button.addEventListener("click", () => {
            startDailyQuoteEdit(button.dataset.quoteEditId || "");
        });
    });
}

function readPEResourceFile(input, targetId, maxBytes) {
    const file = input?.files?.[0];
    if (!file) return;
    if (file.size > maxBytes) {
        showToast("Resource files must be no larger than 6 MB.", "error");
        input.value = "";
        return;
    }
    const reader = new FileReader();
    reader.onload = () => { document.getElementById(targetId).value = String(reader.result || ""); };
    reader.readAsDataURL(file);
}

async function readPEResourceDocumentFile(input, targetId) {
    const file = input?.files?.[0];
    if (!file) return;
    const type = String(file.type || "").toLowerCase();
    if (type === "application/pdf") {
        readPEResourceFile(input, targetId, ADMIN_MEDIA_MAX_BYTES);
        return;
    }
    if (ADMIN_IMAGE_TYPES.has(type)) {
        await readPEResourceImageFile(input, targetId);
        return;
    }
    input.value = "";
    showToast("Please use a PDF, JPG, PNG, or WebP file.", "error");
}

async function readPEResourceImageFile(input, targetId) {
    const file = input?.files?.[0];
    if (!file) return;
    if (!validateAdminMediaFile(file, "image")) {
        input.value = "";
        return;
    }
    try {
        const imageDataUrl = await optimizeAdminImageFile(file);
        if (input.files?.[0] !== file) return;
        document.getElementById(targetId).value = imageDataUrl;
    } catch (error) {
        input.value = "";
        showToast("This image could not be optimized. Please choose another image.", "error");
    }
}

async function loadAdminPEResources() {
    if (!adminHasPermission("questions_view")) return;
    try {
        const rows = await adminApiRequest("admin-pe-resources", { method: "GET" });
        adminPEResources = Array.isArray(rows) ? rows : [];
        renderAdminPEResourceRegistry();
    } catch (error) {
        showToast(`Could not load PE resources: ${error.message || "Unknown error"}`, "error");
    }
}

function resetAdminPEResourceForm() {
    document.getElementById("pe-resource-admin-form")?.reset();
    document.getElementById("pe-resource-id").value = "";
    document.getElementById("pe-resource-sort-order").value = "0";
    document.getElementById("pe-resource-document").value = "";
    document.getElementById("pe-resource-preview").value = "";
    document.getElementById("pe-resource-document-file").value = "";
    document.getElementById("pe-resource-preview-file").value = "";
}

function editAdminPEResource(id) {
    const item = adminPEResources.find(resource => String(resource.id) === String(id));
    if (!item) return;
    document.getElementById("pe-resource-id").value = item.id || "";
    document.getElementById("pe-resource-kind").value = item.kind || "formula";
    document.getElementById("pe-resource-title").value = item.title || "";
    document.getElementById("pe-resource-content").value = item.content || "";
    document.getElementById("pe-resource-practice-prompt").value = item.practice_prompt || "";
    document.getElementById("pe-resource-practice-answer").value = item.practice_answer || "";
    document.getElementById("pe-resource-document").value = item.document_url || "";
    document.getElementById("pe-resource-preview").value = item.preview_url || "";
    document.getElementById("pe-resource-published").checked = Boolean(item.published);
    document.getElementById("pe-resource-sort-order").value = Number(item.sort_order || 0);
    document.getElementById("pe-resource-admin-form")?.scrollIntoView({ block: "start", behavior: "smooth" });
}

async function saveAdminPEResource() {
    const payload = {
        id: document.getElementById("pe-resource-id").value || "",
        kind: document.getElementById("pe-resource-kind").value,
        title: document.getElementById("pe-resource-title").value.trim(),
        content: document.getElementById("pe-resource-content").value,
        practice_prompt: document.getElementById("pe-resource-practice-prompt").value.trim(),
        practice_answer: document.getElementById("pe-resource-practice-answer").value.trim(),
        document_url: document.getElementById("pe-resource-document").value || "",
        preview_url: document.getElementById("pe-resource-preview").value || "",
        published: document.getElementById("pe-resource-published").checked,
        sort_order: Number(document.getElementById("pe-resource-sort-order").value || 0)
    };
    try {
        await adminApiRequest("admin-pe-resources", { method: "POST", body: payload });
        resetAdminPEResourceForm();
        await loadAdminPEResources();
        showToast("PE resource saved.", "success");
    } catch (error) {
        showToast(`Could not save PE resource: ${error.message || "Unknown error"}`, "error");
    }
}

function renderAdminPEResourceRegistry() {
    const registry = document.getElementById("pe-resource-registry");
    if (!registry) return;
    if (!adminPEResources.length) {
        registry.innerHTML = '<div class="empty-state"><p>No PE resources have been created yet.</p></div>';
        return;
    }
    registry.innerHTML = adminPEResources.map(item => `
        <div class="quote-admin-row">
            <span>${escapeHTML(item.title || "Untitled")}</span>
            <span class="form-help">${escapeHTML(item.kind || "")} · ${item.published ? "Published" : "Draft"}</span>
            <button type="button" class="btn-view-sm" data-pe-resource-edit-id="${escapeHTML(String(item.id || ""))}">Edit</button>
        </div>
    `).join("");
    registry.querySelectorAll("[data-pe-resource-edit-id]").forEach(button => {
        button.addEventListener("click", () => editAdminPEResource(button.dataset.peResourceEditId || ""));
    });
}

// PE (PRACTICE ENGINE) PAGE
// Sidebar click-handling below mirrors the reference template's
// own logic exactly:
//   listItems.forEach(li => li.classList.remove('active'));
//   item.classList.add('active');
//   contentSections.forEach(s => s.classList.remove('active'));
//   document.getElementById(targetPanelId).classList.add('active');
// ════════════════════════════════════════════════════════
let peActiveTopic = null;   // { peType, topic } while viewing questions; null while browsing
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
    if (menuToggle && navigation) {
        menuToggle.onclick = () => {
            navigation.classList.toggle("open");
            if (spacer) spacer.classList.toggle("open", navigation.classList.contains("open"));
        };
    }

    const listItems = document.querySelectorAll("#pe-list .pe-list-item");
    const contentSections = document.querySelectorAll(".pe-content .pe-section");

    listItems.forEach((item) => {
        item.querySelector("a").onclick = (event) => {
            event.preventDefault();
            listItems.forEach((li) => li.classList.remove("active"));
            item.classList.add("active");

            peActiveTopic = null; // returning to a top-level panel exits question view

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
    document.getElementById("admin-view").style.display = "none";
    document.getElementById("pe-view").style.display = "block";
    hideTopActionButtons();
    document.getElementById("pe-back-btn").style.display = "block";

    wirePESidebar();

    // Reset to Home panel and a collapsed sidebar every time PE is opened
    peActiveTopic = null;
    document.getElementById("pe-navigation").classList.remove("open");
    document.getElementById("pe-navigation-spacer").classList.remove("open");
    document.querySelectorAll("#pe-list .pe-list-item").forEach(li => {
        li.classList.toggle("active", li.dataset.target === "pe-home-panel");
    });
    document.querySelectorAll(".pe-content .pe-section").forEach(s => s.classList.remove("active"));
    document.getElementById("pe-home-panel").classList.add("active");

    if (!databaseReady) {
        showLoading(true, "Opening PE...");
        const loaded = await loadDatabase();
        showLoading(false);
        if (!loaded) {
            closePEPortal();
            return;
        }
    }

    renderPEHomeGrid();

    loadPEOnlineQuestionBank()
        .then(() => {
            updatePEOnlineCount();
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
        grid.innerHTML = '<div class="pe-empty-msg">No PE questions here yet. Add some from the Admin panel.</div>';
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

function renderPEHomeGrid() {
    renderPETopicGrid("pe-home-grid", "all", "pe-home-search", "#f44336");
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
    if (peType === "Data Interpretation") {
        openPEDIViewer(topic);
        return;
    }
    peActiveTopic = { peType, topic };

    const topicQuestions = getPEQuestions().filter(q => {
        const info = parsePECategory(q.category);
        return info.peType === peType && info.topic === topic;
    });
    try {
        await fetchSelectedQuestionMedia(topicQuestions);
    } catch (error) {
        console.error("PE topic media load failed:", error);
        showToast("The questions loaded, but some media could not be downloaded.", "info");
    }

    document.querySelectorAll(".pe-content .pe-section").forEach(s => s.classList.remove("active"));
    document.getElementById("pe-question-screen").classList.add("active");

    renderPEQuestionList();
}

function showPEFolderScreen() {
    if (!peActiveTopic) return;
    const returnType = peActiveTopic.peType;
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

function renderPEDIGrid() {
    const grid = document.getElementById("pe-di-grid");
    if (!grid) return;
    const searchTerm = document.getElementById("pe-di-search")?.value || "";
    const sets = buildPETopicList("Data Interpretation", searchTerm);

    if (sets.length === 0) {
        grid.innerHTML = '<div class="pe-empty-msg">No Data Interpretation sets yet. Add one from the Admin panel.</div>';
        return;
    }

    grid.innerHTML = sets.map(s => {
        const firstQ = getPEQuestions().find(q => {
            const info = parsePECategory(q.category);
            return info.peType === "Data Interpretation" && info.topic === s.topic;
        });
        const thumbnailSource = firstQ ? safeMediaSource(firstQ.imageCode, "image") : "";
        const thumb = thumbnailSource
            ? `<img src="${thumbnailSource}" class="pe-card-thumb" alt="" loading="lazy" decoding="async">`
            : `<i class="bi bi-bar-chart-line pe-card-icon"></i>`;
        return `
            <div class="pe-card accent-purple" data-di-topic="${escapeHTML(s.topic)}">
                ${thumb}
                <div class="pe-card-info">
                    <div class="pe-card-title">${escapePEHtml(s.topic)}</div>
                    <div class="pe-card-meta"> ${s.count} question${s.count === 1 ? "" : "s"}</div>
                </div>
            </div>
        `;
    }).join("");

    grid.querySelectorAll(".pe-card[data-di-topic]").forEach(card => {
        card.addEventListener("click", () => {
            openPEDIViewer(card.dataset.diTopic || "");
        });
    });
}

async function openPEDIViewer(setName) {
    peDIActiveSet = setName;

    const setQuestions = getPEDISetQuestions(setName);
    document.querySelectorAll(".pe-content .pe-section").forEach(s => s.classList.remove("active"));
    document.getElementById("pe-di-viewer-screen").classList.add("active");

    const chartImg = document.getElementById("pe-di-chart-img");
    document.getElementById("pe-di-set-title").textContent = setName;
    renderPEDIQuestion();

    const sharedGraphQuestion = setQuestions[0];
    const cachedGraph = sharedGraphQuestion ? safeMediaURL(sharedGraphQuestion.imageCode, "image") : "";
    if (cachedGraph) chartImg.src = cachedGraph;
    else chartImg.removeAttribute("src");

    if (!sharedGraphQuestion || cachedGraph) return;
    try {
        // A DI set uses one shared graph. Fetching every row would download
        // duplicate Base64 images and block the viewer unnecessarily.
        await fetchSelectedQuestionMedia([sharedGraphQuestion], { persistCache: false });
        if (peDIActiveSet !== setName) return;
        const graphSource = safeMediaURL(sharedGraphQuestion.imageCode, "image");
        if (graphSource) chartImg.src = graphSource;
        else chartImg.removeAttribute("src");
    } catch (error) {
        console.error("Data Interpretation graph load failed:", error);
        if (peDIActiveSet === setName) {
            showToast("The questions opened, but the graph could not be downloaded.", "info");
        }
    }
}

function closePEDIViewer() {
    peDIActiveSet = null;
    document.querySelectorAll("#pe-list .pe-list-item").forEach(li => {
        li.classList.toggle("active", li.dataset.target === "pe-di-panel");
    });
    document.querySelectorAll(".pe-content .pe-section").forEach(s => s.classList.remove("active"));
    document.getElementById("pe-di-panel").classList.add("active");
    renderPEDIGrid();
}

function getPEDISetQuestions(setName) {
    return getPEQuestions().filter(q => {
        const info = parsePECategory(q.category);
        return info.peType === "Data Interpretation" && info.topic === setName;
    });
}

function renderPEDIQuestion() {
    const container = document.getElementById("pe-di-questions-container");
    if (!peDIActiveSet) { container.innerHTML = ""; return; }

    const setQuestions = getPEDISetQuestions(peDIActiveSet);
    if (setQuestions.length === 0) {
        container.innerHTML = '<div class="pe-empty-msg">No questions in this set.</div>';
        return;
    }

    pePracticeQuestionsByDomId.clear();
    container.innerHTML = setQuestions.map((q, questionIndex) => {
        const options = Array.isArray(q.options) ? q.options : [];
        const qId = `pe-di-q-${questionIndex}`;
        pePracticeQuestionsByDomId.set(qId, q);
        const optionsHtml = options.slice(0, 4).map((opt, optionIndex) => `
            <button type="button" class="pe-option" id="${qId}-opt-${optionIndex}"
                data-pe-answer-qid="${qId}" data-pe-answer-opt="${optionIndex}">
                ${ALPHA[optionIndex]}. ${escapePEHtml(opt || "")}
            </button>
        `).join("");
        return `
            <div class="pe-question-card accent-purple">
                <div class="pe-question-meta">
                    <div class="pe-question-num">${questionIndex + 1}</div>
                    <span class="pe-question-tag">Data Interpretation</span>
                    <span class="pe-question-tag">${escapePEHtml(peDIActiveSet)}</span>
                </div>
                <div class="pe-question-text">${escapePEHtml(q.question || "")}</div>
                ${safeMediaSource(q.audioCode, "audio") ? `<div class="q-audio-wrap"><audio src="${safeMediaSource(q.audioCode, "audio")}" class="q-audio" controls preload="metadata"></audio></div>` : ""}
                <div class="pe-options-grid" id="${qId}-options">${optionsHtml}</div>
                <div class="pe-question-actions">
                    <div class="pe-feedback-msg" id="${qId}-feedback"></div>
                </div>
                <div class="pe-solution-box accent-purple" id="${qId}-solution">
                    <div class="pe-solution-title">💡 Solution &amp; Explanation</div>
                    <div class="pe-solution-text">${escapePEHtml(q.explanation)}</div>
                </div>
            </div>
        `;
    }).join("");

    container.querySelectorAll("[data-pe-answer-qid]").forEach((button) => {
        button.addEventListener("click", () => answerPEQuestion(button.dataset.peAnswerQid || "", Number(button.dataset.peAnswerOpt)));
    });
}

// ─── Question attempt flow (attempt first, then reveal) ────
function renderPEQuestionList() {
    const container = document.getElementById("pe-questions-container");
    if (!peActiveTopic) { container.innerHTML = ""; return; }

    const list = getPEQuestions().filter(q => {
        const info = parsePECategory(q.category);
        return info.peType === peActiveTopic.peType && info.topic === peActiveTopic.topic;
    });

    if (list.length === 0) {
        container.innerHTML = '<div class="pe-empty-msg">No questions in this topic yet.</div>';
        return;
    }

    pePracticeQuestionsByDomId.clear();
    container.innerHTML = list.map((q, idx) => {
        const peInfo = parsePECategory(q.category);
        const options = Array.isArray(q.options) ? q.options : [];
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
                <div class="pe-solution-text">${escapePEHtml(q.explanation)}</div>
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
                <div class="pe-options-grid" id="${qId}-options">${optionsHtml}</div>
                <div class="pe-question-actions">
                    <div class="pe-feedback-msg" id="${qId}-feedback"></div>
                </div>
                ${explanationHtml}
            </div>
        `;
    }).join("");

    container.querySelectorAll("[data-pe-answer-qid]").forEach((button) => {
        button.addEventListener("click", () => answerPEQuestion(button.dataset.peAnswerQid || "", Number(button.dataset.peAnswerOpt)));
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
        result = await apiRequest("question-solution", {
            method: "POST",
            body: { id: String(question.id), selected_index: chosenIndex }
        });
    } catch (error) {
        setPEQuestionLoading(qId, false);
        showToast(`Could not check answer: ${error.message}`, "error");
        return;
    }
    lockPEOptions(qId);
    const chosenBtn = document.getElementById(`${qId}-opt-${chosenIndex}`);
    const feedback = document.getElementById(`${qId}-feedback`);

    if (result.correct === true) {
        chosenBtn.classList.add("pe-correct");
        if (feedback) { feedback.textContent = "✓ Correct!"; feedback.className = "pe-feedback-msg correct"; }
    } else {
        chosenBtn.classList.add("pe-incorrect");
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

const ADMIN_MEDIA_MAX_BYTES = 6 * 1024 * 1024;
const ADMIN_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ADMIN_AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp4", "audio/wav"]);
const ADMIN_IMAGE_MAX_DIMENSION = 1600;
const ADMIN_IMAGE_WEBP_QUALITY = 0.92;

function validateAdminMediaFile(file, mediaType) {
    const allowedTypes = mediaType === "image" ? ADMIN_IMAGE_TYPES : ADMIN_AUDIO_TYPES;
    if (!allowedTypes.has(String(file?.type || "").toLowerCase())) {
        showToast(
            mediaType === "image"
                ? "Please use a JPG, PNG, or WebP image."
                : "Please use an MP3, M4A/MP4, or WAV audio file.",
            "error"
        );
        return false;
    }
    if (!Number.isFinite(file.size) || file.size <= 0 || file.size > ADMIN_MEDIA_MAX_BYTES) {
        showToast("Media files must be no larger than 6 MB.", "error");
        return false;
    }
    return true;
}

function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("File could not be read."));
        reader.readAsDataURL(file);
    });
}

function loadAdminImage(file) {
    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error("Image could not be decoded."));
        };
        image.src = objectUrl;
    });
}

function dataUrlByteLength(value) {
    const data = String(value || "").split(",")[1] || "";
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

async function optimizeAdminImageFile(file) {
    const image = await loadAdminImage(file);
    const sourceWidth = Number(image.naturalWidth || image.width || 0);
    const sourceHeight = Number(image.naturalHeight || image.height || 0);
    if (!sourceWidth || !sourceHeight || sourceWidth * sourceHeight > 40000000) {
        throw new Error("Image dimensions are unsupported.");
    }

    const scale = Math.min(1, ADMIN_IMAGE_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return readFileAsDataURL(file);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    const optimized = canvas.toDataURL("image/webp", ADMIN_IMAGE_WEBP_QUALITY);
    if (!optimized.startsWith("data:image/webp;")) return readFileAsDataURL(file);
    return dataUrlByteLength(optimized) < file.size ? optimized : readFileAsDataURL(file);
}

async function handleImageUpload(input) {
    const file = input.files[0];
    const preview = document.getElementById("adm-img-preview");
    const b64     = document.getElementById("adm-img-b64");
    if (!file) { b64.value = ""; preview.classList.remove("has-preview"); return; }
    if (!validateAdminMediaFile(file, "image")) {
        input.value = "";
        b64.value = "";
        preview.removeAttribute("src");
        preview.classList.remove("has-preview");
        return;
    }
    try {
        const imageDataUrl = await optimizeAdminImageFile(file);
        if (input.files?.[0] !== file) return;
        b64.value = imageDataUrl;
        preview.src = imageDataUrl;
        preview.classList.add("has-preview");
    } catch (error) {
        input.value = "";
        b64.value = "";
        preview.removeAttribute("src");
        preview.classList.remove("has-preview");
        showToast("This image could not be optimized. Please choose another image.", "error");
    }
}

function handleAudioUpload(input) {
    const file = input.files[0];
    const preview = document.getElementById("adm-audio-preview");
    const b64 = document.getElementById("adm-audio-b64");
    if (!file) { b64.value = ""; preview.classList.add("is-hidden"); return; }
    if (!validateAdminMediaFile(file, "audio")) {
        input.value = "";
        b64.value = "";
        preview.removeAttribute("src");
        preview.classList.add("is-hidden");
        return;
    }
    const reader = new FileReader();
    reader.onload = e => {
        b64.value = e.target.result;
        preview.src = e.target.result;
        preview.classList.remove("is-hidden");
    };
    reader.readAsDataURL(file);
}

function setAdminFormMode(mode) {
    const isEdit = mode === "edit";
    document.getElementById("admin-form-title").textContent = isEdit ? "Edit Question" : "Add Question";
    document.getElementById("admin-submit-btn").textContent = isEdit ? "Save Changes" : "+ Save to Database";
    document.getElementById("cancel-edit-btn")?.classList.toggle("is-hidden", !isEdit);
}

function resetAdminForm() {
    const previous = captureAdminQuestionContext();
    document.getElementById("admin-form").reset();
    document.getElementById("adm-img-preview")?.classList.remove("has-preview");
    document.getElementById("adm-img-b64").value = "";
    document.getElementById("adm-audio-preview")?.classList.add("is-hidden");
    document.getElementById("adm-audio-preview").removeAttribute("src");
    document.getElementById("adm-audio-b64").value = "";
    document.getElementById("adm-explanation").value = "";
    document.querySelectorAll("[name='cat-mode']")[0].checked = true;
    document.querySelectorAll("[name='dest-mode']")[0].checked = true;
    document.querySelectorAll("[name='pe-type']")[0].checked = true;
    editingQuestionIndex = null;
    onDestModeChange();
    onPeTypeChange();
    onCatModeChange();
    if (previous.destMode || previous.existingCategory || previous.newCategory || previous.peTopic) restoreAdminQuestionContext();
    setAdminFormMode("add");
}

function cancelQuestionEdit() {
    resetAdminForm();
}

async function editQuestion(idx) {
    const q = questionPool[idx];
    if (!q) return;

    if (!q._adminMediaLoaded) {
        showLoading(true, "Loading question media...");
        try {
            await loadAdminQuestionMedia(idx);
        } catch (error) {
            showToast("Question opened without media preview. Media can be re-uploaded if needed.", "info");
        } finally {
            showLoading(false);
        }
    }

    editingQuestionIndex = idx;
    const peInfo = parsePECategory(q.category);

    if (peInfo) {
        const peDestination = q.sourceTable === "PEOnlineExam" ? "pe-online" : "pe";
        document.querySelector(`[name='dest-mode'][value='${peDestination}']`).checked = true;
        onDestModeChange();
        const editablePeType = peDestination === "pe-online" && peInfo.peType === PE_BCSC_MAIN_TYPE
            ? "Past Paper"
            : peInfo.peType;
        document.querySelector(`[name='pe-type'][value='${editablePeType}']`).checked = true;
        onPeTypeChange();
        document.getElementById("adm-pe-topic").value = peInfo.topic || "";
    } else {
        // Editing a normal exam question
        document.querySelector("[name='dest-mode'][value='exam']").checked = true;
        onDestModeChange();
        const existingCategory = categories.includes(q.category);
        document.querySelector("[name='cat-mode'][value='exist']").checked = existingCategory;
        document.querySelector("[name='cat-mode'][value='new']").checked = !existingCategory;
        onCatModeChange();
        if (existingCategory) document.getElementById("adm-cat-select").value = q.category;
        else document.getElementById("adm-cat-input").value = q.category || "";
    }

    document.getElementById("adm-question").value = q.question || "";
    document.getElementById("adm-explanation").value = q.explanation || "";
    ["A","B","C","D"].forEach((label, index) => {
        document.getElementById(`adm-${label}`).value = (q.options || [])[index] || "";
    });
    document.getElementById("adm-correct").value = Number.isInteger(q.answer) && q.answer >= 0 ? q.answer : 0;
    document.getElementById("adm-img-b64").value = q.imageCode || "";
    const preview = document.getElementById("adm-img-preview");
    preview.src = q.imageCode || "";
    preview.classList.toggle("has-preview", Boolean(q.imageCode));
    document.getElementById("adm-audio-b64").value = q.audioCode || "";
    const audioPreview = document.getElementById("adm-audio-preview");
    audioPreview.src = q.audioCode || "";
    audioPreview.classList.toggle("is-hidden", !q.audioCode);
    setAdminFormMode("edit");
    document.getElementById("admin-form").scrollIntoView({ block: "start", behavior: "smooth" });
}

	async function saveQuestion() {
	    let cat = getAdminCategory();

	    if (!cat || cat === "No categories available") {
	        showToast("Please specify a valid category.", "error"); return;
	    }

	    const question = document.getElementById("adm-question").value.trim();
	    const options = ["A","B","C","D"].map(l => document.getElementById(`adm-${l}`).value.trim());
	    if (!question || options.some(o => !o)) {
	        showToast("Please complete the question and all four options.", "error"); return;
	    }

	    showLoading(true, "Saving question to database…");
	    const payload = {
            id: "",
            table: "",
	        category: cat,
	        question,
	        explanation: document.getElementById("adm-explanation").value.trim(),
	        options,
	        answer: parseInt(document.getElementById("adm-correct").value),
	        imageCode: document.getElementById("adm-img-b64").value,
	        audioCode: document.getElementById("adm-audio-b64").value
	    };

    const wasEditing = editingQuestionIndex !== null;
    try {
        if (wasEditing) {
            const existing = questionPool[editingQuestionIndex];
            if (!existing || existing.id === undefined || existing.id === null) {
                showToast("Question ID is missing. Refresh and try again.", "error");
                return;
            }
            payload.id = String(existing.id);
            payload.table = getAdminTargetTable(existing);
        } else {
            payload.table = getAdminTargetTable();
        }
        await adminApiRequest("admin-question", { body: payload });
        rememberAdminQuestionContext({
            destMode: payload.table === "PEOnlineExam"
                ? "pe-online"
                : isPECategory(payload.category)
                ? "pe"
                : "exam",
            peType: parsePECategory(payload.category)?.peType || PE_BCSC_MAIN_TYPE,
            catMode: "exist",
            existingCategory: isPECategory(payload.category) ? "" : payload.category,
            newCategory: "",
            peTopic: parsePECategory(payload.category)?.topic || ""
        });
        resetAdminForm();
        clearDatabaseCache();
        databaseReady = false;
        await showAdminPortal();
        showToast(wasEditing ? "Question updated successfully!" : "Question saved successfully!", "success");
    } catch (e) {
        console.error("Save question error:", e);
        showToast(`Failed to save question: ${e.message || "Unknown error"}`, "error");
    } finally {
        showLoading(false);
    }
	}

	function stripQuestionPrefix(text) {
	    return String(text || "").trim().replace(/^\d+[\).:-]\s*/, "").replace(/^Question\s*[:.-]\s*/i, "").trim();
	}

	function stripOptionPrefix(text) {
	    return String(text || "").trim()
	        .replace(/^Option\s*[A-D]\s*[:).-]\s*/i, "")
	        .replace(/^[A-D]\s*[:).-]\s*/i, "")
	        .replace(/^[1-4]\s*[:).-]\s*/i, "")
	        .trim();
	}

	function stripAnswerPrefix(text) {
	    return String(text || "").trim()
	        .replace(/^(Correct\s*)?Answer\s*[:.-]\s*/i, "")
	        .replace(/^Correct\s*[:.-]\s*/i, "")
	        .trim();
	}

	function buildBulkQuestion(category, question, options, correctRaw, label) {
	    const answer = parseCorrectAnswer(stripAnswerPrefix(correctRaw));
	    const cleanedQuestion = stripQuestionPrefix(question);
	    const cleanedOptions = options.map(stripOptionPrefix);

	    if (!cleanedQuestion || cleanedOptions.some(option => !option)) {
	        return { error: `${label}: question and all four options are required` };
	    }

	    if (answer === -1) {
	        return { error: `${label}: answer must be A, B, C, D, or 1-4` };
	    }

	    return {
	        question: {
	            category,
	            question: cleanedQuestion,
	            options: cleanedOptions,
	            answer,
	            imageCode: "",
	            audioCode: ""
	        }
	    };
	}

	function parsePipeBulkQuestions(rawText, category) {
	    const questions = [];
	    const errors = [];
	    const lines = rawText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

	    lines.forEach((line, index) => {
	        const parts = line.split("|").map(part => part.trim());
	        if (parts.length !== 6) {
	            errors.push(`Line ${index + 1}: use Question | A | B | C | D | Answer`);
	            return;
	        }

	        const result = buildBulkQuestion(
	            category,
	            parts[0],
	            parts.slice(1, 5),
	            parts[5],
	            `Line ${index + 1}`
	        );

	        if (result.error) errors.push(result.error);
	        else questions.push(result.question);
	    });

	    return { questions, errors };
	}

	function parseBlockBulkQuestions(rawText, category) {
	    const questions = [];
	    const errors = [];
	    const lines = rawText.split(/\r?\n/);
	    let current = { questionLines: [], options: [], answer: "", startLine: 1 };

	    const finish = (lineNumber) => {
	        if (!current.questionLines.length && !current.options.length && !current.answer) return;
	        const label = `Question ${questions.length + 1} (lines ${current.startLine}-${lineNumber})`;
	        if (current.options.length !== 4 || !current.answer) {
	            errors.push(`${label}: include A, B, C, D, and Answer`);
	        } else {
	            const result = buildBulkQuestion(category, current.questionLines.join("\n"), current.options, current.answer, label);
	            if (result.error) errors.push(result.error);
	            else questions.push(result.question);
	        }
	        current = { questionLines: [], options: [], answer: "", startLine: lineNumber + 1 };
	    };

	    lines.forEach((rawLine, index) => {
	        const line = rawLine.trim();
	        const lineNumber = index + 1;
	        if (!line) return;
	        const answerMatch = line.match(/^(?:(?:correct\s*)?answer|correct)\s*[:.\-)]+\s*(.+)$/i);
	        const optionMatch = line.match(/^(?:option\s*)?([A-D])\s*[:.\-)]+\s*(.+)$/i);

	        if (answerMatch) {
	            current.answer = answerMatch[1];
	            finish(lineNumber);
	        } else if (optionMatch) {
	            const expected = ALPHA[current.options.length];
	            if (optionMatch[1].toUpperCase() !== expected) {
	                errors.push(`Line ${lineNumber}: expected option ${expected || "Answer"}`);
	            }
	            current.options.push(optionMatch[2]);
	        } else if (current.options.length) {
	            errors.push(`Line ${lineNumber}: option/answer lines need an A-D or Answer prefix`);
	        } else {
	            if (!current.questionLines.length) current.startLine = lineNumber;
	            current.questionLines.push(line);
	        }
	    });
	    finish(lines.length);

	    return { questions, errors };
	}

	function parseBulkQuestions(rawText, category) {
	    const contentLines = rawText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	    const hasPipeFormat = contentLines.length > 0 && contentLines.every(line => line.split("|").length === 6);
	    return hasPipeFormat
	        ? parsePipeBulkQuestions(rawText, category)
	        : parseBlockBulkQuestions(rawText, category);
	}

	function updateBulkImportPreview() {
	    const preview = document.getElementById("bulk-import-preview");
	    const submit = document.getElementById("bulk-submit-btn");
	    const input = document.getElementById("bulk-questions");
	    if (!preview || !submit || !input) return;
	    const rawText = input.value.trim();
	    preview.classList.remove("is-ready", "has-error");
	    if (!rawText) {
	        preview.textContent = "Paste questions to preview the import.";
	        submit.disabled = true;
	        return;
	    }
	    const category = getAdminCategory();
	    if (!category || category === "No categories available") {
	        preview.textContent = "Choose or enter a destination category first.";
	        preview.classList.add("has-error");
	        submit.disabled = true;
	        return;
	    }
	    const { questions, errors } = parseBulkQuestions(rawText, category);
	    if (errors.length) {
	        preview.textContent = `${questions.length} valid · ${errors.length} issue${errors.length === 1 ? "" : "s"}. ${errors[0]}`;
	        preview.classList.add("has-error");
	        submit.disabled = true;
	        return;
	    }
	    if (questions.length > 200) {
	        preview.textContent = `${questions.length} questions found. Import at most 200 at a time.`;
	        preview.classList.add("has-error");
	        submit.disabled = true;
	        return;
	    }
	    preview.textContent = `${questions.length} question${questions.length === 1 ? "" : "s"} ready for ${category}.`;
	    preview.classList.add("is-ready");
	    submit.disabled = questions.length === 0;
	}

	async function saveBulkQuestions() {
	    const cat = getAdminCategory();
	    if (!cat || cat === "No categories available") {
	        showToast("Please specify a valid category.", "error"); return;
	    }

	    const rawText = document.getElementById("bulk-questions").value.trim();
	    if (!rawText) {
	        showToast("Please paste at least one bulk question line.", "error"); return;
	    }

	    const { questions, errors } = parseBulkQuestions(rawText, cat);
	    if (errors.length) {
	        showToast(errors[0], "error"); return;
	    }
	    if (!questions.length) {
	        showToast("No valid questions found.", "error"); return;
	    }
	    if (questions.length > 200) {
	        showToast("Import at most 200 questions at a time.", "error"); return;
	    }

	    showLoading(true, `Saving ${questions.length} questions…`);
	    try {
	        const table = getAdminTargetTable();
	        await adminApiRequest("admin-bulk-questions", {
                body: {
                    table,
                    questions: questions.map(question => ({
                        category: question.category,
                        question: question.question,
                        explanation: question.explanation || "",
                        options: question.options,
                        answer: question.answer,
                        imageCode: question.imageCode || "",
                        audioCode: question.audioCode || ""
                    }))
                }
            });

	        document.getElementById("bulk-form").reset();
	        updateBulkImportPreview();
	        clearDatabaseCache();
            databaseReady = false;
            await showAdminPortal();
	        const peInfo = parsePECategory(cat);
	        const destinationLabel = table === "PEOnlineExam"
                ? `🧪 PE Online → ${peInfo?.peType || "General"} → ${peInfo?.topic || "General"}`
                : peInfo
                ? `📚 PE → ${peInfo.peType} → ${peInfo.topic}`
                : `Exam category "${cat}"`;
	        showToast(`${questions.length} questions appended to: ${destinationLabel}`, "success");
	        if (document.getElementById("pe-view") && document.getElementById("pe-view").style.display !== "none") {
	            renderPEHomeGrid();
	            renderPEMockGrid();
	            renderPEPastGrid();
	            updatePEOnlineCount();
	        }
	    } catch (e) {
	        console.error("Bulk save error:", e);
	        showToast(`Bulk append failed: ${e.message || "Please try again."}`, "error");
	    } finally {
	        showLoading(false);
	    }
	}

	async function viewQuestion(idx) {
	    const q = questionPool[idx];
	    if (!q) return;
	    const body = document.getElementById("question-view-body");
	    const modal = document.getElementById("question-view-modal");
	    body.innerHTML = '<div class="empty-state"><p>Loading question details…</p></div>';
	    modal.classList.add("open");
	    if (!q._adminMediaLoaded) {
	        try { await loadAdminQuestionMedia(idx); }
	        catch (error) { console.warn("Question media preview unavailable:", error); }
	    }

	    const options = Array.isArray(q.options) ? q.options : [];
	    const answerIndex = Number.isInteger(q.answer) ? q.answer : parseInt(q.answer, 10);
	    const optionsHtml = options.slice(0, 4).map((option, oi) => `
	        <div class="question-view-option ${oi === answerIndex ? 'correct' : ''}">
	            <span class="question-view-alpha">${ALPHA[oi] || oi + 1}</span>
	            <span>${escapeHTML(formatOptionText(option))}${oi === answerIndex ? ' ✓' : ''}</span>
	        </div>
	    `).join("");

	    const imageSource = safeMediaSource(q.imageCode, "image");
	    const audioSource = safeMediaSource(q.audioCode, "audio");
	    body.innerHTML = `
	        <div class="question-view-category">${escapeHTML(q.category || "Uncategorized")}</div>
	        <div class="question-view-text">${escapeHTML(q.question || "")}</div>
	        ${imageSource ? `<img class="question-view-image" src="${imageSource}" alt="Question reference">` : ""}
	        ${audioSource ? `<audio class="question-view-audio" src="${audioSource}" controls preload="metadata"></audio>` : ""}
	        <div class="question-view-options">${optionsHtml || '<div class="empty-state"><p>No options found.</p></div>'}</div>
	        ${q.explanation ? `<div class="question-view-explanation"><strong>Explanation</strong><span>${escapeHTML(q.explanation)}</span></div>` : ""}
	    `;
	}

	function closeQuestionView() {
	    document.getElementById("question-view-modal").classList.remove("open");
	}

	function handleQuestionViewBackdropClick(e) {
	    if (e.target === document.getElementById("question-view-modal")) closeQuestionView();
	}

	function renderAdminTable() {
	    const tbody = document.getElementById("admin-tbody");
	    if (!tbody) return;
    if (questionPool.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>No questions in the database yet.</p></div></td></tr>`;
        return;
    }
    const canEdit = adminHasPermission("questions_edit");
    tbody.innerHTML = questionPool.map((q, i) => {
        const peInfo = parsePECategory(q.category);
        const isPEOnline = q.sourceTable === "PEOnlineExam";
        const badge = peInfo
            ? `<span class="registry-badge ${isPEOnline ? "pe-online" : "pe"}">${isPEOnline ? "🧪 PE Online" : "📚 PE"} · ${escapeHTML(peInfo.peType)} · ${escapeHTML(peInfo.topic)}</span>`
            : `<span class="registry-badge exam">${escapeHTML(q.category)}</span>`;
        return `
	        <tr>
	            <td class="registry-index-cell">${i+1}</td>
	            <td>${badge}</td>
	            <td class="admin-question-cell" title="${escapeHTML(q.question)}">${escapeHTML(q.question)}</td>
	            <td><div class="admin-question-actions">
	                <button type="button" class="btn-view-sm" data-view-question-index="${i}">View</button>
	                ${canEdit ? `<button type="button" class="btn-view-sm" data-edit-question-index="${i}">Edit</button>` : ""}
	            </div></td>
	        </tr>`;
    }).join("");

    tbody.querySelectorAll("[data-view-question-index]").forEach((button) => {
        button.addEventListener("click", () => { void viewQuestion(Number(button.dataset.viewQuestionIndex)); });
    });
    tbody.querySelectorAll("[data-edit-question-index]").forEach((button) => {
        button.addEventListener("click", () => editQuestion(Number(button.dataset.editQuestionIndex)));
    });
	}
