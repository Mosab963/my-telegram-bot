const { Telegraf, Markup, Telegram } = require('telegraf');
const fs = require('fs');

const bot = new Telegraf(process.env.BOT_TOKEN);
// Record every outgoing bot message to a customer (not to the admin).
// Telegraf creates a new Telegram instance per update, so the prototype
// must be wrapped, not bot.telegram.
const _origSendMessage = Telegram.prototype.sendMessage;
Telegram.prototype.sendMessage = async function (chatId, text, extra) {
    const sent = await _origSendMessage.call(this, chatId, text, extra);
    try {
        if (sent && sent.message_id && String(chatId) !== ADMIN_ID) trackChatMessage(String(chatId), sent.message_id);
    } catch (e) {}
    return sent;
};
// Record every incoming customer message id (plain messages and the
// message a pressed button sits on).
// Orders waiting for payment proof expire after 24h: they are marked
// expired and the customer is told, so incomplete orders never pile up.
// Checked at most once an hour.
const PROOF_TTL_MS = 24 * 60 * 60 * 1000;
async function expireAwaitingProofOrders(telegram) {
    const cfg = loadConfig();
    const now = Date.now();
    if (cfg.lastProofExpiryCheck && now - cfg.lastProofExpiryCheck < 60 * 60 * 1000) return;
    cfg.lastProofExpiryCheck = now;
    saveJSON(CONFIG_FILE, cfg);
    const data = loadOrders();
    let changed = false;
    for (const o of data.orders) {
        if (o.status === 'awaiting_proof' && now - new Date(o.createdAt || 0).getTime() > PROOF_TTL_MS) {
            o.status = 'expired';
            changed = true;
            try { await sendCustomerView(telegram, o.userId, `🕐 تم إلغاء طلبك: ${o.serviceTitle}\n\nلأنو ما وصلنا إثبات الدفع خلال 24 ساعة. إذا لسه بدك الخدمة، اطلب من جديد.`, homeKeyboard()); } catch (e) {}
        }
    }
    if (changed) saveJSON(ORDERS_FILE, data);
}

bot.use(async (ctx, next) => {
    try { await expireAwaitingProofOrders(ctx.telegram); } catch (e) {}
    try {
        if (ctx.from && !isAdmin(ctx)) {
            const m = ctx.message || (ctx.callbackQuery && ctx.callbackQuery.message);
            if (m && m.message_id) trackChatMessage(String(ctx.from.id), m.message_id);
            // Record the user; notify the admin once, on their very first
            // interaction (not for customers already known from orders).
            const uid = String(ctx.from.id);
            const udata = loadUsers();
            if (!udata.users[uid]) {
                const knownFromOrders = loadOrders().orders.some((o) => o.userId === uid);
                const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'بدون اسم';
                udata.users[uid] = { userId: uid, name, username: ctx.from.username || '', firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString() };
                saveUsers(udata);
                if (ADMIN_ID && !knownFromOrders) {
                    try {
                        await ctx.telegram.sendMessage(ADMIN_ID, `🆕 <b>مستخدم جديد</b>\n\n${customerLine({ name, username: ctx.from.username || '', userId: uid })}\nالوقت: ${new Date().toLocaleString('ar-SY')}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.url('فتح محادثة المستخدم', `tg://user?id=${uid}`)]]) });
                    } catch (e) {}
                }
            } else {
                udata.users[uid].lastSeen = new Date().toISOString();
                if (ctx.from.username) udata.users[uid].username = ctx.from.username;
                saveUsers(udata);
            }
        }
    } catch (e) {}
    return next();
});
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID).trim() : null;

const os = require('os');
const path = require('path');
// Vercel serverless filesystem is read-only except /tmp, so runtime files
// MUST live in /tmp. Writing ./orders.json failed silently on every
// request, which is why orders never survived to the next message and KV
// was overwritten with empty orders every time.
const DATA_DIR = os.tmpdir();
const CODES_FILE = path.join(DATA_DIR, 'store-codes.json');
const CHATS_FILE = path.join(DATA_DIR, 'store-chats.json');
const USERS_FILE = path.join(DATA_DIR, 'store-users.json');
const DISCOUNTS_FILE = path.join(DATA_DIR, 'store-discounts.json');
const VIEWS_FILE = path.join(DATA_DIR, 'store-views.json');
const SECTIONS_FILE = path.join(DATA_DIR, 'store-services.json');
const ORDERS_FILE = path.join(DATA_DIR, 'store-orders.json');
const CONFIG_FILE = path.join(DATA_DIR, 'store-config.json');

function loadJSON(file, fallback) {
    try {
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
            return fallback;
        }
        return JSON.parse(fs.readFileSync(file));
    } catch (e) {
        return fallback;
    }
}
function saveJSON(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) {}
}

const DEFAULT_SECTIONS = [{ id: 'sec_offer1', title: 'عرض 1', text: '1 مليار', price: '1$ أو 150 ليرة سورية', category: 'عام' }];
const DEFAULT_CONFIG = { paymentInfo: '💳 طرق الدفع:\n\n💵 شام كاش:\n`40ba4e3f2a3dc2a1759dbd26d21037c6`\n\n🟡 بينانس:\n`481984372`\n\nاضغط على الكود لنسخه، وبعد ما تدفع، كبس زر تأكيد الدفع تحت.' };

function loadCodes() { return loadJSON(CODES_FILE, { codes: [] }); }
function loadSections() {
    const data = loadJSON(SECTIONS_FILE, { sections: DEFAULT_SECTIONS });
    const seen = new Set();
    const clean = [];
    for (const s of (data.sections || [])) {
        const key = String(s.title || '').trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        clean.push(s);
    }
    if (clean.length !== (data.sections || []).length) {
        data.sections = clean;
        try { saveJSON(SECTIONS_FILE, data); } catch (e) {}
    }
    return data;
}
function addOrUpdateService(title, price, text) {
    const data = loadSections();
    const key = String(title || '').trim().toLowerCase();
    const existing = data.sections.find((s) => String(s.title || '').trim().toLowerCase() === key);
    if (existing) {
        existing.price = price || existing.price;
        existing.text = text || existing.text;
        saveJSON(SECTIONS_FILE, data);
        return { updated: true, service: existing };
    }
    const service = { id: 'sec_' + Date.now(), title, price, text, category: 'عام' };
    data.sections.push(service);
    saveJSON(SECTIONS_FILE, data);
    return { updated: false, service };
}
function loadOrders() { return loadJSON(ORDERS_FILE, { orders: [] }); }
function loadChats() { return loadJSON(CHATS_FILE, { chats: {} }); }
function loadUsers() { return loadJSON(USERS_FILE, { users: {} }); }
function loadDiscounts() { return loadJSON(DISCOUNTS_FILE, { codes: [] }); }
function loadViews() { return loadJSON(VIEWS_FILE, { views: {} }); }
function saveViews(data) { saveJSON(VIEWS_FILE, data); }
// The view is stored as { id, screen }: the message id plus which screen it
// shows ('home', 'cat:<name>', or null for any other screen). The screen is
// what lets the store refresh itself live when the admin changes services.
function getCustomerView(userId) {
    const v = (loadViews().views || {})[String(userId)];
    return (v && typeof v === 'object') ? (v.id || null) : (v || null);
}
function getCustomerViewScreen(userId) {
    const v = (loadViews().views || {})[String(userId)];
    return (v && typeof v === 'object') ? (v.screen || null) : null;
}
function setCustomerView(userId, messageId, screen) {
    const d = loadViews();
    if (messageId) d.views[String(userId)] = { id: messageId, screen: screen || null };
    else delete d.views[String(userId)];
    saveViews(d);
}
async function deleteMsg(telegram, chatId, messageId) {
    if (!messageId) return;
    try { await telegram.deleteMessage(chatId, messageId); } catch (e) {}
    // Keep the clear-chat list honest: a message already deleted here must
    // not be counted as a failure when the admin clears the chat later.
    try {
        const chats = loadChats();
        const list = chats.chats[String(chatId)] || [];
        const i = list.indexOf(messageId);
        if (i >= 0) { list.splice(i, 1); saveChats(chats); }
    } catch (e) {}
}
// Show a customer step as the single message on screen: edit the current
// view in place when the tapped button sits on it, otherwise delete the old
// view and the stale message and send a fresh one. Mirrors the admin side.
async function showCustomer(ctx, text, keyboard, screen) {
    const userId = String(ctx.from.id);
    const cbMsg = ctx.callbackQuery && ctx.callbackQuery.message;
    const viewId = getCustomerView(userId);
    if (cbMsg && viewId && cbMsg.message_id === viewId) {
        try {
            await ctx.editMessageText(text, { parse_mode: 'Markdown', ...(keyboard || {}) });
            setCustomerView(userId, viewId, screen || null);
            return true;
        }
        catch (e) { if (String(e && e.message || '').includes('message is not modified')) { setCustomerView(userId, viewId, screen || null); return true; } }
    }
    if (viewId && (!cbMsg || cbMsg.message_id !== viewId)) await deleteMsg(ctx.telegram, userId, viewId);
    if (cbMsg && cbMsg.message_id !== viewId) await deleteMsg(ctx.telegram, userId, cbMsg.message_id);
    try {
        const sent = await ctx.reply(text, { parse_mode: 'Markdown', ...(keyboard || {}) });
        if (sent && sent.message_id) setCustomerView(userId, sent.message_id, screen || null);
        return true;
    } catch (e) {
        try { const sent = await ctx.reply(text.replace(/[*_`]/g, ''), { ...(keyboard || {}) }); if (sent && sent.message_id) setCustomerView(userId, sent.message_id, screen || null); return true; } catch (_) { return false; }
    }
}
// Reply to a plain customer message as the single view (prompts, confirmations).
async function replyCustomer(ctx, text, extra, parseMode, screen) {
    const userId = String(ctx.from.id);
    const viewId = getCustomerView(userId);
    if (viewId) await deleteMsg(ctx.telegram, userId, viewId);
    try {
        const sent = await ctx.reply(text, { parse_mode: parseMode || 'Markdown', ...(extra || {}) });
        if (sent && sent.message_id) setCustomerView(userId, sent.message_id, screen || null);
        return sent;
    } catch (e) {
        try { const sent = await ctx.reply(text.replace(/[*_`]/g, ''), { ...(extra || {}) }); if (sent && sent.message_id) setCustomerView(userId, sent.message_id, screen || null); return sent; } catch (_) { return null; }
    }
}
// Send a proactive bot message to a customer as their single view.
async function sendCustomerView(telegram, userId, text, extra, parseMode, screen) {
    const viewId = getCustomerView(userId);
    if (viewId) await deleteMsg(telegram, userId, viewId);
    try {
        const sent = await telegram.sendMessage(userId, text, { parse_mode: parseMode || 'Markdown', ...(extra || {}) });
        if (sent && sent.message_id) setCustomerView(userId, sent.message_id, screen || null);
        return sent;
    } catch (e) { return null; }
}
// Refresh the store live for every customer who is currently looking at the
// home screen or a category list, so a new service appears without them
// pressing /start. Users in the middle of an order or a payment are never
// touched: their view keeps its own screen.
async function refreshStoreViews(telegram) {
    const d = loadViews();
    for (const [userId, v] of Object.entries(d.views || {})) {
        const view = (v && typeof v === 'object') ? v : { id: v, screen: null };
        if (!view.id) continue;
        try {
            if (view.screen === 'home') {
                await telegram.editMessageText(userId, view.id, undefined, homeText(), { parse_mode: 'Markdown', ...homeKeyboard() });
            } else if (typeof view.screen === 'string' && view.screen.startsWith('cat:')) {
                const cat = view.screen.slice(4);
                const { sections } = loadSections();
                const list = sections.filter((s) => ((s.category || 'عام').trim() || 'عام') === cat);
                if (!list.length) await telegram.editMessageText(userId, view.id, undefined, 'ما في خدمات بهالتصنيف بعد.', { parse_mode: 'Markdown', ...homeKeyboard() });
                else await telegram.editMessageText(userId, view.id, undefined, `🗂️ **${cat}**\n\nاختار الخدمة:`, { parse_mode: 'Markdown', ...categoryKeyboard(cat) });
            }
        } catch (e) {}
    }
}
function saveDiscounts(data) { saveJSON(DISCOUNTS_FILE, data); }
// Apply a percentage discount to every number in a free-text price,
// e.g. "1$ أو 150 ليرة سورية" at 10% -> "0.9$ أو 135 ليرة سورية".
function applyDiscount(priceStr, percent) {
    return String(priceStr || '').replace(/\d+(?:[.,]\d+)?/g, (m) => {
        const v = parseFloat(m.replace(',', '.')) * (1 - percent / 100);
        const r = Math.round(v * 100) / 100;
        return String(r).replace(/\.0$/, '').replace(/(\.\d)0$/, '$1');
    });
}
// Payment methods: each has its own payment info, so the order records
// exactly how the customer paid and the admin can track the transfer.
const DEFAULT_PAYMENT = {
    sham: '💵 Sham Cash: `40ba4e3f2a3dc2a1759dbd26d21037c6`',
    binance: '🟡 Binance UID: `481984372`'
};
function paymentMethodInfo(method) {
    const cfg = loadConfig();
    if (method === 'sham') return cfg.paymentSham || DEFAULT_PAYMENT.sham;
    return cfg.paymentBinance || DEFAULT_PAYMENT.binance;
}
// Tap-to-copy: inline `code` does not copy on every Telegram client, so the
// payment code is rendered as a code BLOCK instead - every client copies a
// block on tap (mobile) or shows a copy button on it (desktop). The admin may
// save the code with or without backticks; the block is built either way.
function paymentInfoForMethod(method) {
    const info = paymentMethodInfo(method);
    if (info.includes('`')) return info.replace(/`([^`]+)`/g, '```\n$1\n```');
    return info.replace(/(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,}/, '```\n$&\n```');
}
function paymentInfoHtml(method) {
    const info = paymentMethodInfo(method).replace(/`/g, '');
    return escapeHtml(info).replace(/(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,}/, '<pre>$&</pre>');
}
// The raw payment code (no formatting), for the real copy button.
function paymentCode(method) {
    const info = paymentMethodInfo(method).replace(/`/g, '');
    const m = info.match(/(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,}/);
    return m ? m[0] : info.trim();
}
// A real copy button: Telegram's copy_text button copies the text to the
// clipboard when pressed. Telegraf has no helper for it, so the raw button
// object is used.
function copyCodeButton(label, code) {
    return { text: label, copy_text: { text: code } };
}
function paymentMethodLabel(method) {
    return method === 'sham' ? '💵 شام كاش' : method === 'binance' ? '🟡 بينانس' : 'غير محددة';
}
function parsePayCallback(s) {
    // pay:<id> | pay:<id>:<CODE> | pay:<id>:<CODE>:<method> | pay:<id>::<method>
    const parts = String(s || '').split(':');
    const id = parts[0] || '';
    let code = '', method = '';
    if (parts.length === 2) {
        if (parts[1] === 'sham' || parts[1] === 'binance') method = parts[1];
        else code = parts[1];
    } else if (parts.length >= 3) {
        code = parts[1] || '';
        method = parts[2] || '';
    }
    return { id, code, method };
}

function findDiscount(code) {
    if (!code) return null;
    return loadDiscounts().codes.find((c) => String(c.code).toUpperCase() === String(code).toUpperCase().trim()) || null;
}
// A code is global when its serviceIds list is empty; otherwise it only
// applies to the listed services.
function discountApplies(disc, serviceId) {
    if (!disc) return false;
    if (!disc.serviceIds || !disc.serviceIds.length) return true;
    return disc.serviceIds.includes(serviceId);
}
function discountScopeText(disc) {
    if (!disc.serviceIds || !disc.serviceIds.length) return 'عام (كل الخدمات)';
    const { sections } = loadSections();
    const names = disc.serviceIds.map((id) => { const s = sections.find((x) => x.id === id); return s ? s.title : id; });
    return 'خاص بـ: ' + names.join('، ');
}
// Average rating of a service from its rated orders.
function serviceRating(serviceId) {
    const rated = loadOrders().orders.filter((o) => o.serviceId === serviceId && typeof o.rating === 'number');
    if (!rated.length) return null;
    const avg = rated.reduce((s, o) => s + o.rating, 0) / rated.length;
    return { avg: Math.round(avg * 10) / 10, count: rated.length };
}
function getCategories() {
    const cats = [];
    for (const s of loadSections().sections) {
        const c = (s.category || 'عام').trim() || 'عام';
        if (!cats.includes(c)) cats.push(c);
    }
    return cats.length ? cats : ['عام'];
}
function saveUsers(data) { saveJSON(USERS_FILE, data); }
// All users, merged with customers known from orders (so customers from
// before this feature still appear in the users section).
function getAllUsers() {
    const data = loadUsers();
    const users = { ...(data.users || {}) };
    for (const o of loadOrders().orders) {
        if (!o.userId) continue;
        if (!users[o.userId]) {
            users[o.userId] = { userId: o.userId, name: o.name || 'بدون اسم', username: o.username || '', firstSeen: o.createdAt || new Date().toISOString(), lastSeen: o.createdAt || new Date().toISOString() };
        }
    }
    return users;
}
function countUserOrders(userId) {
    return loadOrders().orders.filter((o) => o.userId === String(userId)).length;
}
function saveChats(data) { saveJSON(CHATS_FILE, data); }
// Track every message id in a customer's chat with the bot (bot messages
// and the customer's own messages), so the admin can later wipe the
// customer's chat clean. Kept to the last 200 ids per customer.
function trackChatMessage(userId, messageId) {
    if (!userId || !messageId) return;
    const data = loadChats();
    const list = data.chats[userId] || [];
    if (!list.includes(messageId)) list.push(messageId);
    data.chats[userId] = list.slice(-200);
    saveChats(data);
}
function loadConfig() { return loadJSON(CONFIG_FILE, DEFAULT_CONFIG); }

async function backupToAdmin(ctx) {
    if (!ADMIN_ID) return;
    try {
        await ctx.telegram.sendDocument(ADMIN_ID, { source: Buffer.from(JSON.stringify(loadSections(), null, 2)), filename: 'services-backup.json' }, { caption: 'نسخة احتياطية من الخدمات - احتفظ فيها' });
        await ctx.telegram.sendDocument(ADMIN_ID, { source: Buffer.from(JSON.stringify(loadOrders(), null, 2)), filename: 'orders-backup.json' }, { caption: 'نسخة احتياطية من الطلبات - احتفظ فيها' });
        await ctx.telegram.sendDocument(ADMIN_ID, { source: Buffer.from(JSON.stringify(loadConfig(), null, 2)), filename: 'config-backup.json' }, { caption: 'نسخة احتياطية من إعدادات الدفع - احتفظ فيها' });
    } catch (e) { console.error('Backup failed:', e.message); }
}

// ---- Persistent storage: Vercel KV (Upstash Redis, REST) ----
// The bot runs on Vercel serverless, whose filesystem is wiped on every
// redeploy, so services/orders were lost on every code update. Vercel KV
// survives redeploys. When KV_REST_API_URL + KV_REST_API_TOKEN are set
// (Vercel dashboard > Storage > create a KV database, linked to this
// project), the whole state is synced to KV on every webhook request:
// load from KV at the start, save to KV at the end. Without KV, the bot
// falls back to the local files (committed defaults survive, new runtime
// additions do not survive a redeploy).
const KV_URL = (process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const KV_KEY = 'store_bot_state_v1';
async function kvGet() {
    if (!KV_URL || !KV_TOKEN) return undefined; // no KV configured
    try {
        const r = await fetch(KV_URL + '/get/' + KV_KEY, { headers: { Authorization: 'Bearer ' + KV_TOKEN } });
        if (!r.ok) { console.error('KV get failed, status', r.status); return undefined; }
        const j = await r.json();
        return j && j.result ? JSON.parse(j.result) : null; // null = key missing
    } catch (e) { console.error('KV get error', e && e.message); return undefined; }
}
async function kvSet(state) {
    if (!KV_URL || !KV_TOKEN) return false;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(KV_URL + '/set/' + KV_KEY + '/' + encodeURIComponent(JSON.stringify(state)), {
            method: 'POST', headers: { Authorization: 'Bearer ' + KV_TOKEN }, signal: ctrl.signal
        });
        clearTimeout(timer);
        if (!r.ok) console.error('KV set failed, status', r.status);
        return r.ok;
    } catch (e) { console.error('KV set error', e && e.message); return false; }
}
function readLocalState() {
    return { sections: loadSections(), orders: loadOrders(), config: loadConfig(), chats: loadChats(), users: loadUsers(), discounts: loadDiscounts(), views: loadViews() };
}
function writeLocalState(state) {
    if (state.sections) saveJSON(SECTIONS_FILE, state.sections);
    if (state.orders) saveJSON(ORDERS_FILE, state.orders);
    if (state.config) saveJSON(CONFIG_FILE, state.config);
    if (state.chats) saveJSON(CHATS_FILE, state.chats);
    if (state.users) saveJSON(USERS_FILE, state.users);
    if (state.discounts) saveJSON(DISCOUNTS_FILE, state.discounts);
    if (state.views) saveJSON(VIEWS_FILE, state.views);
}
async function syncFromKV() {
    if (!KV_URL || !KV_TOKEN) return;
    const state = await kvGet();
    if (state === undefined) return; // KV unreachable: do NOT overwrite it
    if (state && (state.sections || state.orders || state.config)) {
        writeLocalState(state);
    } else if (state === null) {
        // Key genuinely missing: seed it from the local defaults.
        await kvSet(readLocalState());
    }
}
async function syncToKV() {
    if (!KV_URL || !KV_TOKEN) return;
    await kvSet(readLocalState());
}


function cleanMd(s) { return String(s || '').replace(/[*`\[\]]/g, ''); }
function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function customerLine(o) {
    const name = escapeHtml(o.name || 'بدون اسم');
    const user = o.username ? '@' + escapeHtml(o.username) : 'بدون معرف';
    return `الزبون: <a href="tg://user?id=${o.userId}">${name}</a> (<code>${user}</code>)\nآيدي الزبون: <code>${o.userId}</code>`;
}

// Admin view: every click moves to the next step and hides the previous
// one. The clicked message (and any stored view message) is deleted, and
// the next step is sent as a fresh message, so only one admin message is
// ever on screen.
async function showAdminView(ctx, text, keyboard) {
    const cfg = loadConfig();
    const cur = ctx.callbackQuery && ctx.callbackQuery.message ? ctx.callbackQuery.message.message_id : null;
    const ids = new Set([cfg.adminViewMessageId, cur].filter(Boolean));
    for (const id of ids) {
        try { await ctx.telegram.deleteMessage(ADMIN_ID, id); } catch (e) {}
    }
    try {
        const sent = await ctx.telegram.sendMessage(ADMIN_ID, text, { parse_mode: 'HTML', ...(keyboard || {}) });
        cfg.adminViewMessageId = sent.message_id;
        saveJSON(CONFIG_FILE, cfg);
        return true;
    } catch (e) {
        // Fallback: edit the clicked message in place, plain text.
        try { await ctx.editMessageText(text.replace(/<[^>]+>/g, ''), { ...(keyboard || {}) }); return true; } catch (_) { return false; }
    }
}
function orderActionKeyboard(o) {
    const rows = [];
    if (o.status === 'pending') {
        rows.push([Markup.button.callback('✅ تأكيد الدفع واستلام الطلب', `approve:${o.id}`)]);
        rows.push([Markup.button.callback('❌ رفض الطلب', `reject:${o.id}`)]);
    }
    rows.push([Markup.button.callback('💬 مراسلة الزبون', `msg:${o.id}`)]);
    rows.push([Markup.button.url('فتح محادثة الزبون', `tg://user?id=${o.userId}`)]);
    rows.push([Markup.button.callback('🗑️ مسح محادثة الزبون', `clear:${o.id}:notif`)]);
    return Markup.inlineKeyboard(rows);
}
function orderDetailKeyboard(o, from) {
    const rows = [];
    if (o.status === 'pending') {
        rows.push([Markup.button.callback('✅ تأكيد الدفع واستلام الطلب', `approve:${o.id}`)]);
        rows.push([Markup.button.callback('❌ رفض الطلب', `reject:${o.id}`)]);
    }
    rows.push([Markup.button.callback('💬 مراسلة الزبون', `msg:${o.id}`)]);
    rows.push([Markup.button.url('فتح محادثة الزبون', `tg://user?id=${o.userId}`)]);
    if (o.proofPhoto) rows.push([Markup.button.callback('🖼️ عرض إثبات الدفع', `proof:${o.id}`)]);
    rows.push([Markup.button.callback('🗑️ مسح محادثة الزبون', `clear:${o.id}:${from}`)]);
    rows.push([Markup.button.callback('🔙 رجوع للطلبات', from === 'archive' ? 'admin:archive' : 'admin:orders')]);
    rows.push([Markup.button.callback('🏠 لوحة التحكم', 'admin:home')]);
    return Markup.inlineKeyboard(rows);
}
function orderDetailText(o) {
    const status = o.status === 'confirmed' ? '✅ مؤكد' : o.status === 'rejected' ? '❌ مرفوض' : o.status === 'awaiting_proof' ? '⏳ بانتظار إثبات الدفع' : o.status === 'expired' ? '🕐 ملغي (ما وصل إثبات دفع)' : '⏳ بانتظار التأكد من الدفع';
    const tx = o.txNumber ? `\nرقم المعاملة: <code>${escapeHtml(o.txNumber)}</code>` : '\nرقم المعاملة: لم يرسل بعد';
    const disc = o.discountCode ? `\n🎟️ كود خصم: <code>${escapeHtml(o.discountCode)}</code> (خصم ${o.discountPercent}%) - السعر قبل الخصم: ${escapeHtml(o.priceBefore || '')}` : '';
    const methodLine = o.paymentMethod ? `\n💳 طريقة الدفع: ${paymentMethodLabel(o.paymentMethod)}` : '';
    const proof = o.proofPhoto ? '\n🖼️ إثبات الدفع: صورة مرفقة' : '';
    const rating = typeof o.rating === 'number' ? `\n⭐ التقييم: ${'⭐'.repeat(o.rating)} (${o.rating}/5)` : '';
    const time = o.createdAt ? `\nالوقت: ${new Date(o.createdAt).toLocaleString('ar-SY')}` : '';
    return `🧾 <b>تفاصيل الطلب</b>\n\nرقم الطلب: <code>${o.id}</code>\nالخدمة: ${escapeHtml(o.serviceTitle)}\nالسعر: ${escapeHtml(o.price || '-')}${disc}${methodLine}${tx}${proof}${rating}\n${customerLine(o)}${time}\nالحالة: ${status}`;
}

function orderNotifyText(o, extra) {
    const tx = o.txNumber ? `\nرقم المعاملة: <code>${escapeHtml(o.txNumber)}</code>` : '';
    const disc = o.discountCode ? `\n🎟️ كود خصم: <code>${escapeHtml(o.discountCode)}</code> (خصم ${o.discountPercent}%)` : '';
    const methodLine = o.paymentMethod ? `\n💳 طريقة الدفع: ${paymentMethodLabel(o.paymentMethod)}` : '';
    const time = o.createdAt ? `\nالوقت: ${new Date(o.createdAt).toLocaleString('ar-SY')}` : '';
    return `🧾 <b>طلب جديد قيد التنفيذ</b>\n\nرقم الطلب: <code>${o.id}</code>\nالخدمة: ${escapeHtml(o.serviceTitle)}\nالسعر: ${escapeHtml(o.price || '-')}${disc}${methodLine}${tx}\n${customerLine(o)}${time}\nالحالة: بانتظار التأكد من الدفع${extra || ''}`;
}

function isAdmin(ctx) { return ADMIN_ID && String(ctx.from.id) === ADMIN_ID; }

async function safeEditHtml(ctx, text, extra) {
    const opts = { parse_mode: 'HTML', ...(extra || {}) };
    try {
        await ctx.editMessageText(text, opts);
        return true;
    } catch (e) {
        const msg = String(e && e.message || '');
        if (msg.includes('message is not modified')) return true;
        try { await ctx.reply(text.replace(/<[^>]+>/g, ''), { ...(extra || {}) }); } catch (_) {}
        return false;
    }
}
async function safeEdit(ctx, text, extra) {
    const opts = { parse_mode: 'Markdown', ...(extra || {}) };
    try {
        await ctx.editMessageText(text, opts);
        return true;
    } catch (e) {
        const msg = String(e && e.message || '');
        if (msg.includes('message is not modified')) return true;
        try { await ctx.reply(text, opts); } catch (_) {}
        // Last resort: plain text with no parse_mode, so a Markdown parse
        // error (e.g. a bare underscore in an id) can never leave the user
        // stuck with only a toast and no message.
        try { await ctx.reply(text.replace(/[*_`]/g, ''), { ...(extra || {}) }); } catch (_) {}
        return false;
    }
}
async function safeAnswer(ctx, text) {
    try { await ctx.answerCbQuery(text || ''); } catch (_) {}
}

function homeKeyboard() {
    const { sections } = loadSections();
    const cats = getCategories();
    const rows = [];
    if (cats.length > 1) {
        for (const c of cats) rows.push([Markup.button.callback('🗂️ ' + c, `cat:${c}`)]);
    } else {
        for (const s of sections) rows.push([Markup.button.callback(s.title, `section:${s.id}`)]);
    }
    rows.push([Markup.button.callback('📦 طلباتي', 'myorders')]);
    if (ADMIN_ID) rows.push([Markup.button.url('💬 تواصل مع الدعم', `tg://user?id=${ADMIN_ID}`)]);
    return Markup.inlineKeyboard(rows);
}
function categoryKeyboard(cat) {
    const { sections } = loadSections();
    const rows = sections.filter((s) => ((s.category || 'عام').trim() || 'عام') === cat).map((s) => [Markup.button.callback(s.title, `section:${s.id}`)]);
    rows.push([Markup.button.callback('🔙 رجوع', 'home')]);
    return Markup.inlineKeyboard(rows);
}
function homeText() {
    const cfg = loadConfig();
    if (cfg.welcomeText) return cfg.welcomeText;
    const { sections } = loadSections();
    if (!sections.length) return '🛍️ **أهلاً فيك بمتجرنا!**\n\nلسه ما في خدمات معروضة حالياً، تابعنا قريباً.';
    return '🛍️ **أهلاً فيك بمتجرنا!**\n\nتصفح الأقسام من الأزرار تحت، واختار اللي بيناسبك.';
}

bot.catch((err) => console.error('Bot error:', err));

bot.start(async (ctx) => { await replyCustomer(ctx, homeText(), homeKeyboard(), 'Markdown', 'home'); });
bot.command('store', async (ctx) => { await replyCustomer(ctx, homeText(), homeKeyboard(), 'Markdown', 'home'); });
bot.command('resetorders', (ctx) => {
    if (!isAdmin(ctx)) return;
    saveJSON(ORDERS_FILE, { orders: [] });
    return ctx.reply('تم تصفير الطلبات، البوت صار نظيف، ما في طلبات معلقة.', { parse_mode: 'Markdown', ...adminKeyboard() });
});
bot.command('cancel', async (ctx) => {
    if (isAdmin(ctx)) return ctx.reply('تم الإلغاء، رجعت للوحة التحكم.', { parse_mode: 'Markdown', ...adminKeyboard() });
    await replyCustomer(ctx, 'تم الإلغاء، رجعت للقائمة الرئيسية.', homeKeyboard(), 'Markdown', 'home');
});
bot.action('cancel', async (ctx) => {
    await safeAnswer(ctx, 'تم الإلغاء');
    if (isAdmin(ctx)) return showAdminView(ctx, adminText(), adminKeyboard());
    return showCustomer(ctx, homeText(), homeKeyboard(), 'home');
});
function adminPromptKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('❌ إلغاء', 'cancel')],
        [Markup.button.callback('🏠 الرئيسية', 'home')]
    ]);
}
function cancelKeyboard() {
    return Markup.inlineKeyboard([[Markup.button.callback('❌ إلغاء', 'cancel')]]);
}

// Single-message admin commands - no multi-step state, so Vercel cold starts cannot lose the step.
// Format: /addservice الاسم | السعر | الوصف
bot.command('addservice', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    const args = ctx.message.text.replace(/^\/addservice\s*/, '').trim();
    const parts = args.split('|').map((s) => s.trim());
    if (parts.length < 3 || !parts[0] || !parts[1]) {
        return ctx.reply('الصيغة الصحيحة:\n`/addservice عرض 1 | 1$ | 5 صفحات إكسل`', { parse_mode: 'Markdown' });
    }
    const res = addOrUpdateService(parts[0], parts[1], parts.slice(2).join(' | '));
    await refreshStoreViews(ctx.telegram);
    if (res.updated) return ctx.reply(`الخدمة "${parts[0]}" موجودة مسبقاً، حدثتها بدل ما تتكرر.`, { parse_mode: 'Markdown', ...adminKeyboard() });
    return ctx.reply(`تمت إضافة الخدمة "${parts[0]}" بسعر ${parts[1]} بنجاح.`, { parse_mode: 'Markdown', ...adminKeyboard() });
});
bot.command('delservice', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    const n = parseInt(ctx.message.text.replace(/^\/delservice\s*/, '').trim(), 10) - 1;
    const data = loadSections();
    if (isNaN(n) || !data.sections[n]) return ctx.reply('الصيغة: /delservice 1');
    const removed = data.sections.splice(n, 1)[0];
    saveJSON(SECTIONS_FILE, data);
    await refreshStoreViews(ctx.telegram);
    return ctx.reply(`تم حذف الخدمة "${removed.title}".`, { parse_mode: 'Markdown', ...adminKeyboard() });
});
bot.command('rename', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    const args = ctx.message.text.replace(/^\/rename\s*/, '').trim();
    const parts = args.split('|').map((s) => s.trim());
    const n = parseInt(parts[0], 10) - 1;
    const data = loadSections();
    if (isNaN(n) || !data.sections[n] || !parts[1]) return ctx.reply('الصيغة: /rename 1 | الاسم الجديد');
    if (data.sections.some((s, i) => i !== n && s.title === parts[1])) return ctx.reply('في خدمة تانية بنفس الاسم، اختار اسم تاني.');
    const oldTitle = data.sections[n].title;
    data.sections[n].title = parts.slice(1).join(' | ');
    saveJSON(SECTIONS_FILE, data);
    await refreshStoreViews(ctx.telegram);
    return ctx.reply(`تم تغيير اسم الخدمة من "${oldTitle}" إلى "${data.sections[n].title}".`, { parse_mode: 'Markdown', ...adminKeyboard() });
});
bot.command('setcat', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    const args = ctx.message.text.replace(/^\/setcat\s*/, '').trim();
    const parts = args.split('|').map((s) => s.trim());
    const n = parseInt(parts[0], 10) - 1;
    const data = loadSections();
    if (isNaN(n) || !data.sections[n] || !parts[1]) return ctx.reply('الصيغة: /setcat 1 | حسابات');
    data.sections[n].category = parts[1];
    saveJSON(SECTIONS_FILE, data);
    await refreshStoreViews(ctx.telegram);
    return ctx.reply(`تم تصنيف الخدمة "${data.sections[n].title}" تحت "${parts[1]}".`, { parse_mode: 'Markdown', ...adminKeyboard() });
});
bot.command('setprice', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    const args = ctx.message.text.replace(/^\/setprice\s*/, '').trim();
    const parts = args.split('|').map((s) => s.trim());
    const n = parseInt(parts[0], 10) - 1;
    const data = loadSections();
    if (isNaN(n) || !data.sections[n] || !parts[1]) return ctx.reply('الصيغة: /setprice 1 | 2$');
    data.sections[n].price = parts[1];
    saveJSON(SECTIONS_FILE, data);
    await refreshStoreViews(ctx.telegram);
    return ctx.reply('تم تعديل السعر.', { parse_mode: 'Markdown', ...adminKeyboard() });
});
bot.command('edittext', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    const args = ctx.message.text.replace(/^\/edittext\s*/, '').trim();
    const parts = args.split('|').map((s) => s.trim());
    const n = parseInt(parts[0], 10) - 1;
    const data = loadSections();
    if (isNaN(n) || !data.sections[n] || !parts[1]) return ctx.reply('الصيغة: /edittext 1 | النص الجديد');
    data.sections[n].text = parts.slice(1).join(' | ');
    saveJSON(SECTIONS_FILE, data);
    await refreshStoreViews(ctx.telegram);
    return ctx.reply('تم تعديل النص.', { parse_mode: 'Markdown', ...adminKeyboard() });
});
bot.command('setpayment', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    const args = ctx.message.text.replace(/^\/setpayment\s*/, '').trim();
    const parts = args.split('|').map((s) => s.trim());
    const method = (parts[0] || '').toLowerCase();
    if ((method !== 'sham' && method !== 'binance') || !parts[1]) return ctx.reply('الصيغة: /setpayment sham | معلومات الدفع الجديدة\nأو: /setpayment binance | معلومات الدفع الجديدة');
    const cfg = loadConfig();
    if (method === 'sham') cfg.paymentSham = parts.slice(1).join(' | ');
    else cfg.paymentBinance = parts.slice(1).join(' | ');
    saveJSON(CONFIG_FILE, cfg);
    return ctx.reply('تم تعديل معلومات الدفع.', { parse_mode: 'Markdown', ...adminKeyboard() });
});


bot.command('myorders', (ctx) => {
    const { orders } = loadOrders();
    const mine = orders.filter((o) => o.userId === String(ctx.from.id));
    if (!mine.length) return replyCustomer(ctx, 'لسه ما عندك طلبات.', homeKeyboard());
    const list = mine.slice(-10).map((o) => `• ${o.serviceTitle} - ${o.price || ''} - ${o.status === 'awaiting_proof' ? 'بانتظار إثبات الدفع، أرسل رقم المعاملة أو صورة الإيصال' : o.status === 'expired' ? 'ملغي (ما وصل إثبات دفع)' : o.status === 'awaiting_proof' ? 'بانتظار إثبات الدفع، أرسل رقم المعاملة أو صورة الإيصال' : o.status === 'expired' ? 'ملغي (ما وصل إثبات دفع)' : o.status === 'pending' ? 'قيد التنفيذ، بانتظار التأكد من الدفع' : o.status === 'confirmed' ? 'تم تأكيد الدفع' : 'مرفوض'}`).join('\n');
    return replyCustomer(ctx, '📦 **طلباتي:**\n\n' + list, homeKeyboard());
});

bot.action('myorders', async (ctx) => {
    await safeAnswer(ctx);
    const { orders } = loadOrders();
    const mine = orders.filter((o) => o.userId === String(ctx.from.id));
    if (!mine.length) return showCustomer(ctx, '📦 **طلباتي**\n\nلسه ما عندك طلبات.', homeKeyboard());
    const list = mine.slice(-10).map((o) => `• ${o.serviceTitle} - ${o.price || ''} - ${o.txNumber ? 'معاملة: `' + o.txNumber + '` - ' : ''}${o.status === 'pending' ? 'قيد التنفيذ، بانتظار التأكد من الدفع' : o.status === 'confirmed' ? 'تم تأكيد الدفع' : 'مرفوض'}`).join('\n');
    await safeAnswer(ctx, `عندك ${mine.length} طلبات`);
    return showCustomer(ctx, '📦 **طلباتي:**\n\n' + list, homeKeyboard());
});

bot.action('home', async (ctx) => {
    await safeAnswer(ctx);
    return showCustomer(ctx, homeText(), homeKeyboard(), 'home');
});

bot.action(/^cat:(.+)$/, async (ctx) => {
    const cat = ctx.match[1];
    await safeAnswer(ctx);
    const { sections } = loadSections();
    const list = sections.filter((s) => ((s.category || 'عام').trim() || 'عام') === cat);
    if (!list.length) return showCustomer(ctx, 'ما في خدمات بهالتصنيف بعد.', homeKeyboard(), 'home');
    return showCustomer(ctx, `🗂️ **${cat}**\n\nاختار الخدمة:`, categoryKeyboard(cat), 'cat:' + cat);
});

bot.action(/^section:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const { sections } = loadSections();
    const sec = sections.find((s) => s.id === id);
    await safeAnswer(ctx);
    if (!sec) return showCustomer(ctx, 'هاد القسم مو موجود.', homeKeyboard(), 'home');
    const priceLine = sec.price ? `\n💰 السعر: ${sec.price}` : '';
    const rating = serviceRating(sec.id);
    const ratingLine = rating ? `\n⭐ التقييم: ${rating.avg} (${rating.count} تقييم)` : '';
    return showCustomer(ctx, `**${sec.title}**\n\n${sec.text || ''}${priceLine}${ratingLine}`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ تأكيد الطلب', `order:${sec.id}`)],
        [Markup.button.callback('🎟️ كود خصم', `discount:${sec.id}`)],
        [Markup.button.callback('❌ إلغاء', 'cancel')],
        [Markup.button.callback('🔙 رجوع', 'home')]
    ]));
});

bot.action(/^discount:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const { sections } = loadSections();
    const sec = sections.find((s) => s.id === id);
    await safeAnswer(ctx);
    if (!sec) return showCustomer(ctx, 'هاد القسم مو موجود.', homeKeyboard(), 'home');
    // The service id contains an underscore (sec_offer1), which breaks
    // Telegram Markdown parsing when bare, so it must be inside backticks.
    // Same class of bug as the pay prompt in PR #15.
    const promptText = `🎟️ **كود خصم**\n\nالخدمة: ${sec.title}\nالسعر: ${sec.price || '-'}\n\nأرسل كود الخصم:\n\nمعرف الخدمة: \`${sec.id}\``;
    return replyCustomer(ctx, promptText, Markup.forceReply());
});

bot.action(/^order:(.+)$/, async (ctx) => {
    const parts = ctx.match[1].split(':');
    const id = parts[0];
    const code = parts[1] || '';
    const { sections } = loadSections();
    const sec = sections.find((s) => s.id === id);
    await safeAnswer(ctx);
    if (!sec) return showCustomer(ctx, 'هاد القسم مو موجود.', homeKeyboard(), 'home');
    const disc = findDiscount(code);
    const discOk = disc && discountApplies(disc, sec.id) ? disc : null;
    const priceAfter = discOk ? applyDiscount(sec.price || '', discOk.percent) : (sec.price || '');
    const priceLine = sec.price ? `\n💰 السعر: ${sec.price}` : '';
    const discLine = discOk ? `\n🎟️ كود ${discOk.code}: خصم ${discOk.percent}%\n💰 السعر بعد الخصم: ${priceAfter}` : '';
    const codePart = discOk ? ':' + discOk.code : '';
    return showCustomer(ctx,
        `💳 **صفحة الدفع**\n\n**${sec.title}**${priceLine}${discLine}\n\nاختر طريقة الدفع:`,
        Markup.inlineKeyboard([
            [Markup.button.callback('💵 شام كاش', `method:${sec.id}${codePart}:sham`)],
            [Markup.button.callback('🟡 بينانس', `method:${sec.id}${codePart}:binance`)],
            [Markup.button.callback('❌ إلغاء', 'home')]
        ]));
});

bot.action(/^method:(.+)$/, async (ctx) => {
    const parsed = parsePayCallback(ctx.match[1]);
    const id = parsed.id;
    const code = parsed.code;
    const method = parsed.method;
    const { sections } = loadSections();
    const sec = sections.find((s) => s.id === id);
    await safeAnswer(ctx);
    if (!sec || (method !== 'sham' && method !== 'binance')) return showCustomer(ctx, 'طريقة الدفع مو موجودة.', homeKeyboard());
    const disc = findDiscount(code);
    const discOk = disc && discountApplies(disc, sec.id) ? disc : null;
    const priceAfter = discOk ? applyDiscount(sec.price || '', discOk.percent) : (sec.price || '');
    const priceLine = sec.price ? `\n💰 السعر: ${sec.price}` : '';
    const discLine = discOk ? `\n🎟️ كود ${discOk.code}: خصم ${discOk.percent}%\n💰 السعر بعد الخصم: ${priceAfter}` : '';
    const codePart = discOk ? ':' + discOk.code : '';
    return showCustomer(ctx,
        `💳 **صفحة الدفع - ${paymentMethodLabel(method)}**\n\n**${sec.title}**${priceLine}${discLine}\n\n${paymentInfoForMethod(method)}\n👆 كبس زر "نسخ الكود" لتنسخو.\n\nادفع المبلغ المطلوب، وبعدها كبس "تأكيد الدفع".`,
        Markup.inlineKeyboard([
            [copyCodeButton('📋 نسخ الكود', paymentCode(method))],
            [Markup.button.callback('💳 تأكيد الدفع', `pay:${sec.id}${codePart}:${method}`)],
            [Markup.button.callback('🔙 رجوع لطرق الدفع', `order:${sec.id}${codePart}`)],
            [Markup.button.callback('❌ إلغاء', 'home')]
        ]));
});

bot.action(/^pay:(.+)$/, async (ctx) => {
    const parsed = parsePayCallback(ctx.match[1]);
    const id = parsed.id;
    const payCode = parsed.code;
    const payMethod = parsed.method;
    const { sections } = loadSections();
    const sec = sections.find((s) => s.id === id);
    await safeAnswer(ctx, 'أرسل إثبات الدفع');
    if (!sec) return safeEdit(ctx, 'هاد القسم مو موجود.', homeKeyboard());
    // Reset: drop this user's stale orders that never got payment proof,
    // then create ONE fresh order. The order is only complete once the
    // customer sends a transaction number or a payment screenshot.
    const ordersData = loadOrders();
    ordersData.orders = ordersData.orders.filter((o) => !(o.userId === String(ctx.from.id) && o.status === 'awaiting_proof'));
    const payDiscRaw = findDiscount(payCode);
    const payDisc = payDiscRaw && discountApplies(payDiscRaw, sec.id) ? payDiscRaw : null;
    const order = {
        id: 'ord_' + Date.now(), serviceId: sec.id, serviceTitle: sec.title,
        price: payDisc ? applyDiscount(sec.price || '', payDisc.percent) : (sec.price || ''),
        priceBefore: payDisc ? (sec.price || '') : '',
        discountCode: payDisc ? payDisc.code : '', discountPercent: payDisc ? payDisc.percent : 0,
        paymentMethod: payMethod || '',
        userId: String(ctx.from.id), username: ctx.from.username || '',
        name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
        status: 'awaiting_proof', txNumber: '', createdAt: new Date().toISOString()
    };
    if (payDisc) {
        const ddata = loadDiscounts();
        const dc = ddata.codes.find((c) => c.code === payDisc.code);
        if (dc) { dc.uses = (dc.uses || 0) + 1; saveDiscounts(ddata); }
    }
    ordersData.orders.push(order);
    saveJSON(ORDERS_FILE, ordersData);
    const orderId = order.id;
    // The admin is NOT notified yet: the order only reaches him once the
    // customer sends payment proof (transaction number or screenshot).
    // The payment message is the current view: edit it in place to ask for
    // the proof (or replace it if the button sat on a stale one).
    return showCustomer(ctx,
        `⏳ **طلبك بانتظار إثبات الدفع.**\n\nالخدمة: ${sec.title}\nالسعر: ${sec.price || ''}\nرقم الطلب: \`${orderId}\`\n\nأرسل رقم المعاملة أو صورة إيصال الدفع لإكمال طلبك:`,
        Markup.inlineKeyboard([
            [Markup.button.callback('❌ إلغاء الطلب', 'cancel')]
        ]));
});

bot.action(/^msg:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const orderId = ctx.match[1];
    const data = loadOrders();
    const order = data.orders.find((o) => o.id === orderId);
    await safeAnswer(ctx);
    if (!order) return safeEdit(ctx, 'الطلب مو موجود.');
    return ctx.reply(`💬 مراسلة الزبون\n\n${customerLine(order)}\nالخدمة: ${escapeHtml(order.serviceTitle)}\nرقم الطلب: <code>${order.id}</code>\n\nأرسل رسالتك للزبون:`, { parse_mode: 'HTML', ...Markup.forceReply() });
});

bot.action(/^clear:(.+):(orders|archive|notif)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const orderId = ctx.match[1];
    const src = ctx.match[2];
    const data = loadOrders();
    const order = data.orders.find((o) => o.id === orderId);
    await safeAnswer(ctx);
    if (!order) return safeEditHtml(ctx, 'الطلب مو موجود.');
    const count = (loadChats().chats[order.userId] || []).length;
    return safeEditHtml(ctx, `🗑️ <b>مسح محادثة الزبون</b>\n\n${customerLine(order)}\nالخدمة: ${escapeHtml(order.serviceTitle)}\n\nهاد رح يحذف ${count} رسالة من محادثة الزبون مع البوت، من عند الزبون، مشان ما تضل معجقة عندو. رسائلك أنت مع البوت ما بتنمسح.\n\nمتأكد؟`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ نعم، امسح المحادثة', `cleardo:${orderId}:${src}`)],
        [Markup.button.callback('❌ إلغاء', `cancelclear:${orderId}:${src}`)]
    ]));
});
bot.action(/^cleardo:(.+):(orders|archive|notif)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const orderId = ctx.match[1];
    const data = loadOrders();
    const order = data.orders.find((o) => o.id === orderId);
    await safeAnswer(ctx, 'عم امسح المحادثة...');
    if (!order) return safeEditHtml(ctx, 'الطلب مو موجود.');
    const chats = loadChats();
    const ids = chats.chats[order.userId] || [];
    let deleted = 0, failed = 0;
    for (const mid of ids) {
        try { await ctx.telegram.deleteMessage(order.userId, mid); deleted++; }
        catch (e) { failed++; }
    }
    chats.chats[order.userId] = [];
    saveChats(chats);
    const note = failed ? `\n${failed} رسالة ما انحذفت، يمكن لأنها قديمة أو انحذفت من قبل.` : '';
    return safeEditHtml(ctx, `🗑️ تم مسح محادثة الزبون\n\nانحذف ${deleted} رسالة من عند الزبون.${note}`, Markup.inlineKeyboard([
        [Markup.button.callback('🔙 رجوع لتفاصيل الطلب', `admin:order:${orderId}`)],
        [Markup.button.callback('🏠 لوحة التحكم', 'admin:home')]
    ]));
});
bot.action(/^cancelclear:(.+):(orders|archive|notif)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const orderId = ctx.match[1];
    const src = ctx.match[2];
    const data = loadOrders();
    const order = data.orders.find((o) => o.id === orderId);
    await safeAnswer(ctx);
    if (!order) return safeEditHtml(ctx, 'الطلب مو موجود.');
    return safeEditHtml(ctx, orderDetailText(order), src === 'notif' ? orderActionKeyboard(order) : orderDetailKeyboard(order, src));
});

bot.action(/^proof:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const orderId = ctx.match[1];
    const data = loadOrders();
    const order = data.orders.find((o) => o.id === orderId);
    await safeAnswer(ctx);
    if (!order || !order.proofPhoto) return safeEditHtml(ctx, 'ما في إثبات دفع مرفق بهاد الطلب.');
    try {
        await ctx.telegram.sendPhoto(ADMIN_ID, order.proofPhoto, { caption: `🖼️ إثبات دفع الطلب <code>${orderId}</code> - ${escapeHtml(order.serviceTitle)}`, parse_mode: 'HTML' });
    } catch (e) {
        return safeEditHtml(ctx, 'ما قدرت ابعت الصورة، يمكن انحذفت من تيليجرام.');
    }
    return safeAnswer(ctx, 'تم إرسال إثبات الدفع');
});

bot.action(/^approve:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const orderId = ctx.match[1];
    const data = loadOrders();
    const order = data.orders.find((o) => o.id === orderId);
    await safeAnswer(ctx, 'تم التأكيد');
    if (!order) return safeEdit(ctx, 'الطلب مو موجود.');
    if (order.status !== 'pending') {
        const nav = (ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.reply_markup && JSON.stringify(ctx.callbackQuery.message.reply_markup).includes('admin:orders'));
        return safeEditHtml(ctx, orderDetailText(order), nav ? orderDetailKeyboard(order, 'archive') : orderActionKeyboard(order));
    }
    order.status = 'confirmed';
    saveJSON(ORDERS_FILE, data);
    // One message only: confirmation + rating request together, as the
    // customer's single view, so the chat never stacks two bot messages.
    await sendCustomerView(ctx.telegram, order.userId, `✅ تم تأكيد الدفع واستلام طلبك: ${order.serviceTitle}\n\nطلبك قيد التنفيذ، شكراً لثقتك.\n\n⭐ قيّم تجربتك معنا: كيف كانت تجربتك؟`, Markup.inlineKeyboard([[1, 2, 3, 4, 5].map((n) => Markup.button.callback('⭐'.repeat(n), `rate:${orderId}:${n}`))]));
    const nav = (ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.reply_markup && JSON.stringify(ctx.callbackQuery.message.reply_markup).includes('admin:orders'));
    return safeEditHtml(ctx, orderDetailText(order), nav ? orderDetailKeyboard(order, 'orders') : orderActionKeyboard(order));
});
bot.action(/^rate:(.+):([1-5])$/, async (ctx) => {
    const orderId = ctx.match[1];
    const stars = parseInt(ctx.match[2], 10);
    const data = loadOrders();
    const order = data.orders.find((o) => o.id === orderId);
    await safeAnswer(ctx);
    if (!order) return;
    if (order.userId !== String(ctx.from.id)) return safeAnswer(ctx, 'هاد التقييم مو لطلبك.');
    if (order.status !== 'confirmed') return safeAnswer(ctx, 'التقييم بيصير بعد تأكيد الطلب.');
    if (typeof order.rating === 'number') return safeAnswer(ctx, 'قيّمت هاد الطلب من قبل، شكراً!');
    order.rating = stars;
    saveJSON(ORDERS_FILE, data);
    await safeAnswer(ctx, 'شكراً على تقييمك!');
    try { await ctx.editMessageText(`شكراً على تقييمك! ${'⭐'.repeat(stars)}\n\nخدمة: ${order.serviceTitle}`); } catch (e) {}
});

bot.action(/^reject:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const orderId = ctx.match[1];
    const data = loadOrders();
    const order = data.orders.find((o) => o.id === orderId);
    await safeAnswer(ctx, 'تم الرفض');
    if (!order) return safeEdit(ctx, 'الطلب مو موجود.');
    if (order.status !== 'pending') {
        const nav = (ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.reply_markup && JSON.stringify(ctx.callbackQuery.message.reply_markup).includes('admin:orders'));
        return safeEditHtml(ctx, orderDetailText(order), nav ? orderDetailKeyboard(order, 'archive') : orderActionKeyboard(order));
    }
    order.status = 'rejected';
    saveJSON(ORDERS_FILE, data);
    await sendCustomerView(ctx.telegram, order.userId, `❌ تم رفض طلبك: ${order.serviceTitle}\n\nتواصل مع الأدمن للتفاصيل.`, homeKeyboard());
    const nav = (ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.reply_markup && JSON.stringify(ctx.callbackQuery.message.reply_markup).includes('admin:orders'));
    return safeEditHtml(ctx, orderDetailText(order), nav ? orderDetailKeyboard(order, 'orders') : orderActionKeyboard(order));
});

// The panel is branched by specialty, so the main menu stays short:
// services, orders, users, discount codes, payment info, stats, settings.
function adminKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🛍️ الخدمات', 'admin:services')],
        [Markup.button.callback('🧾 الطلبات', 'admin:orders_menu')],
        [Markup.button.callback('👥 المستخدمين', 'admin:users')],
        [Markup.button.callback('🎟️ أكواد الخصم', 'admin:discounts')],
        [Markup.button.callback('💳 معلومات الدفع', 'admin:payment')],
        [Markup.button.callback('📊 الإحصائيات', 'admin:stats')],
        [Markup.button.callback('⚙️ الإعدادات', 'admin:settings')],
        [Markup.button.callback('🏠 الرئيسية', 'home')]
    ]);
}
function servicesKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('➕ إضافة خدمة', 'admin:add_section')],
        [Markup.button.callback('✏️ تغيير اسم خدمة', 'admin:rename_service')],
        [Markup.button.callback('✏️ تعديل نص خدمة', 'admin:edit_section')],
        [Markup.button.callback('💰 تعديل سعر خدمة', 'admin:edit_price')],
        [Markup.button.callback('🗂️ تصنيف خدمة', 'admin:set_cat')],
        [Markup.button.callback('🗑️ حذف خدمة', 'admin:del_section')],
        [Markup.button.callback('📋 عرض الخدمات', 'admin:list_sections')],
        [Markup.button.callback('🔙 رجوع للوحة التحكم', 'admin:home')]
    ]);
}
function ordersMenuKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🧾 الطلبات بانتظار التأكد', 'admin:orders')],
        [Markup.button.callback('⏳ طلبات غير مكتملة', 'admin:incomplete')],
        [Markup.button.callback('📦 أرشيف الطلبات', 'admin:archive')],
        [Markup.button.callback('🔙 رجوع للوحة التحكم', 'admin:home')]
    ]);
}
function settingsKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('✏️ تعديل رسالة الترحيب', 'admin:edit_welcome')],
        [Markup.button.callback('💾 نسخة احتياطية', 'admin:backup')],
        [Markup.button.callback('🔙 رجوع للوحة التحكم', 'admin:home')]
    ]);
}
function adminText() {
    return '👑 <b>لوحة تحكم الأدمن</b>\n\nاختار القسم يلي بدك تديره:\n🛍️ الخدمات - إضافة وتعديل وحذف الخدمات\n🧾 الطلبات - المعلقة والغير مكتملة والأرشيف\n👥 المستخدمين - مين عم يستخدم البوت والبث الإعلاني\n🎟️ أكواد الخصم - إنشاء وتخصيص الأكواد\n💳 معلومات الدفع - الشام كاش والبينانس\n📊 الإحصائيات - نظرة شاملة على المتجر\n⚙️ الإعدادات - رسالة الترحيب والنسخة الاحتياطية';
}

bot.action('admin:home', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    return showAdminView(ctx, adminText(), adminKeyboard());
});

bot.action('admin:services', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    return showAdminView(ctx, '🛍️ <b>الخدمات:</b>\n\nمن هون بتضيف خدمة جديدة، وبتغيّر اسمها أو نصها أو سعرها أو تصنيفها، وبتحذفها.', servicesKeyboard());
});
bot.action('admin:orders_menu', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    return showAdminView(ctx, '🧾 <b>الطلبات:</b>\n\nالطلبات بانتظار التأكد، والطلبات يلي لسه ما وصلها إثبات دفع، والأرشيف للطلبات المؤكدة والمرفوضة.', ordersMenuKeyboard());
});
bot.action('admin:settings', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    return showAdminView(ctx, '⚙️ <b>الإعدادات:</b>\n\nرسالة الترحيب يلي بيشوفها الزبون أول ما يفتح البوت، والنسخة الاحتياطية للبيانات.', settingsKeyboard());
});
bot.action('admin:rename_service', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    await safeAnswer(ctx);
    return showAdminView(ctx, '✏️ <b>تغيير اسم خدمة</b>\n\nأرسل أمر واحد بهالشكل:\n<code>/rename 1 | الاسم الجديد</code>\n\nالخدمات:\n' + (sections.map((s, i) => `${i + 1}. ${s.title}`).join('\n') || 'لا يوجد خدمات'), adminPromptKeyboard());
});
bot.action('admin:edit_welcome', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    const current = homeText().replace(/[*_`]/g, '');
    return ctx.reply(`✏️ <b>تعديل رسالة الترحيب</b>\n\nالحالية:\n${escapeHtml(current)}\n\nأرسل رسالة الترحيب الجديدة:\n\nاكتب /cancel للإلغاء.`, { parse_mode: 'HTML', ...Markup.forceReply() });
});

bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    const cfg = loadConfig();
    if (cfg.adminViewMessageId) {
        try { await ctx.telegram.deleteMessage(ADMIN_ID, cfg.adminViewMessageId); } catch (e) {}
    }
    const sent = await ctx.reply(adminText(), { parse_mode: 'HTML', ...adminKeyboard() });
    cfg.adminViewMessageId = sent.message_id;
    saveJSON(CONFIG_FILE, cfg);
    return sent;
});

bot.action('admin:add_section', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    // Multi-step, stateless: ask for the name with force_reply, so the admin's
    // reply carries the step with it. No pending state is stored on the server.
    return ctx.reply('➕ **إضافة خدمة**\n\nأرسل اسم الخدمة:\n\nاكتب /cancel للإلغاء.', { parse_mode: 'Markdown', ...Markup.forceReply() });
});
bot.action('admin:edit_section', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    await safeAnswer(ctx);
    return showAdminView(ctx, '✏️ <b>تعديل نص خدمة</b>\n\nأرسل أمر واحد بهالشكل:\n<code>/edittext 1 | النص الجديد</code>\n\nالخدمات:\n' + (sections.map((s, i) => `${i + 1}. ${s.title}`).join('\n') || 'لا يوجد خدمات'), adminPromptKeyboard());
});
bot.action('admin:edit_price', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    await safeAnswer(ctx);
    return showAdminView(ctx, '💰 <b>تعديل سعر خدمة</b>\n\nأرسل أمر واحد بهالشكل:\n<code>/setprice 1 | 2$</code>\n\nالخدمات:\n' + (sections.map((s, i) => `${i + 1}. ${s.title} - ${s.price || 'بدون سعر'}`).join('\n') || 'لا يوجد خدمات'), adminPromptKeyboard());
});
bot.action('admin:del_section', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    await safeAnswer(ctx);
    return showAdminView(ctx, '🗑️ <b>حذف خدمة</b>\n\nأرسل أمر واحد بهالشكل:\n<code>/delservice 1</code>\n\nالخدمات:\n' + (sections.map((s, i) => `${i + 1}. ${s.title}`).join('\n') || 'لا يوجد خدمات'), adminPromptKeyboard());
});
bot.action('admin:list_sections', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    await safeAnswer(ctx);
    if (!sections.length) return showAdminView(ctx, 'لسه ما في خدمات، ضيف أول خدمة من زر إضافة خدمة.', servicesKeyboard());
    return showAdminView(ctx, '📋 <b>الخدمات:</b>\n\n' + sections.map((s, i) => `${i + 1}. ${escapeHtml(s.title)}\n${escapeHtml(s.text || '')}\nالسعر: ${escapeHtml(s.price || '-')}`).join('\n\n'), servicesKeyboard());
});
bot.action('admin:orders', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { orders } = loadOrders();
    await safeAnswer(ctx);
    if (!orders.length) return showAdminView(ctx, 'لسه ما في طلبات.', ordersMenuKeyboard());
    const recent = orders.filter((o) => o.status === 'pending').slice(-10);
    if (!recent.length) return showAdminView(ctx, 'ما في طلبات بانتظار التأكد، كل الطلبات المؤكدة والمرفوضة صارت بالأرشيف.', Markup.inlineKeyboard([[Markup.button.callback('📦 أرشيف الطلبات', 'admin:archive')], [Markup.button.callback('🔙 رجوع لقائمة الطلبات', 'admin:orders_menu')]]));
    const list = recent.map((o, i) => {
        return `${i + 1}. ${escapeHtml(o.serviceTitle)} - ${escapeHtml(o.price || '')} - ⏳ بانتظار التأكد${o.txNumber ? ' - معاملة: ' + escapeHtml(o.txNumber) : ''}\n   ${customerLine(o).replace(/\n/g, ' | ')}`;
    }).join('\n\n');
    const rows = recent.map((o, i) => [Markup.button.callback(`${i + 1}. ${o.serviceTitle} - بانتظار التأكد`, `admin:order:${o.id}`)]);
    rows.push([Markup.button.callback('📦 أرشيف الطلبات', 'admin:archive')]);
    rows.push([Markup.button.callback('🔙 رجوع لقائمة الطلبات', 'admin:orders_menu')]);
    return showAdminView(ctx, '🧾 <b>الطلبات بانتظار التأكد:</b>\n\n' + list + '\n\nكبس على رقم الطلب مشان تفتح تفاصيلو وتديره.', Markup.inlineKeyboard(rows));
});
bot.action('admin:incomplete', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    await expireAwaitingProofOrders(ctx.telegram);
    const { orders } = loadOrders();
    const waiting = orders.filter((o) => o.status === 'awaiting_proof').slice(-20);
    if (!waiting.length) return showAdminView(ctx, 'ما في طلبات غير مكتملة، كل الطلبات وصلها إثبات دفع أو تلغت.', ordersMenuKeyboard());
    const list = waiting.map((o, i) => `${i + 1}. ${escapeHtml(o.serviceTitle)} - ${escapeHtml(o.price || '')} - من ${new Date(o.createdAt).toLocaleString('ar-SY')}\n   ${customerLine(o).replace(/\n/g, ' | ')}`).join('\n\n');
    const rows = waiting.map((o, i) => [Markup.button.callback(`${i + 1}. ${o.serviceTitle}`, `admin:order:${o.id}`)]);
    rows.push([Markup.button.callback('🔙 رجوع لقائمة الطلبات', 'admin:orders_menu')]);
    return showAdminView(ctx, '⏳ <b>طلبات غير مكتملة (بانتظار إثبات الدفع):</b>\n\n' + list + '\n\nهالطلبات لسه ما وصلها رقم معاملة ولا صورة إيصال، وبتتلغى لحالها بعد 24 ساعة.', Markup.inlineKeyboard(rows));
});

bot.action('admin:archive', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { orders } = loadOrders();
    await safeAnswer(ctx);
    const done = orders.filter((o) => o.status !== 'pending').slice(-20);
    if (!done.length) return showAdminView(ctx, 'الأرشيف فاضي، لسه ما في طلبات مؤكدة أو مرفوضة.', Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع لقائمة الطلبات', 'admin:orders_menu')], [Markup.button.callback('🏠 لوحة التحكم', 'admin:home')]]));
    const list = done.map((o, i) => {
        const status = o.status === 'confirmed' ? '✅ مؤكد' : '❌ مرفوض';
        return `${i + 1}. ${escapeHtml(o.serviceTitle)} - ${escapeHtml(o.price || '')} - ${status}${o.txNumber ? ' - معاملة: ' + escapeHtml(o.txNumber) : ''}\n   ${customerLine(o).replace(/\n/g, ' | ')}`;
    }).join('\n\n');
    const rows = done.map((o, i) => [Markup.button.callback(`${i + 1}. ${o.serviceTitle} - ${o.status === 'confirmed' ? 'مؤكد' : 'مرفوض'}`, `admin:archive:${o.id}`)]);
    rows.push([Markup.button.callback('🔙 رجوع لقائمة الطلبات', 'admin:orders_menu')]);
    rows.push([Markup.button.callback('🏠 لوحة التحكم', 'admin:home')]);
    return showAdminView(ctx, '📦 <b>أرشيف الطلبات:</b>\n\n' + list + '\n\nكبس على رقم الطلب مشان تفتح تفاصيلو.', Markup.inlineKeyboard(rows));
});
bot.action(/^admin:order:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const orderId = ctx.match[1];
    const data = loadOrders();
    const order = data.orders.find((o) => o.id === orderId);
    await safeAnswer(ctx);
    if (!order) return safeEdit(ctx, 'الطلب مو موجود.', adminKeyboard());
    return showAdminView(ctx, orderDetailText(order), orderDetailKeyboard(order, 'orders'));
});
bot.action(/^admin:archive:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const orderId = ctx.match[1];
    const data = loadOrders();
    const order = data.orders.find((o) => o.id === orderId);
    await safeAnswer(ctx);
    if (!order) return safeEdit(ctx, 'الطلب مو موجود.', adminKeyboard());
    return showAdminView(ctx, orderDetailText(order), orderDetailKeyboard(order, 'archive'));
});
bot.action('admin:users', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    const users = Object.values(getAllUsers()).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen)).slice(0, 20);
    if (!users.length) return showAdminView(ctx, 'لسه ما في مستخدمين.', adminKeyboard());
    const list = users.map((u, i) => `${i + 1}. ${escapeHtml(u.name)} (${u.username ? '@' + escapeHtml(u.username) : 'بدون معرف'}) - طلبات: ${countUserOrders(u.userId)}`).join('\n');
    const rows = users.map((u, i) => [Markup.button.callback(`${i + 1}. ${u.name}`, `admin:user:${u.userId}`)]);
    rows.push([Markup.button.callback('📣 بث إعلاني', 'admin:broadcast')]);
    rows.push([Markup.button.callback('🔙 رجوع للوحة التحكم', 'admin:home')]);
    return showAdminView(ctx, '👥 <b>المستخدمين:</b>\n\n' + list + '\n\nكبس على اسم المستخدم مشان تفتح تفاصيلو.', Markup.inlineKeyboard(rows));
});
bot.action(/^admin:user:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const userId = ctx.match[1];
    await safeAnswer(ctx);
    const users = getAllUsers();
    const u = users[userId];
    if (!u) return showAdminView(ctx, 'المستخدم مو موجود.', adminKeyboard());
    const myOrders = loadOrders().orders.filter((o) => o.userId === userId);
    const ordersList = myOrders.length ? myOrders.map((o, i) => `${i + 1}. ${escapeHtml(o.serviceTitle)} - ${o.price || ''} - ${o.status === 'confirmed' ? '✅ مؤكد' : o.status === 'rejected' ? '❌ مرفوض' : o.status === 'awaiting_proof' ? '⏳ بانتظار إثبات الدفع' : o.status === 'expired' ? '🕐 ملغي' : '⏳ بانتظار التأكد'}`).join('\n') : 'ما عندو طلبات بعد.';
    const rows = myOrders.map((o, i) => [Markup.button.callback(`${i + 1}. ${escapeHtml(o.serviceTitle)}`, `admin:order:${o.id}`)]);
    rows.push([Markup.button.callback('🗑️ مسح محادثة المستخدم', `clearuser:${userId}`)]);
    rows.push([Markup.button.callback('🔙 رجوع للمستخدمين', 'admin:users')]);
    rows.push([Markup.button.callback('🏠 لوحة التحكم', 'admin:home')]);
    return showAdminView(ctx, `👥 <b>تفاصيل المستخدم</b>\n\n${customerLine({ name: u.name, username: u.username, userId: u.userId })}\nأول مرة: ${new Date(u.firstSeen).toLocaleString('ar-SY')}\nآخر ظهور: ${new Date(u.lastSeen).toLocaleString('ar-SY')}\nعدد الطلبات: ${myOrders.length}\n\n<b>طلباتو:</b>\n${ordersList}`, Markup.inlineKeyboard(rows));
});
bot.action(/^clearuser:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const userId = ctx.match[1];
    await safeAnswer(ctx);
    const u = getAllUsers()[userId];
    if (!u) return safeEditHtml(ctx, 'المستخدم مو موجود.');
    const count = (loadChats().chats[userId] || []).length;
    return safeEditHtml(ctx, `🗑️ <b>مسح محادثة المستخدم</b>\n\n${customerLine({ name: u.name, username: u.username, userId: u.userId })}\n\nهاد رح يحذف ${count} رسالة من محادثة المستخدم مع البوت، من عند المستخدم.\n\nمتأكد؟`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ نعم، امسح المحادثة', `clearuserdo:${userId}`)],
        [Markup.button.callback('❌ إلغاء', `cancelclearuser:${userId}`)]
    ]));
});
bot.action(/^clearuserdo:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const userId = ctx.match[1];
    await safeAnswer(ctx, 'عم امسح المحادثة...');
    const u = getAllUsers()[userId];
    if (!u) return safeEditHtml(ctx, 'المستخدم مو موجود.');
    const chats = loadChats();
    const ids = chats.chats[userId] || [];
    let deleted = 0, failed = 0;
    for (const mid of ids) {
        try { await ctx.telegram.deleteMessage(userId, mid); deleted++; }
        catch (e) { failed++; }
    }
    chats.chats[userId] = [];
    saveChats(chats);
    const note = failed ? `\n${failed} رسالة ما انحذفت، يمكن لأنها قديمة أو انحذفت من قبل.` : '';
    return safeEditHtml(ctx, `🗑️ تم مسح محادثة المستخدم\n\nانحذف ${deleted} رسالة من عند المستخدم.${note}`, Markup.inlineKeyboard([
        [Markup.button.callback('🔙 رجوع لتفاصيل المستخدم', `admin:user:${userId}`)],
        [Markup.button.callback('🏠 لوحة التحكم', 'admin:home')]
    ]));
});
bot.action(/^cancelclearuser:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const userId = ctx.match[1];
    await safeAnswer(ctx);
    const u = getAllUsers()[userId];
    if (!u) return safeEditHtml(ctx, 'المستخدم مو موجود.');
    return safeEditHtml(ctx, `👥 <b>تفاصيل المستخدم</b>\n\n${customerLine({ name: u.name, username: u.username, userId: u.userId })}`, Markup.inlineKeyboard([
        [Markup.button.callback('🗑️ مسح محادثة المستخدم', `clearuser:${userId}`)],
        [Markup.button.callback('🔙 رجوع للمستخدمين', 'admin:users')],
        [Markup.button.callback('🏠 لوحة التحكم', 'admin:home')]
    ]));
});

bot.action('admin:discounts', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    const codes = loadDiscounts().codes;
    const list = codes.length ? codes.map((c, i) => `${i + 1}. <code>${escapeHtml(c.code)}</code> - خصم ${c.percent}% - استخدامات: ${c.uses || 0} - ${escapeHtml(discountScopeText(c))}`).join('\n') : 'لسه ما في أكواد خصم.';
    const rows = codes.map((c) => [Markup.button.callback(`🎯 تخصيص ${c.code}`, `assign:${c.code}`), Markup.button.callback(`🗑️ حذف ${c.code}`, `delcode:${c.code}`)]);
    rows.push([Markup.button.callback('➕ إضافة كود خصم', 'admin:addcode')]);
    rows.push([Markup.button.callback('🔙 رجوع للوحة التحكم', 'admin:home')]);
    return showAdminView(ctx, '🎟️ <b>أكواد الخصم:</b>\n\n' + list, Markup.inlineKeyboard(rows));
});
bot.action('admin:addcode', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    return ctx.reply('🎟️ <b>إضافة كود خصم</b>\n\nأرسل الكود والنسبة بهالشكل:\n<code>MK10 | 10</code>\n\nاكتب /cancel للإلغاء.', { parse_mode: 'HTML', ...Markup.forceReply() });
});
bot.action(/^delcode:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const code = ctx.match[1];
    await safeAnswer(ctx);
    const data = loadDiscounts();
    data.codes = data.codes.filter((c) => c.code !== code);
    saveDiscounts(data);
    const codes = data.codes;
    const list = codes.length ? codes.map((c, i) => `${i + 1}. <code>${escapeHtml(c.code)}</code> - خصم ${c.percent}% - استخدامات: ${c.uses || 0} - ${escapeHtml(discountScopeText(c))}`).join('\n') : 'لسه ما في أكواد خصم.';
    const rows = codes.map((c) => [Markup.button.callback(`🎯 تخصيص ${c.code}`, `assign:${c.code}`), Markup.button.callback(`🗑️ حذف ${c.code}`, `delcode:${c.code}`)]);
    rows.push([Markup.button.callback('➕ إضافة كود خصم', 'admin:addcode')]);
    rows.push([Markup.button.callback('🔙 رجوع للوحة التحكم', 'admin:home')]);
    return showAdminView(ctx, '🎟️ <b>أكواد الخصم:</b>\n\n' + list, Markup.inlineKeyboard(rows));
});
bot.action(/^assign:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const code = ctx.match[1];
    await safeAnswer(ctx);
    const disc = findDiscount(code);
    if (!disc) return showAdminView(ctx, 'الكود مو موجود.', adminKeyboard());
    const { sections } = loadSections();
    const ids = disc.serviceIds || [];
    const rows = sections.map((s) => [Markup.button.callback(`${ids.includes(s.id) ? '✅ ' : '⬜ '}${s.title}`, `toggle:${code}:${s.id}`)]);
    rows.push([Markup.button.callback('🌍 عام (كل الخدمات)', `assignall:${code}`)]);
    rows.push([Markup.button.callback('🔙 رجوع لأكواد الخصم', 'admin:discounts')]);
    return showAdminView(ctx, `🎯 <b>تخصيص الكود ${escapeHtml(code)}</b>\n\nالنطاق الحالي: ${escapeHtml(discountScopeText(disc))}\n\nكبس على خدمة مشان تضيفها أو تشيلها من الكود. إذا ما اخترت ولا خدمة، الكود بيضل عام وبيشتغل على الكل.`, Markup.inlineKeyboard(rows));
});
bot.action(/^toggle:(.+):(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const code = ctx.match[1];
    const secId = ctx.match[2];
    await safeAnswer(ctx);
    const data = loadDiscounts();
    const disc = data.codes.find((c) => c.code === code);
    if (!disc) return showAdminView(ctx, 'الكود مو موجود.', adminKeyboard());
    disc.serviceIds = disc.serviceIds || [];
    const i = disc.serviceIds.indexOf(secId);
    if (i >= 0) disc.serviceIds.splice(i, 1);
    else disc.serviceIds.push(secId);
    saveDiscounts(data);
    const { sections } = loadSections();
    const rows = sections.map((s) => [Markup.button.callback(`${disc.serviceIds.includes(s.id) ? '✅ ' : '⬜ '}${s.title}`, `toggle:${code}:${s.id}`)]);
    rows.push([Markup.button.callback('🌍 عام (كل الخدمات)', `assignall:${code}`)]);
    rows.push([Markup.button.callback('🔙 رجوع لأكواد الخصم', 'admin:discounts')]);
    return showAdminView(ctx, `🎯 <b>تخصيص الكود ${escapeHtml(code)}</b>\n\nالنطاق الحالي: ${escapeHtml(discountScopeText(disc))}\n\nكبس على خدمة مشان تضيفها أو تشيلها من الكود. إذا ما اخترت ولا خدمة، الكود بيضل عام وبيشتغل على الكل.`, Markup.inlineKeyboard(rows));
});
bot.action(/^assignall:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const code = ctx.match[1];
    await safeAnswer(ctx);
    const data = loadDiscounts();
    const disc = data.codes.find((c) => c.code === code);
    if (!disc) return showAdminView(ctx, 'الكود مو موجود.', adminKeyboard());
    disc.serviceIds = [];
    saveDiscounts(data);
    return showAdminView(ctx, `🎯 الكود ${escapeHtml(code)} صار عام وبيشتغل على كل الخدمات.`, adminKeyboard());
});

bot.action('admin:broadcast', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    return ctx.reply('📣 <b>بث إعلاني</b>\n\nأرسل نص الرسالة الإعلانية:\n\nاكتب /cancel للإلغاء.', { parse_mode: 'HTML', ...Markup.forceReply() });
});
bot.action('broadcast:send', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx, 'عم ببعت البث...');
    const cfg = loadConfig();
    const text = cfg.pendingBroadcast || '';
    if (!text) return showAdminView(ctx, 'ما في رسالة بث محفوظة، ابدأ من جديد.', adminKeyboard());
    const users = Object.values(getAllUsers()).filter((u) => u.userId !== ADMIN_ID);
    let ok = 0, fail = 0;
    for (const u of users) {
        try { await ctx.telegram.sendMessage(u.userId, `📣 <b>MK_STORE</b>\n\n${escapeHtml(text)}`, { parse_mode: 'HTML' }); ok++; }
        catch (e) { fail++; }
        await new Promise((r) => setTimeout(r, 40));
    }
    cfg.pendingBroadcast = '';
    saveJSON(CONFIG_FILE, cfg);
    return showAdminView(ctx, `📣 <b>تم إرسال البث</b>\n\nوصل لـ ${ok} مستخدم، وفشل عند ${fail} مستخدم.`, adminKeyboard());
});
bot.action('broadcast:cancel', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    const cfg = loadConfig();
    cfg.pendingBroadcast = '';
    saveJSON(CONFIG_FILE, cfg);
    return showAdminView(ctx, adminText(), adminKeyboard());
});
bot.action('admin:set_cat', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    await safeAnswer(ctx);
    const list = sections.map((s, i) => `${i + 1}. ${escapeHtml(s.title)} - التصنيف الحالي: ${escapeHtml((s.category || 'عام').trim() || 'عام')}`).join('\n') || 'لا يوجد خدمات';
    return showAdminView(ctx, '🗂️ <b>تصنيف خدمة</b>\n\nأرسل أمر واحد بهالشكل:\n<code>/setcat 1 | حسابات</code>\n\nالخدمات:\n' + list, adminPromptKeyboard());
});

bot.action('admin:payment', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    return showAdminView(ctx, `💳 <b>معلومات الدفع:</b>\n\n💵 <b>شام كاش:</b>\n${paymentInfoHtml('sham')}\n\n🟡 <b>بينانس:</b>\n${paymentInfoHtml('binance')}`, Markup.inlineKeyboard([
        [copyCodeButton('📋 نسخ كود الشام', paymentCode('sham'))],
        [copyCodeButton('📋 نسخ كود بينانس', paymentCode('binance'))],
        [Markup.button.callback('✏️ تعديل شام كاش', 'admin:edit_payment:sham')],
        [Markup.button.callback('✏️ تعديل بينانس', 'admin:edit_payment:binance')],
        [Markup.button.callback('🔙 رجوع للوحة التحكم', 'admin:home')]
    ]));
});
bot.action(/^admin:edit_payment:(sham|binance)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const method = ctx.match[1];
    await safeAnswer(ctx);
    return ctx.reply(`💳 <b>تعديل معلومات الدفع - ${paymentMethodLabel(method)}</b>\n\nالحالية:\n${escapeHtml(paymentMethodInfo(method))}\n\nأرسل معلومات الدفع الجديدة لـ ${method === 'sham' ? 'شام كاش' : 'بينانس'}:\n\nاكتب /cancel للإلغاء.`, { parse_mode: 'HTML', ...Markup.forceReply() });
});

bot.action('admin:set_payment', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    return showAdminView(ctx, '💳 <b>تعديل معلومات الدفع</b>\n\nأرسل أمر واحد بهالشكل:\n<code>/setpayment sham | معلومات الشام كاش الجديدة</code>\nأو:\n<code>/setpayment binance | معلومات البينانس الجديدة</code>', adminPromptKeyboard());
});
bot.action('admin:stats', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const sections = loadSections().sections.length;
    const orders = loadOrders().orders;
    const pendingCount = orders.filter((o) => o.status === 'pending').length;
    await safeAnswer(ctx);
    const users = Object.values(getAllUsers());
    const today = new Date().toISOString().slice(0, 10);
    const newToday = users.filter((u) => (u.firstSeen || '').slice(0, 10) === today).length;
    const confirmedCount = orders.filter((o) => o.status === 'confirmed').length;
    const rejectedCount = orders.filter((o) => o.status === 'rejected').length;
    const awaitingCount = orders.filter((o) => o.status === 'awaiting_proof').length;
    return showAdminView(ctx, `📊 <b>إحصائيات شاملة:</b>\n\n👥 <b>المستخدمون:</b> ${users.length} (جدد اليوم: ${newToday})\n🧾 <b>الطلبات:</b> ${orders.length}\n⏳ بانتظار إثبات الدفع: ${awaitingCount}\n⏳ بانتظار التأكد: ${pendingCount}\n✅ مكتملة (مؤكدة): ${confirmedCount}\n❌ مرفوضة: ${rejectedCount}\n📋 <b>الخدمات:</b> ${sections}`, adminKeyboard());
});
bot.action('admin:backup', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    await backupToAdmin(ctx);
    return showAdminView(ctx, 'تم إرسال النسخة الاحتياطية على الخاص.', settingsKeyboard());
});

function parseField(text, label) {
    const m = text.match(new RegExp(label + ':\\s*(.+)'));
    return m ? m[1].trim() : '';
}
function priceFrom(text) {
    const m = text.match(/(\d+(?:[.,]\d+)?\s*\$|\$\s*\d+)/);
    return m ? m[0].trim() : '';
}
bot.on('text', async (ctx, next) => {
    // Transaction number from a normal user (not admin)
    if (!isAdmin(ctx)) {
        const text = ctx.message.text.trim();
        if (text.startsWith('/')) return next();
        const replied = (ctx.message.reply_to_message && ctx.message.reply_to_message.text) || '';
        // Replying to the discount-code prompt -> validate the code
        if (replied.includes('أرسل كود الخصم')) {
            const m = replied.match(/معرف الخدمة:\s*(\S+)/);
            const secId = m ? m[1].replace(/`/g, '').trim() : '';
            const { sections } = loadSections();
            const sec = sections.find((s) => s.id === secId);
            if (!sec) return replyCustomer(ctx, 'الخدمة مو موجودة، ابدأ من جديد بأمر /start', homeKeyboard());
            const disc = findDiscount(text);
            if (!disc) return replyCustomer(ctx, 'الكود مو صحيح أو منتهي، تأكد وحاول مرة تانية.', homeKeyboard());
            if (!discountApplies(disc, sec.id)) return replyCustomer(ctx, 'هاد الكود مو صالح لهالخدمة، هو مخصص لخدمة تانية.', homeKeyboard());
            const priceAfter = applyDiscount(sec.price || '', disc.percent);
            const rating = serviceRating(sec.id);
            const ratingLine = rating ? `\n⭐ التقييم: ${rating.avg} (${rating.count} تقييم)` : '';
            return replyCustomer(ctx, `**${sec.title}**\n\n${sec.text || ''}\n💰 السعر: ${sec.price || ''}\n🎟️ كود ${disc.code}: خصم ${disc.percent}%\n💰 السعر بعد الخصم: ${priceAfter}${ratingLine}`, Markup.inlineKeyboard([
                [Markup.button.callback('✅ تأكيد الطلب', `order:${sec.id}:${disc.code}`)],
                [Markup.button.callback('❌ إلغاء', 'cancel')],
                [Markup.button.callback('🔙 رجوع', 'home')]
            ]));
        }
        let serviceId = '';
        if (replied.includes('أرسل رقم المعاملة')) {
            const m = replied.match(/معرف الخدمة:\s*(\S+)/);
            serviceId = m ? m[1].trim() : '';
        }
        // Fallback: a plain transaction number from a user with a recent pending order
        // (this is the common case - the user just types the number, without replying)
        if (!serviceId) {
            const ordersData = loadOrders();
            const uid = String(ctx.from.id);
            // Payment proof completes the order: prefer an order waiting for
            // proof, then (for orders made before this change) a pending one
            // without a transaction number.
            let pendingOrder = ordersData.orders.filter((o) => o.userId === uid && o.status === 'awaiting_proof').slice(-1)[0]
                || ordersData.orders.filter((o) => o.userId === uid && o.status === 'pending' && !o.txNumber).slice(-1)[0];
            // Forgiving fallback: the transaction number was sometimes sent
            // from a different account/device than the one that clicked
            // Confirm Payment. If this sender has no order waiting for proof,
            // but there is a recent one (last 30 minutes), attach the number
            // to it instead of leaving the user stuck. The admin is told the
            // sender id.
            let senderMismatch = false;
            if (!pendingOrder) {
                const recent = ordersData.orders.filter((o) => (o.status === 'awaiting_proof' || (o.status === 'pending' && !o.txNumber)) && Date.now() - new Date(o.createdAt || 0).getTime() < 30 * 60 * 1000);
                if (recent.length) { pendingOrder = recent.slice(-1)[0]; senderMismatch = true; }
            }
            if (pendingOrder && /^[A-Za-z0-9_-]{3,}$/.test(text)) {
                const wasAwaiting = pendingOrder.status === 'awaiting_proof';
                pendingOrder.txNumber = text;
                if (wasAwaiting) pendingOrder.status = 'pending';
                saveJSON(ORDERS_FILE, ordersData);
                if (ADMIN_ID) {
                    try {
                        await ctx.telegram.sendMessage(ADMIN_ID,
                            orderNotifyText(pendingOrder, senderMismatch ? `\nتنبيه: رقم المعاملة انبعت من حساب تاني، آيدي المرسل: <code>${ctx.from.id}</code>` : ''),
                            { parse_mode: 'HTML', ...orderActionKeyboard(pendingOrder) });
                    } catch (e) {}
                }
                return replyCustomer(ctx, wasAwaiting
                    ? `✅ **تم استلام إثبات الدفع، طلبك صار قيد التنفيذ ريثما يتم التأكد من الدفع.**\n\nالخدمة: ${pendingOrder.serviceTitle}\nرقم الطلب: \`${pendingOrder.id}\`\nرقم المعاملة: \`${text}\`\n\nرح نبلغك بس نتأكد من الدفع.`
                    : `⏳ **تم استلام طلبك، الطلب قيد التنفيذ ريثما يتم التأكد من الدفع.**\n\nالخدمة: ${pendingOrder.serviceTitle}\nرقم الطلب: \`${pendingOrder.id}\`\nرقم المعاملة: \`${text}\`\n\nرح نبلغك بس نتأكد من الدفع.`, homeKeyboard());
            }
            // Only customers with an order can message the admin. Anyone else
            // gets a polite reply pointing them to order first, and nothing
            // is forwarded, so random messages never reach the admin.
            const hasOrder = ordersData.orders.some((o) => o.userId === String(ctx.from.id));
            if (!hasOrder) {
                return replyCustomer(ctx, 'للتواصل مع الأدمن لازم يكون عندك طلب أولاً.\n\nتصفح الخدمات واطلب اللي بيناسبك، وبعدها بتقدر تراسلنا بخصوص طلبك.', homeKeyboard());
            }
            if (ADMIN_ID && text.length >= 3) {
                try { await ctx.telegram.sendMessage(ADMIN_ID, `💬 رسالة من زبون\n\n${customerLine({ name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '), username: ctx.from.username || '', userId: String(ctx.from.id) })}\n\nالرسالة: ${escapeHtml(text)}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.url('فتح محادثة الزبون', `tg://user?id=${ctx.from.id}`)]]) }); } catch (e) {}
            }
            return replyCustomer(ctx, 'تم إرسال رسالتك للأدمن، رح يرد عليك.', homeKeyboard());
        }
        const { sections } = loadSections();
        const sec = sections.find((s) => s.id === serviceId);
        if (!sec) return replyCustomer(ctx, 'الخدمة مو موجودة، ابدأ من جديد بأمر /start', homeKeyboard());
        const ordersData = loadOrders();
        const orderId = 'ord_' + Date.now();
        const order = {
            id: orderId, serviceId: sec.id, serviceTitle: sec.title, price: sec.price || '',
            userId: String(ctx.from.id), username: ctx.from.username || '',
            name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
            status: 'pending', txNumber: text, createdAt: new Date().toISOString()
        };
        ordersData.orders.push(order);
        saveJSON(ORDERS_FILE, ordersData);
        if (ADMIN_ID) {
            try {
                await ctx.telegram.sendMessage(ADMIN_ID, orderNotifyText(order), { parse_mode: 'HTML', ...orderActionKeyboard(order) });
            } catch (e) { console.error('Admin notify failed:', e.message); }
        }
        return replyCustomer(ctx, `⏳ **تم استلام طلبك، الطلب قيد التنفيذ ريثما يتم التأكد من الدفع.**\n\nالخدمة: ${sec.title}\nرقم الطلب: \`${orderId}\`\nرقم المعاملة: \`${text}\`\n\nرح نبلغك بس نتأكد من الدفع.`, homeKeyboard());
    }
    if (!isAdmin(ctx)) return next();
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return next();
    const replied = (ctx.message.reply_to_message && ctx.message.reply_to_message.text) || '';
    // Replying to the message-customer prompt -> forward to that customer
    if (replied.includes('أرسل رسالتك للزبون')) {
        const m = replied.match(/ord_\d+/);
        const orderId = m ? m[0] : '';
        const data = loadOrders();
        const order = data.orders.find((o) => o.id === orderId);
        if (!order) return ctx.reply('ما لقيت الطلب، ابدأ من جديد من لوحة الطلبات.');
        try {
            await sendCustomerView(ctx.telegram, order.userId, `💬 رسالة من المتجر بخصوص طلبك (${order.serviceTitle}):\n\n${text}`, homeKeyboard());
            return ctx.reply(`تم إرسال رسالتك للزبون ${order.name || order.userId}.`, { parse_mode: 'Markdown', ...adminKeyboard() });
        } catch (e) {
            return ctx.reply('ما قدرت ابعت الرسالة للزبون، يمكن حظر البوت أو ما فتح المحادثة معه بعد.');
        }
    }
    // Replying to the edit-payment prompt -> save the method info
    if (replied.includes('أرسل معلومات الدفع الجديدة لـ')) {
        const method = replied.includes('شام كاش') ? 'sham' : 'binance';
        const cfg = loadConfig();
        if (method === 'sham') cfg.paymentSham = text;
        else cfg.paymentBinance = text;
        saveJSON(CONFIG_FILE, cfg);
        return ctx.reply('تم تعديل معلومات الدفع.', { parse_mode: 'Markdown', ...adminKeyboard() });
    }
    // Replying to the add-code prompt -> create the discount code
    if (replied.includes('أرسل الكود والنسبة')) {
        const parts = text.split('|').map((s) => s.trim());
        const code = (parts[0] || '').toUpperCase();
        const percent = parseInt(parts[1], 10);
        if (!code || isNaN(percent) || percent <= 0 || percent >= 100) return ctx.reply('الصيغة: MK10 | 10  (الكود، ثم نسبة الخصم من 1 لـ 99)');
        const data = loadDiscounts();
        const existing = data.codes.find((c) => c.code === code);
        if (existing) existing.percent = percent;
        else data.codes.push({ code, percent, uses: 0, createdAt: new Date().toISOString() });
        saveDiscounts(data);
        return ctx.reply(`تم حفظ كود الخصم ${code} بخصم ${percent}%.`, { parse_mode: 'Markdown', ...adminKeyboard() });
    }
    // Replying to the broadcast prompt -> preview + confirm
    if (replied.includes('أرسل نص الرسالة الإعلانية')) {
        const cfg = loadConfig();
        cfg.pendingBroadcast = text;
        saveJSON(CONFIG_FILE, cfg);
        const count = Object.values(getAllUsers()).filter((u) => u.userId !== ADMIN_ID).length;
        return showAdminView(ctx, `📣 <b>معاينة البث:</b>\n\n${escapeHtml(text)}\n\nرح يوصلك لـ ${count} مستخدم.\n\nمتأكد بدك تبعتو؟`, Markup.inlineKeyboard([
            [Markup.button.callback('✅ إرسال للكل', 'broadcast:send')],
            [Markup.button.callback('❌ إلغاء', 'broadcast:cancel')]
        ]));
    }
    // Replying to the welcome-text prompt -> save it and refresh the store live
    if (replied.includes('أرسل رسالة الترحيب الجديدة')) {
        const cfg = loadConfig();
        cfg.welcomeText = text;
        saveJSON(CONFIG_FILE, cfg);
        await refreshStoreViews(ctx.telegram);
        return ctx.reply('تم تعديل رسالة الترحيب، وظهرت عند الزباين فوراً.', { parse_mode: 'Markdown', ...adminKeyboard() });
    }
    // Step 3: replying to the price prompt -> create the service
    if (replied.includes('أرسل سعر الخدمة')) {
        const name = parseField(replied, 'اسم الخدمة');
        const desc = parseField(replied, 'الوصف');
        if (!name) return ctx.reply('ما لقيت اسم الخدمة، ابدأ من جديد بزر إضافة خدمة.');
        addOrUpdateService(name, text, desc);
        // backup only on demand now, to keep the bot fast
        await refreshStoreViews(ctx.telegram);
        return ctx.reply(`تمت إضافة الخدمة "${name}" بسعر ${text} بنجاح.`, { parse_mode: 'Markdown', ...adminKeyboard() });
    }
    // Step 2: replying to the description prompt -> ask price, or finish if price included
    if (replied.includes('أرسل وصف الخدمة')) {
        const name = parseField(replied, 'اسم الخدمة');
        if (!name) return ctx.reply('ما لقيت اسم الخدمة، ابدأ من جديد بزر إضافة خدمة.');
        const parts = text.split('|').map((s) => s.trim());
        if (parts.length >= 2) {
            addOrUpdateService(name, parts[1], parts[0]);
            // backup only on demand now, to keep the bot fast
            await refreshStoreViews(ctx.telegram);
            return ctx.reply(`تمت إضافة الخدمة "${name}" بسعر ${parts[1]} بنجاح.`, { parse_mode: 'Markdown', ...adminKeyboard() });
        }
        const price = priceFrom(text);
        if (price) {
            const desc = text.replace(price, '').trim();
            addOrUpdateService(name, price, desc);
            // backup only on demand now, to keep the bot fast
            await refreshStoreViews(ctx.telegram);
            return ctx.reply(`تمت إضافة الخدمة "${name}" بسعر ${price} بنجاح.`, { parse_mode: 'Markdown', ...adminKeyboard() });
        }
        return ctx.reply(`اسم الخدمة: ${name}\nالوصف: ${text}\n\nأرسل سعر الخدمة:\n\nاكتب /cancel للإلغاء.`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    // Step 1: replying to the name prompt, or a plain text from the admin -> treat as the name
    return ctx.reply(`اسم الخدمة: ${text}\n\nأرسل وصف الخدمة:\n\nاكتب /cancel للإلغاء.`, { parse_mode: 'Markdown', ...Markup.forceReply() });
});

bot.on('photo', async (ctx) => {
    if (isAdmin(ctx)) return;
    const photos = ctx.message.photo || [];
    if (!photos.length) return;
    const fileId = photos[photos.length - 1].file_id;
    const ordersData = loadOrders();
    const uid = String(ctx.from.id);
    let order = ordersData.orders.filter((o) => o.userId === uid && o.status === 'awaiting_proof').slice(-1)[0]
        || ordersData.orders.filter((o) => o.userId === uid && o.status === 'pending' && !o.proofPhoto).slice(-1)[0]
        || ordersData.orders.filter((o) => o.userId === uid && o.status === 'pending').slice(-1)[0];
    if (!order) {
        const recent = ordersData.orders.filter((o) => (o.status === 'awaiting_proof' || (o.status === 'pending' && !o.proofPhoto)) && Date.now() - new Date(o.createdAt || 0).getTime() < 30 * 60 * 1000);
        if (recent.length) order = recent.slice(-1)[0];
    }
    if (order) {
        const wasAwaiting = order.status === 'awaiting_proof';
        order.proofPhoto = fileId;
        if (wasAwaiting) order.status = 'pending';
        saveJSON(ORDERS_FILE, ordersData);
        if (ADMIN_ID) {
            try {
                await ctx.telegram.sendPhoto(ADMIN_ID, fileId, { caption: orderNotifyText(order) + '\n\n🖼️ إثبات دفع مرفق', parse_mode: 'HTML', ...orderActionKeyboard(order) });
            } catch (e) { console.error('Proof notify failed:', e.message); }
        }
        return replyCustomer(ctx, wasAwaiting ? '✅ تم استلام إثبات الدفع، طلبك صار قيد التنفيذ ريثما يتم التأكد من الدفع.' : 'تم استلام إثبات الدفع، رح نتأكد منو ونبلغك.', homeKeyboard());
    }
    const hasOrder = ordersData.orders.some((o) => o.userId === uid);
    if (!hasOrder) {
        return replyCustomer(ctx, 'للتواصل مع الأدمن لازم يكون عندك طلب أولاً.\n\nتصفح الخدمات واطلب اللي بيناسبك، وبعدها بتقدر تراسلنا بخصوص طلبك.', homeKeyboard());
    }
    if (ADMIN_ID) {
        try { await ctx.telegram.sendPhoto(ADMIN_ID, fileId, { caption: `💬 صورة من زبون\n\n${customerLine({ name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '), username: ctx.from.username || '', userId: uid })}`, parse_mode: 'HTML' }); } catch (e) {}
    }
    return replyCustomer(ctx, 'تم إرسال الصورة للأدمن، رح يرد عليك.', homeKeyboard());
});

bot.on('document', async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
        const fileId = ctx.message.document.file_id;
        const link = await ctx.telegram.getFileLink(fileId);
        const res = await fetch(link.href);
        const json = await res.json();
        if (ctx.message.document.file_name.includes('services')) {
            saveJSON(SECTIONS_FILE, json); await refreshStoreViews(ctx.telegram); return ctx.reply('تم استرجاع نسخة الخدمات.');
        }
        if (ctx.message.document.file_name.includes('orders')) {
            saveJSON(ORDERS_FILE, json); return ctx.reply('تم استرجاع نسخة الطلبات.');
        }
        if (ctx.message.document.file_name.includes('config')) {
            saveJSON(CONFIG_FILE, json); return ctx.reply('تم استرجاع نسخة إعدادات الدفع.');
        }
        return ctx.reply('ابعت ملف services-backup.json أو orders-backup.json أو config-backup.json للاسترجاع.');
    } catch (e) { return ctx.reply('ما قدرت اقرأ الملف، تأكد إنو ملف نسخة احتياطية صحيح.'); }
});

const seenUpdates = new Set();
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            const updateId = req.body && req.body.update_id;
            if (updateId != null) {
                if (seenUpdates.has(updateId)) return res.status(200).send('OK');
                seenUpdates.add(updateId);
                if (seenUpdates.size > 1000) seenUpdates.clear();
            }
            await syncFromKV();
            await bot.handleUpdate(req.body);
            await syncToKV();
            return res.status(200).send('OK');
        }
        return res.status(200).send('Muse Code Exchange Store is Live.');
    } catch (err) { return res.status(200).send('OK'); }
};
module.exports.config = { maxDuration: 60 };
module.exports.bot = bot;
