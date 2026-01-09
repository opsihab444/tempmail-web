const API_BASE = "https://codezen-temp.ms-sihab-543.workers.dev";
const DOMAIN = "codezen.indevs.in";

// State
let activeToken = localStorage.getItem("tempmail_token") || "";
let activeTab = "text";
let pollInterval = null;
let lastMessageIds = new Set();
let selectedMessage = null;

// DOM Elements
const el = (id) => document.getElementById(id);

// Utils
const generateToken = (len = 8) => {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    return Array.from(crypto.getRandomValues(new Uint32Array(len)))
        .map((n) => chars[n % chars.length])
        .join("");
};

const formatDate = (ms) => {
    try {
        return new Date(ms).toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    } catch { return String(ms); }
};

const copyToClipboard = async (text) => {
    try {
        await navigator.clipboard.writeText(text);
        showToast("Copied to clipboard!", "success");
    } catch (err) {
        showToast("Failed to copy", "error");
    }
};

const showToast = (msg, type = "normal") => {
    // Remove existing toast
    const existing = document.querySelector(".toast-notification");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = `toast-notification fixed bottom-6 left-1/2 -translate-x-1/2 px-6 py-3 rounded-full glass text-sm font-medium animate-pop flex items-center gap-2 z-50 shadow-2xl backdrop-blur-xl border border-white/20`;

    let icon = type === "success" ? `<svg class="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`
        : type === "error" ? `<svg class="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`
            : `<div class="w-2 h-2 rounded-full bg-indigo-500"></div>`;

    toast.innerHTML = `${icon}<span class="text-slate-100">${msg}</span>`;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translate(-50%, 10px)";
        setTimeout(() => toast.remove(), 300);
    }, 3000);
};

// API
const apiGet = async (path) => {
    const res = await fetch(API_BASE + path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
};

// Core Logic
const init = () => {
    if (activeToken) {
        el("tokenInput").value = activeToken;
        activateToken(activeToken, false);
    } else {
        el("landingView").classList.remove("hidden");
        el("dashboardView").classList.add("hidden");
    }
};

const activateToken = (token, save = true) => {
    if (!token) return showToast("Please enter a valid token", "error");

    activeToken = token.toLowerCase();
    if (save) localStorage.setItem("tempmail_token", activeToken);

    el("activeEmailDisplay").textContent = `${activeToken}@${DOMAIN}`;

    // Transition
    el("landingView").classList.add("hidden");
    el("dashboardView").classList.remove("hidden");
    el("dashboardView").classList.add("animate-fade-in");

    lastMessageIds.clear();
    loadInbox();
    startPolling();
};

const CACHE_KEY = "tempmail_msg_cache";

const renderSkeleton = () => {
    const list = el("msgList");
    // Don't nuke list if we have content, just show loadeer indicator nearby if needed?
    // Actually for first load, nuking is fine.
    if (list.childElementCount > 0 && !list.querySelector('.skeleton')) return;

    list.innerHTML = "";
    for (let i = 0; i < 5; i++) {
        const div = document.createElement("div");
        div.className = "w-full p-4 rounded-2xl mb-2 border border-white/5 bg-white/5";
        div.innerHTML = `
            <div class="flex justify-between gap-4">
                <div class="flex-1 space-y-2">
                    <div class="h-4 w-3/4 skeleton rounded"></div>
                    <div class="h-3 w-1/2 skeleton rounded opacity-60"></div>
                </div>
                <div class="h-3 w-12 skeleton rounded opacity-40"></div>
            </div>
        `;
        list.appendChild(div);
    }
};

const loadInbox = async () => {
    if (!activeToken) return;

    // 1. CACHE FIRST (Stale-while-revalidate)
    const cachedRaw = localStorage.getItem(CACHE_KEY);
    if (cachedRaw && lastMessageIds.size === 0) {
        try {
            const cachedMessages = JSON.parse(cachedRaw);
            if (Array.isArray(cachedMessages) && cachedMessages.length > 0) {
                renderMessages(cachedMessages, true); // true = isCached
            } else {
                renderSkeleton();
            }
        } catch { renderSkeleton(); }
    } else if (lastMessageIds.size === 0) {
        renderSkeleton();
    }

    try {
        // Add timestamp to prevent request caching by browser/sw
        const data = await apiGet(`/api/inbox/${encodeURIComponent(activeToken)}?_=${Date.now()}`);
        const messages = data.messages || [];

        // Update Cache
        localStorage.setItem(CACHE_KEY, JSON.stringify(messages));

        // Render Real Data
        renderMessages(messages);

    } catch (e) {
        console.error(e);
        if (!pollInterval) showToast("Connection error", "error");
    }
};

const renderMessages = (messages, isCached = false) => {
    el("inboxCount").textContent = messages.length;
    el("emptyInboxState").classList.toggle("hidden", messages.length > 0);

    const list = el("msgList");

    // If we have cached data displayed, and new data is empty, clear it.
    if (messages.length === 0) {
        if (list.innerHTML.includes("skeleton")) list.innerHTML = "";
        // If we had cached messages but now real data is empty, we must clear.
        if (!isCached && list.childElementCount > 0) list.innerHTML = "";
        return;
    }

    // Smart Diffing
    const currentIds = new Set(messages.map(m => m.id));
    const hasContentChanged = messages.length !== lastMessageIds.size ||
        !messages.every(m => lastMessageIds.has(m.id));

    // If skeleton is present, force redraw
    const hasSkeleton = list.querySelector(".skeleton");

    if (hasContentChanged || hasSkeleton) {
        list.innerHTML = "";
        messages.forEach((m, idx) => {
            const isNew = !lastMessageIds.has(m.id) && !isCached;
            const btn = document.createElement("button");
            btn.id = `msg-btn-${m.id}`;
            btn.onclick = () => loadMessage(m.id);

            const baseClass = "w-full text-left p-4 rounded-2xl mb-2 transition-all duration-200 border group will-change-transform";
            const isSelected = selectedMessage && selectedMessage.id === m.id;
            const activeClasses = isSelected
                ? "bg-white/10 border-indigo-500/30"
                : "bg-slate-900/40 border-transparent hover:bg-slate-800/50";

            btn.className = `${baseClass} ${activeClasses}`;

            // Anim: Only fade in if it's not from cache (instant) OR if it's a new item found live
            if (!isCached && (isNew || hasSkeleton)) {
                btn.style.animation = `fadeIn 0.4s ease forwards ${Math.min(idx * 0.05, 0.5)}s`;
                btn.style.opacity = '0';
            }

            btn.innerHTML = `
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                                ${isNew ? `<span class="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></span>` : ""}
                            <h4 class="font-medium text-slate-200 truncate group-hover:text-white transition-colors text-sm">${escapeHtml(m.subject || "(No Subject)")}</h4>
                        </div>
                        <p class="text-xs text-slate-400 mt-1 truncate group-hover:text-slate-300 transition-colors capitalize">${escapeHtml(m.mail_from || "Unknown")}</p>
                    </div>
                    <span class="text-[10px] text-slate-500 whitespace-nowrap font-mono tracking-tight text-right opacity-60">${formatDate(m.received_at).split(",")[1] || ""}</span>
                </div>
            `;
            list.appendChild(btn);
        });

        lastMessageIds = currentIds;
    } else {
        updateSelectionStyle();
    }
};

const updateSelectionStyle = () => {
    if (!selectedMessage) return;
    const allBtns = document.querySelectorAll("#msgList button");
    allBtns.forEach(btn => {
        // Reset to default
        if (btn.id === `msg-btn-${selectedMessage.id}`) {
            btn.className = "w-full text-left p-4 rounded-2xl mb-2 transition-all duration-200 border group bg-white/10 border-indigo-500/30";
        } else {
            btn.className = "w-full text-left p-4 rounded-2xl mb-2 transition-all duration-200 border group bg-slate-900/40 border-transparent hover:bg-slate-800/50";
        }
    });
};

const loadMessage = async (id) => {
    // Smoother visual transition
    const contentDiv = el("messageContent");
    const placeholder = el("messagePlaceholder");

    // Immediate UI feedback
    if (selectedMessage && selectedMessage.id === id) return; // Already loaded

    // Optimistically update selection in list
    selectedMessage = { id }; // partial update for styling
    updateSelectionStyle();

    // Show loading state gracefully
    placeholder.classList.add("hidden");
    contentDiv.classList.remove("hidden");
    // Only reduce opacity slightly to indicate busy, not full flash
    contentDiv.classList.add("opacity-60", "pointer-events-none");

    try {
        const data = await apiGet(`/api/message/${encodeURIComponent(id)}`);
        selectedMessage = data.message;

        // Populate details
        el("messageSubject").textContent = selectedMessage.subject || "(No Subject)";
        el("messageFrom").textContent = selectedMessage.mail_from || "Unknown";
        el("messageTo").textContent = selectedMessage.mail_to || "";
        el("messageTime").textContent = formatDate(selectedMessage.received_at);

        renderBody();

    } catch (e) {
        showToast("Failed to load message", "error");
    } finally {
        contentDiv.classList.remove("opacity-60", "pointer-events-none");
    }
};

const renderBody = () => {
    if (!selectedMessage) return;

    const text = selectedMessage.text || "";
    const html = selectedMessage.html || "";

    const frame = el("messageFrame");
    const bodyText = el("messageBodyText");

    if (activeTab === "text") {
        frame.classList.add("hidden");
        bodyText.classList.remove("hidden");
        bodyText.textContent = text || "No text content.";
    } else {
        if (html) {
            bodyText.classList.add("hidden");
            frame.classList.remove("hidden");
            frame.srcdoc = html;
        } else {
            frame.classList.add("hidden");
            bodyText.classList.remove("hidden");
            bodyText.innerHTML = `<div class="text-center py-10 text-slate-500 italic">No HTML version available.</div>`;
        }
    }
};

const startPolling = () => {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(loadInbox, 7000);
};

const toggleStop = () => {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
        el("btnStopIcon").innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>`;
        showToast("Auto-refresh paused");
    } else {
        startPolling();
        el("btnStopIcon").innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"/>`;
        loadInbox();
        showToast("Auto-refresh started");
    }
};

const escapeHtml = (str) => {
    return String(str).replace(/[&<>"']/g, function (m) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
};

// Event Listeners
el("btnGen").onclick = () => {
    const t = generateToken(8);
    el("tokenInput").value = t;
    el("tokenInput").focus();
    showToast(`Token generated: ${t}`);
};

el("btnUse").onclick = () => activateToken(el("tokenInput").value.trim());

el("tokenInput").onkeydown = (e) => {
    if (e.key === "Enter") activateToken(el("tokenInput").value.trim());
};

el("btnRefresh").onclick = () => {
    const icon = el("refreshIcon");
    icon.classList.add("animate-spin");
    loadInbox().then(() => setTimeout(() => icon.classList.remove("animate-spin"), 500));
};

el("btnCopyEmail").onclick = () => {
    if (activeToken) copyToClipboard(`${activeToken}@${DOMAIN}`);
};

el("btnStop").onclick = toggleStop;

el("btnBack").onclick = () => {
    localStorage.removeItem("tempmail_token");
    activeToken = "";
    el("landingView").classList.remove("hidden");
    el("dashboardView").classList.add("hidden");
    if (pollInterval) clearInterval(pollInterval);
};

// Tabs
el("tabText").onclick = () => {
    activeTab = "text";
    el("tabText").className = "px-4 py-2 rounded-xl bg-indigo-600/80 text-white text-sm font-medium transition-all shadow-lg shadow-indigo-500/20";
    el("tabHtml").className = "px-4 py-2 rounded-xl hover:bg-white/5 text-slate-400 text-sm font-medium transition-all";
    renderBody();
};

el("tabHtml").onclick = () => {
    activeTab = "html";
    el("tabHtml").className = "px-4 py-2 rounded-xl bg-indigo-600/80 text-white text-sm font-medium transition-all shadow-lg shadow-indigo-500/20";
    el("tabText").className = "px-4 py-2 rounded-xl hover:bg-white/5 text-slate-400 text-sm font-medium transition-all";
    renderBody();
};

el("btnCopyOTP").onclick = () => {
    const content = (selectedMessage?.text || "") + " " + (selectedMessage?.html || "");
    const m = content.match(/\b(\d{4,8})\b/);
    if (m) {
        copyToClipboard(m[1]);
        showToast(`OTP Found: ${m[1]}`, "success");
    } else {
        showToast("No OTP pattern found in this email", "error");
    }
};

init();
