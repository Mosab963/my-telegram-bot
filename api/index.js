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
bot.use(async (ctx, next) => {
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

const DEFAULT_SECTIONS = [{ id: 'sec_offer1', title: 'عرض 1', text: '1 مليار', price: '1$ أو 150 ليرة سورية' }];
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
    const service = { id: 'sec_' + Date.now(), title, price, text };
    data.sections.push(service);
    saveJSON(SECTIONS_FILE, data);
    return { updated: false, service };
}
function loadOrders() { return loadJSON(ORDERS_FILE, { orders: [] }); }
function loadChats() { return loadJSON(CHATS_FILE, { chats: {} }); }
function loadUsers() { return loadJSON(USERS_FILE, { users: {} }); }
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
    return { sections: loadSections(), orders: loadOrders(), config: loadConfig(), chats: loadChats(), users: loadUsers() };
}
function writeLocalState(state) {
    if (state.sections) saveJSON(SECTIONS_FILE, state.sections);
    if (state.orders) saveJSON(ORDERS_FILE, state.orders);
    if (state.config) saveJSON(CONFIG_FILE, state.config);
    if (state.chats) saveJSON(CHATS_FILE, state.chats);
    if (state.users) saveJSON(USERS_FILE, state.users);
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
    rows.push([Markup.button.callback('🗑️ مسح محادثة الزبون', `clear:${o.id}:${from}`)]);
    rows.push([Markup.button.callback('🔙 رجوع للطلبات', from === 'archive' ? 'admin:archive' : 'admin:orders')]);
    rows.push([Markup.button.callback('🏠 لوحة التحكم', 'admin:home')]);
    return Markup.inlineKeyboard(rows);
}
function orderDetailText(o) {
    const status = o.status === 'confirmed' ? '✅ مؤكد' : o.status === 'rejected' ? '❌ مرفوض' : '⏳ بانتظار التأكد من الدفع';
    const tx = o.txNumber ? `\nرقم المعاملة: <code>${escapeHtml(o.txNumber)}</code>` : '\nرقم المعاملة: لم يرسل بعد';
    const time = o.createdAt ? `\nالوقت: ${new Date(o.createdAt).toLocaleString('ar-SY')}` : '';
    return `🧾 <b>تفاصيل الطلب</b>\n\nرقم الطلب: <code>${o.id}</code>\nالخدمة: ${escapeHtml(o.serviceTitle)}\nالسعر: ${escapeHtml(o.price || '-')}${tx}\n${customerLine(o)}${time}\nالحالة: ${status}`;
}

function orderNotifyText(o, extra) {
    const tx = o.txNumber ? `\nرقم المعاملة: <code>${escapeHtml(o.txNumber)}</code>` : '';
    const time = o.createdAt ? `\nالوقت: ${new Date(o.createdAt).toLocaleString('ar-SY')}` : '';
    return `🧾 <b>طلب جديد قيد التنفيذ</b>\n\nرقم الطلب: <code>${o.id}</code>\nالخدمة: ${escapeHtml(o.serviceTitle)}\nالسعر: ${escapeHtml(o.price || '-')}${tx}\n${customerLine(o)}${time}\nالحالة: بانتظار التأكد من الدفع${extra || ''}`;
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
    const rows = sections.map((s) => [Markup.button.callback(s.title, `section:${s.id}`)]);
    rows.push([Markup.button.callback('📦 طلباتي', 'myorders')]);
    if (ADMIN_ID) rows.push([Markup.button.url('💬 تواصل مع الدعم', `tg://user?id=${ADMIN_ID}`)]);
    return Markup.inlineKeyboard(rows);
}
function homeText() {
    const { sections } = loadSections();
    if (!sections.length) return '🛍️ **أهلاً فيك بمتجرنا!**\n\nلسه ما في خدمات معروضة حالياً، تابعنا قريباً.';
    return '🛍️ **أهلاً فيك بمتجرنا!**\n\nتصفح الأقسام من الأزرار تحت، واختار اللي بيناسبك.';
}

bot.catch((err) => console.error('Bot error:', err));

bot.start((ctx) => ctx.reply(homeText(), { parse_mode: 'Markdown', ...homeKeyboard() }));
bot.command('store', (ctx) => ctx.reply(homeText(), { parse_mode: 'Markdown', ...homeKeyboard() }));
bot.command('resetorders', (ctx) => {
    if (!isAdmin(ctx)) return;
    saveJSON(ORDERS_FILE, { orders: [] });
    return ctx.reply('تم تصفير الطلبات، البوت صار نظيف، ما في طلبات معلقة.', { parse_mode: 'Markdown', ...adminKeyboard() });
});
bot.command('cancel', (ctx) => {
    if (isAdmin(ctx)) return ctx.reply('تم الإلغاء، رجعت للوحة التحكم.', { parse_mode: 'Markdown', ...adminKeyboard() });
    return ctx.reply('تم الإلغاء، رجعت للقائمة الرئيسية.', { parse_mode: 'Markdown', ...homeKeyboard() });
});
bot.action('cancel', async (ctx) => {
    await safeAnswer(ctx, 'تم الإلغاء');
    if (isAdmin(ctx)) return showAdminView(ctx, adminText(), adminKeyboard());
    return safeEdit(ctx, homeText(), homeKeyboard());
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
bot.command('addservice', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    const args = ctx.message.text.replace(/^\/addservice\s*/, '').trim();
    const parts = args.split('|').map((s) => s.trim());
    if (parts.length < 3 || !parts[0] || !parts[1]) {
        return ctx.reply('الصيغة الصحيحة:\n`/addservice عرض 1 | 1$ | 5 صفحات إكسل`', { parse_mode: 'Markdown' });
    }
    const res = addOrUpdateService(parts[0], parts[1], parts.slice(2).join(' | '));
    if (res.updated) return ctx.reply(`الخدمة "${parts[0]}" موجودة مسبقاً، حدثتها بدل ما تتكرر.`, { parse_mode: 'Markdown', ...adminKeyboard() });
    return ctx.reply(`تمت إضافة الخدمة "${parts[0]}" بسعر ${parts[1]} بنجاح.`, { parse_mode: 'Markdown', ...adminKeyboard() });
});
bot.command('delservice', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    const n = parseInt(ctx.message.text.replace(/^\/delservice\s*/, '').trim(), 10) - 1;
    const data = loadSections();
    if (isNaN(n) || !data.sections[n]) return ctx.reply('الصيغة: /delservice 1');
    const removed = data.sections.splice(n, 1)[0];
    saveJSON(SECTIONS_FILE, data);
    return ctx.reply(`تم حذف الخدمة "${removed.title}".`, { parse_mode: 'Markdown', ...adminKeyboard() });
});
bot.command('setprice', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    const args = ctx.message.text.replace(/^\/setprice\s*/, '').trim();
    const parts = args.split('|').map((s) => s.trim());
    const n = parseInt(parts[0], 10) - 1;
    const data = loadSections();
    if (isNaN(n) || !data.sections[n] || !parts[1]) return ctx.reply('الصيغة: /setprice 1 | 2$');
    data.sections[n].price = parts[1];
    saveJSON(SECTIONS_FILE, data);
    return ctx.reply('تم تعديل السعر.', { parse_mode: 'Markdown', ...adminKeyboard() });
});
bot.command('edittext', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    const args = ctx.message.text.replace(/^\/edittext\s*/, '').trim();
    const parts = args.split('|').map((s) => s.trim());
    const n = parseInt(parts[0], 10) - 1;
    const data = loadSections();
    if (isNaN(n) || !data.sections[n] || !parts[1]) return ctx.reply('الصيغة: /edittext 1 | النص الجديد');
    data.sections[n].text = parts.slice(1).join(' | ');
    saveJSON(SECTIONS_FILE, data);
    return ctx.reply('تم تعديل النص.', { parse_mode: 'Markdown', ...adminKeyboard() });
});
bot.command('setpayment', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    const args = ctx.message.text.replace(/^\/setpayment\s*/, '').trim();
    if (!args) return ctx.reply('الصيغة: /setpayment معلومات الدفع الجديدة');
    const cfg = loadConfig();
    cfg.paymentInfo = args;
    saveJSON(CONFIG_FILE, cfg);
    return ctx.reply('تم تعديل معلومات الدفع.', { parse_mode: 'Markdown', ...adminKeyboard() });
});


bot.command('myorders', (ctx) => {
    const { orders } = loadOrders();
    const mine = orders.filter((o) => o.userId === String(ctx.from.id));
    if (!mine.length) return ctx.reply('لسه ما عندك طلبات.', { parse_mode: 'Markdown', ...homeKeyboard() });
    const list = mine.slice(-10).map((o) => `• ${o.serviceTitle} - ${o.price || ''} - ${o.status === 'pending' ? 'قيد التنفيذ، بانتظار التأكد من الدفع' : o.status === 'confirmed' ? 'تم تأكيد الدفع' : 'مرفوض'}`).join('\n');
    return ctx.reply('📦 **طلباتي:**\n\n' + list, { parse_mode: 'Markdown', ...homeKeyboard() });
});

bot.action('myorders', async (ctx) => {
    await safeAnswer(ctx);
    const { orders } = loadOrders();
    const mine = orders.filter((o) => o.userId === String(ctx.from.id));
    if (!mine.length) return safeEdit(ctx, '📦 **طلباتي**\n\nلسه ما عندك طلبات.', homeKeyboard());
    const list = mine.slice(-10).map((o) => `• ${o.serviceTitle} - ${o.price || ''} - ${o.txNumber ? 'معاملة: `' + o.txNumber + '` - ' : ''}${o.status === 'pending' ? 'قيد التنفيذ، بانتظار التأكد من الدفع' : o.status === 'confirmed' ? 'تم تأكيد الدفع' : 'مرفوض'}`).join('\n');
    await safeAnswer(ctx, `عندك ${mine.length} طلبات`);
    const ok = await safeEdit(ctx, '📦 **طلباتي:**\n\n' + list, homeKeyboard());
    if (!ok) return ctx.reply('📦 **طلباتي:**\n\n' + list, { parse_mode: 'Markdown', ...homeKeyboard() });
    return ok;
});

bot.action('home', async (ctx) => {
    await safeAnswer(ctx);
    return safeEdit(ctx, homeText(), homeKeyboard());
});

bot.action(/^section:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const { sections } = loadSections();
    const sec = sections.find((s) => s.id === id);
    await safeAnswer(ctx);
    if (!sec) return safeEdit(ctx, 'هاد القسم مو موجود.', homeKeyboard());
    const priceLine = sec.price ? `\n💰 السعر: ${sec.price}` : '';
    return safeEdit(ctx, `**${sec.title}**\n\n${sec.text || ''}${priceLine}`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ تأكيد الطلب', `order:${sec.id}`)],
        [Markup.button.callback('❌ إلغاء', 'cancel')],
        [Markup.button.callback('🔙 رجوع', 'home')]
    ]));
});

bot.action(/^order:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const { sections } = loadSections();
    const sec = sections.find((s) => s.id === id);
    await safeAnswer(ctx);
    if (!sec) return safeEdit(ctx, 'هاد القسم مو موجود.', homeKeyboard());
    const cfg = loadConfig();
    const priceLine = sec.price ? `\n💰 السعر: ${sec.price}` : '';
    return safeEdit(ctx,
        `💳 **صفحة الدفع**\n\n**${sec.title}**${priceLine}\n\n${cfg.paymentInfo}`,
        Markup.inlineKeyboard([
            [Markup.button.callback('💳 تأكيد الدفع', `pay:${sec.id}`)],
            [Markup.button.callback('❌ إلغاء', 'home')]
        ]));
});

bot.action(/^pay:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const { sections } = loadSections();
    const sec = sections.find((s) => s.id === id);
    await safeAnswer(ctx, 'أرسل رقم المعاملة');
    if (!sec) return safeEdit(ctx, 'هاد القسم مو موجود.', homeKeyboard());
    // Reset: drop this user's stale pending orders without a tx number,
    // then create ONE fresh order and finish the flow right here. The
    // transaction number is optional afterwards, not a blocker.
    const ordersData = loadOrders();
    ordersData.orders = ordersData.orders.filter((o) => !(o.userId === String(ctx.from.id) && o.status === 'pending' && !o.txNumber));
    const order = {
        id: 'ord_' + Date.now(), serviceId: sec.id, serviceTitle: sec.title, price: sec.price || '',
        userId: String(ctx.from.id), username: ctx.from.username || '',
        name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
        status: 'pending', txNumber: '', createdAt: new Date().toISOString()
    };
    ordersData.orders.push(order);
    saveJSON(ORDERS_FILE, ordersData);
    const orderId = order.id;
    if (ADMIN_ID) {
        try {
            await ctx.telegram.sendMessage(ADMIN_ID, orderNotifyText(order),
                { parse_mode: 'HTML', ...orderActionKeyboard(order) });
        } catch (e) { console.error('Admin notify failed:', e && e.message); }
    }
    // Edit the SAME payment message in place to ask for the transaction number.
    return safeEdit(ctx,
        `⏳ **تم استلام طلبك، الطلب قيد التنفيذ ريثما يتم التأكد من الدفع.**\n\nالخدمة: ${sec.title}\nالسعر: ${sec.price || ''}\nرقم الطلب: \`${orderId}\`\n\nإذا بدك، أرسل رقم المعاملة:`,
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
    try { await ctx.telegram.sendMessage(order.userId, `✅ تم تأكيد الدفع واستلام طلبك: ${order.serviceTitle}\n\nطلبك قيد التنفيذ، شكراً لثقتك.`); } catch (e) {}
    const nav = (ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.reply_markup && JSON.stringify(ctx.callbackQuery.message.reply_markup).includes('admin:orders'));
    return safeEditHtml(ctx, orderDetailText(order), nav ? orderDetailKeyboard(order, 'orders') : orderActionKeyboard(order));
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
    try { await ctx.telegram.sendMessage(order.userId, `❌ تم رفض طلبك: ${order.serviceTitle}\n\nتواصل مع الأدمن للتفاصيل.`); } catch (e) {}
    const nav = (ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.reply_markup && JSON.stringify(ctx.callbackQuery.message.reply_markup).includes('admin:orders'));
    return safeEditHtml(ctx, orderDetailText(order), nav ? orderDetailKeyboard(order, 'orders') : orderActionKeyboard(order));
});

function adminKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('➕ إضافة خدمة / قسم', 'admin:add_section')],
        [Markup.button.callback('✏️ تعديل نص خدمة', 'admin:edit_section')],
        [Markup.button.callback('💰 تعديل سعر خدمة', 'admin:edit_price')],
        [Markup.button.callback('🗑️ حذف خدمة', 'admin:del_section')],
        [Markup.button.callback('📋 عرض الخدمات', 'admin:list_sections')],
        [Markup.button.callback('🧾 عرض الطلبات', 'admin:orders')],
        [Markup.button.callback('📦 أرشيف الطلبات', 'admin:archive')],
        [Markup.button.callback('👥 المستخدمين', 'admin:users')],
        [Markup.button.callback('💳 تعديل معلومات الدفع', 'admin:set_payment')],
        [Markup.button.callback('📊 إحصائيات', 'admin:stats')],
        [Markup.button.callback('💾 نسخة احتياطية', 'admin:backup')],
        [Markup.button.callback('🏠 الرئيسية', 'home')]
    ]);
}
function adminText() {
    return '👑 <b>لوحة تحكم الأدمن</b>\n\nمن هون بتضيف خدمة، وبتعدل نصها وسعرها، وبتحذفها، وبتعدل معلومات الدفع، وبتشوف الطلبات وبتأكد الدفع. النسخة الاحتياطية بتاخدها من زر نسخة احتياطية وقت ما بدك.';
}

bot.action('admin:home', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    return showAdminView(ctx, adminText(), adminKeyboard());
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
    if (!sections.length) return showAdminView(ctx, 'لسه ما في خدمات، ضيف أول خدمة من زر إضافة خدمة.', adminKeyboard());
    return showAdminView(ctx, '📋 <b>الخدمات:</b>\n\n' + sections.map((s, i) => `${i + 1}. ${escapeHtml(s.title)}\n${escapeHtml(s.text || '')}\nالسعر: ${escapeHtml(s.price || '-')}`).join('\n\n'), adminKeyboard());
});
bot.action('admin:orders', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { orders } = loadOrders();
    await safeAnswer(ctx);
    if (!orders.length) return showAdminView(ctx, 'لسه ما في طلبات.', adminKeyboard());
    const recent = orders.filter((o) => o.status === 'pending').slice(-10);
    if (!recent.length) return showAdminView(ctx, 'ما في طلبات بانتظار التأكد، كل الطلبات المؤكدة والمرفوضة صارت بالأرشيف.', Markup.inlineKeyboard([[Markup.button.callback('📦 أرشيف الطلبات', 'admin:archive')], [Markup.button.callback('🔙 رجوع للوحة التحكم', 'admin:home')]]));
    const list = recent.map((o, i) => {
        return `${i + 1}. ${escapeHtml(o.serviceTitle)} - ${escapeHtml(o.price || '')} - ⏳ بانتظار التأكد${o.txNumber ? ' - معاملة: ' + escapeHtml(o.txNumber) : ''}\n   ${customerLine(o).replace(/\n/g, ' | ')}`;
    }).join('\n\n');
    const rows = recent.map((o, i) => [Markup.button.callback(`${i + 1}. ${o.serviceTitle} - بانتظار التأكد`, `admin:order:${o.id}`)]);
    rows.push([Markup.button.callback('📦 أرشيف الطلبات', 'admin:archive')]);
    rows.push([Markup.button.callback('🔙 رجوع للوحة التحكم', 'admin:home')]);
    return showAdminView(ctx, '🧾 <b>الطلبات بانتظار التأكد:</b>\n\n' + list + '\n\nكبس على رقم الطلب مشان تفتح تفاصيلو وتديره.', Markup.inlineKeyboard(rows));
});
bot.action('admin:archive', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { orders } = loadOrders();
    await safeAnswer(ctx);
    const done = orders.filter((o) => o.status !== 'pending').slice(-20);
    if (!done.length) return showAdminView(ctx, 'الأرشيف فاضي، لسه ما في طلبات مؤكدة أو مرفوضة.', Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع للطلبات', 'admin:orders')], [Markup.button.callback('🏠 لوحة التحكم', 'admin:home')]]));
    const list = done.map((o, i) => {
        const status = o.status === 'confirmed' ? '✅ مؤكد' : '❌ مرفوض';
        return `${i + 1}. ${escapeHtml(o.serviceTitle)} - ${escapeHtml(o.price || '')} - ${status}${o.txNumber ? ' - معاملة: ' + escapeHtml(o.txNumber) : ''}\n   ${customerLine(o).replace(/\n/g, ' | ')}`;
    }).join('\n\n');
    const rows = done.map((o, i) => [Markup.button.callback(`${i + 1}. ${o.serviceTitle} - ${o.status === 'confirmed' ? 'مؤكد' : 'مرفوض'}`, `admin:archive:${o.id}`)]);
    rows.push([Markup.button.callback('🔙 رجوع للطلبات', 'admin:orders')]);
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
    const ordersList = myOrders.length ? myOrders.map((o, i) => `${i + 1}. ${escapeHtml(o.serviceTitle)} - ${o.price || ''} - ${o.status === 'confirmed' ? '✅ مؤكد' : o.status === 'rejected' ? '❌ مرفوض' : '⏳ بانتظار التأكد'}`).join('\n') : 'ما عندو طلبات بعد.';
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

bot.action('admin:set_payment', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    return showAdminView(ctx, '💳 <b>تعديل معلومات الدفع</b>\n\nأرسل أمر واحد بهالشكل:\n<code>/setpayment معلومات الدفع الجديدة</code>\n\nالمعلومات الحالية:\n' + escapeHtml(loadConfig().paymentInfo.replace(/`/g, '')), adminPromptKeyboard());
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
    return showAdminView(ctx, `📊 <b>إحصائيات شاملة:</b>\n\n👥 <b>المستخدمون:</b> ${users.length} (جدد اليوم: ${newToday})\n🧾 <b>الطلبات:</b> ${orders.length}\n⏳ بانتظار التأكد: ${pendingCount}\n✅ مكتملة (مؤكدة): ${confirmedCount}\n❌ مرفوضة: ${rejectedCount}\n📋 <b>الخدمات:</b> ${sections}`, adminKeyboard());
});
bot.action('admin:backup', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    await backupToAdmin(ctx);
    return showAdminView(ctx, 'تم إرسال النسخة الاحتياطية على الخاص.', adminKeyboard());
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
        let serviceId = '';
        if (replied.includes('أرسل رقم المعاملة')) {
            const m = replied.match(/معرف الخدمة:\s*(\S+)/);
            serviceId = m ? m[1].trim() : '';
        }
        // Fallback: a plain transaction number from a user with a recent pending order
        // (this is the common case - the user just types the number, without replying)
        if (!serviceId) {
            const ordersData = loadOrders();
            let pendingOrder = ordersData.orders.filter((o) => o.userId === String(ctx.from.id) && o.status === 'pending' && !o.txNumber).slice(-1)[0];
            // Forgiving fallback: the transaction number was sometimes sent
            // from a different account/device than the one that clicked
            // Confirm Payment. If this sender has no pending order, but
            // there is a single recent pending order without a tx number
            // (last 30 minutes), attach the number to it instead of
            // leaving the user stuck. The admin is told the sender id.
            let senderMismatch = false;
            if (!pendingOrder) {
                const recent = ordersData.orders.filter((o) => o.status === 'pending' && !o.txNumber && Date.now() - new Date(o.createdAt || 0).getTime() < 30 * 60 * 1000);
                if (recent.length) { pendingOrder = recent.slice(-1)[0]; senderMismatch = true; }
            }
            if (pendingOrder && /^[A-Za-z0-9_-]{3,}$/.test(text)) {
                pendingOrder.txNumber = text;
                saveJSON(ORDERS_FILE, ordersData);
                if (ADMIN_ID) {
                    try {
                        await ctx.telegram.sendMessage(ADMIN_ID,
                            `🧾 **طلب جديد قيد التنفيذ**\n\nرقم الطلب: \`${pendingOrder.id}\`\nالخدمة: ${pendingOrder.serviceTitle}\nالسعر: ${pendingOrder.price || '-'}\nرقم المعاملة: \`${text}\`\nالزبون: ${pendingOrder.name} (@${pendingOrder.username || 'بدون معرف'})\nآيدي الزبون: \`${pendingOrder.userId}\`${senderMismatch ? `\nتنبيه: رقم المعاملة انبعت من حساب تاني، آيدي المرسل: \`${ctx.from.id}\`` : ''}\nالحالة: بانتظار التأكد من الدفع`,
                            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
                                [Markup.button.callback('✅ تأكيد الدفع واستلام الطلب', `approve:${pendingOrder.id}`)],
                                [Markup.button.callback('❌ رفض الطلب', `reject:${pendingOrder.id}`)]
                            ]) });
                    } catch (e) {}
                }
                return ctx.reply(`⏳ **تم استلام طلبك، الطلب قيد التنفيذ ريثما يتم التأكد من الدفع.**\n\nالخدمة: ${pendingOrder.serviceTitle}\nرقم الطلب: \`${pendingOrder.id}\`\nرقم المعاملة: \`${text}\`\n\nرح نبلغك بس نتأكد من الدفع.`, { parse_mode: 'Markdown', ...homeKeyboard() });
            }
            // Only customers with an order can message the admin. Anyone else
            // gets a polite reply pointing them to order first, and nothing
            // is forwarded, so random messages never reach the admin.
            const hasOrder = ordersData.orders.some((o) => o.userId === String(ctx.from.id));
            if (!hasOrder) {
                return ctx.reply('للتواصل مع الأدمن لازم يكون عندك طلب أولاً.\n\nتصفح الخدمات واطلب اللي بيناسبك، وبعدها بتقدر تراسلنا بخصوص طلبك.', { parse_mode: 'Markdown', ...homeKeyboard() });
            }
            if (ADMIN_ID && text.length >= 3) {
                try { await ctx.telegram.sendMessage(ADMIN_ID, `💬 رسالة من زبون\n\n${customerLine({ name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '), username: ctx.from.username || '', userId: String(ctx.from.id) })}\n\nالرسالة: ${escapeHtml(text)}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.url('فتح محادثة الزبون', `tg://user?id=${ctx.from.id}`)]]) }); } catch (e) {}
            }
            return ctx.reply('تم إرسال رسالتك للأدمن، رح يرد عليك.', { parse_mode: 'Markdown', ...homeKeyboard() });
        }
        const { sections } = loadSections();
        const sec = sections.find((s) => s.id === serviceId);
        if (!sec) return ctx.reply('الخدمة مو موجودة، ابدأ من جديد بأمر /start');
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
                await ctx.telegram.sendMessage(ADMIN_ID,
                    `🧾 **طلب جديد قيد التنفيذ**\n\nرقم الطلب: \`${orderId}\`\nالخدمة: ${sec.title}\nالسعر: ${sec.price || '-'}\nرقم المعاملة: \`${text}\`\nالزبون: ${order.name} (@${order.username || 'بدون معرف'})\nآيدي الزبون: \`${order.userId}\`\nالحالة: بانتظار التأكد من الدفع`,
                    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ تأكيد الدفع واستلام الطلب', `approve:${orderId}`)],
                        [Markup.button.callback('❌ رفض الطلب', `reject:${orderId}`)]
                    ]) });
            } catch (e) { console.error('Admin notify failed:', e.message); }
        }
        return ctx.reply(`⏳ **تم استلام طلبك، الطلب قيد التنفيذ ريثما يتم التأكد من الدفع.**\n\nالخدمة: ${sec.title}\nرقم الطلب: \`${orderId}\`\nرقم المعاملة: \`${text}\`\n\nرح نبلغك بس نتأكد من الدفع.`, { parse_mode: 'Markdown', ...homeKeyboard() });
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
            await ctx.telegram.sendMessage(order.userId, `💬 رسالة من المتجر بخصوص طلبك (${order.serviceTitle}):\n\n${text}`);
            return ctx.reply(`تم إرسال رسالتك للزبون ${order.name || order.userId}.`, { parse_mode: 'Markdown', ...adminKeyboard() });
        } catch (e) {
            return ctx.reply('ما قدرت ابعت الرسالة للزبون، يمكن حظر البوت أو ما فتح المحادثة معه بعد.');
        }
    }
    // Step 3: replying to the price prompt -> create the service
    if (replied.includes('أرسل سعر الخدمة')) {
        const name = parseField(replied, 'اسم الخدمة');
        const desc = parseField(replied, 'الوصف');
        if (!name) return ctx.reply('ما لقيت اسم الخدمة، ابدأ من جديد بزر إضافة خدمة.');
        addOrUpdateService(name, text, desc);
        // backup only on demand now, to keep the bot fast

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

            return ctx.reply(`تمت إضافة الخدمة "${name}" بسعر ${parts[1]} بنجاح.`, { parse_mode: 'Markdown', ...adminKeyboard() });
        }
        const price = priceFrom(text);
        if (price) {
            const desc = text.replace(price, '').trim();
            addOrUpdateService(name, price, desc);
            // backup only on demand now, to keep the bot fast

            return ctx.reply(`تمت إضافة الخدمة "${name}" بسعر ${price} بنجاح.`, { parse_mode: 'Markdown', ...adminKeyboard() });
        }
        return ctx.reply(`اسم الخدمة: ${name}\nالوصف: ${text}\n\nأرسل سعر الخدمة:\n\nاكتب /cancel للإلغاء.`, { parse_mode: 'Markdown', ...Markup.forceReply() });
    }
    // Step 1: replying to the name prompt, or a plain text from the admin -> treat as the name
    return ctx.reply(`اسم الخدمة: ${text}\n\nأرسل وصف الخدمة:\n\nاكتب /cancel للإلغاء.`, { parse_mode: 'Markdown', ...Markup.forceReply() });
});

bot.on('document', async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
        const fileId = ctx.message.document.file_id;
        const link = await ctx.telegram.getFileLink(fileId);
        const res = await fetch(link.href);
        const json = await res.json();
        if (ctx.message.document.file_name.includes('services')) {
            saveJSON(SECTIONS_FILE, json); return ctx.reply('تم استرجاع نسخة الخدمات.');
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
