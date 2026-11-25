const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID).trim() : null;

const CODES_FILE = './codes.json';
const SECTIONS_FILE = './services.json';
const ORDERS_FILE = './orders.json';
const CONFIG_FILE = './config.json';

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
    if (!KV_URL || !KV_TOKEN) return null;
    try {
        const r = await fetch(KV_URL + '/get/' + KV_KEY, { headers: { Authorization: 'Bearer ' + KV_TOKEN } });
        const j = await r.json();
        return j && j.result ? JSON.parse(j.result) : null;
    } catch (e) { return null; }
}
async function kvSet(state) {
    if (!KV_URL || !KV_TOKEN) return false;
    try {
        const r = await fetch(KV_URL + '/set/' + KV_KEY + '/' + encodeURIComponent(JSON.stringify(state)), {
            method: 'POST', headers: { Authorization: 'Bearer ' + KV_TOKEN }
        });
        return r.ok;
    } catch (e) { return false; }
}
function readLocalState() {
    return { sections: loadSections(), orders: loadOrders(), config: loadConfig() };
}
function writeLocalState(state) {
    if (state.sections) saveJSON(SECTIONS_FILE, state.sections);
    if (state.orders) saveJSON(ORDERS_FILE, state.orders);
    if (state.config) saveJSON(CONFIG_FILE, state.config);
}
async function syncFromKV() {
    if (!KV_URL || !KV_TOKEN) return;
    const state = await kvGet();
    if (state && (state.sections || state.orders || state.config)) {
        writeLocalState(state);
    } else {
        // First run with KV: seed it from the local (committed) files.
        await kvSet(readLocalState());
    }
}
async function syncToKV() {
    if (!KV_URL || !KV_TOKEN) return;
    await kvSet(readLocalState());
}

function isAdmin(ctx) { return ADMIN_ID && String(ctx.from.id) === ADMIN_ID; }

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
bot.command('cancel', (ctx) => {
    if (isAdmin(ctx)) return ctx.reply('تم الإلغاء، رجعت للوحة التحكم.', { parse_mode: 'Markdown', ...adminKeyboard() });
    return ctx.reply('تم الإلغاء، رجعت للقائمة الرئيسية.', { parse_mode: 'Markdown', ...homeKeyboard() });
});
bot.action('cancel', async (ctx) => {
    await safeAnswer(ctx, 'تم الإلغاء');
    if (isAdmin(ctx)) return safeEdit(ctx, adminText(), adminKeyboard());
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
    // Create the pending order NOW, so the next plain message from the user
    // (reply or not) can be recognised as the transaction number.
    const ordersData = loadOrders();
    const orderId = 'ord_' + Date.now();
    const order = {
        id: orderId, serviceId: sec.id, serviceTitle: sec.title, price: sec.price || '',
        userId: String(ctx.from.id), username: ctx.from.username || '',
        name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
        status: 'pending', txNumber: '', createdAt: new Date().toISOString()
    };
    ordersData.orders.push(order);
    saveJSON(ORDERS_FILE, ordersData);
    // Edit the SAME payment message in place to ask for the transaction number.
    return safeEdit(ctx,
        `💳 **تأكيد الدفع**\n\nالخدمة: ${sec.title}\nالسعر: ${sec.price || ''}\nرقم الطلب: \`${orderId}\`\n\nأرسل رقم المعاملة:`,
        Markup.inlineKeyboard([
            [Markup.button.callback('❌ إلغاء الطلب', 'cancel')]
        ]));
});

bot.action(/^approve:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const orderId = ctx.match[1];
    const data = loadOrders();
    const order = data.orders.find((o) => o.id === orderId);
    await safeAnswer(ctx, 'تم التأكيد');
    if (!order) return safeEdit(ctx, 'الطلب مو موجود.');
    order.status = 'confirmed';
    saveJSON(ORDERS_FILE, data);
    try { await ctx.telegram.sendMessage(order.userId, `✅ تم تأكيد الدفع واستلام طلبك: ${order.serviceTitle}\n\nطلبك قيد التنفيذ، شكراً لثقتك.`); } catch (e) {}
    return safeEdit(ctx, `✅ تم تأكيد الدفع للطلب \`${orderId}\`، وبلغت الزبون.`);
});
bot.action(/^reject:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const orderId = ctx.match[1];
    const data = loadOrders();
    const order = data.orders.find((o) => o.id === orderId);
    await safeAnswer(ctx, 'تم الرفض');
    if (!order) return safeEdit(ctx, 'الطلب مو موجود.');
    order.status = 'rejected';
    saveJSON(ORDERS_FILE, data);
    try { await ctx.telegram.sendMessage(order.userId, `❌ تم رفض طلبك: ${order.serviceTitle}\n\nتواصل مع الأدمن للتفاصيل.`); } catch (e) {}
    return safeEdit(ctx, `❌ تم رفض الطلب \`${orderId}\`، وبلغت الزبون.`);
});

function adminKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('➕ إضافة خدمة / قسم', 'admin:add_section')],
        [Markup.button.callback('✏️ تعديل نص خدمة', 'admin:edit_section')],
        [Markup.button.callback('💰 تعديل سعر خدمة', 'admin:edit_price')],
        [Markup.button.callback('🗑️ حذف خدمة', 'admin:del_section')],
        [Markup.button.callback('📋 عرض الخدمات', 'admin:list_sections')],
        [Markup.button.callback('🧾 عرض الطلبات', 'admin:orders')],
        [Markup.button.callback('💳 تعديل معلومات الدفع', 'admin:set_payment')],
        [Markup.button.callback('📊 إحصائيات', 'admin:stats')],
        [Markup.button.callback('💾 نسخة احتياطية', 'admin:backup')],
        [Markup.button.callback('🏠 الرئيسية', 'home')]
    ]);
}
function adminText() {
    return '👑 **لوحة تحكم الأدمن**\n\nمن هون بتضيف خدمة، وبتعدل نصها وسعرها، وبتحذفها، وبتعدل معلومات الدفع، وبتشوف الطلبات وبتأكد الدفع. النسخة الاحتياطية بتاخدها من زر نسخة احتياطية وقت ما بدك.';
}

bot.command('admin', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    return ctx.reply(adminText(), { parse_mode: 'Markdown', ...adminKeyboard() });
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
    return safeEdit(ctx, '✏️ **تعديل نص خدمة**\n\nأرسل أمر واحد بهالشكل:\n`/edittext 1 | النص الجديد`\n\nالخدمات:\n' + (sections.map((s, i) => `${i + 1}. ${s.title}`).join('\n') || 'لا يوجد خدمات'), adminPromptKeyboard());
});
bot.action('admin:edit_price', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    await safeAnswer(ctx);
    return safeEdit(ctx, '💰 **تعديل سعر خدمة**\n\nأرسل أمر واحد بهالشكل:\n`/setprice 1 | 2$`\n\nالخدمات:\n' + (sections.map((s, i) => `${i + 1}. ${s.title} - ${s.price || 'بدون سعر'}`).join('\n') || 'لا يوجد خدمات'), adminPromptKeyboard());
});
bot.action('admin:del_section', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    await safeAnswer(ctx);
    return safeEdit(ctx, '🗑️ **حذف خدمة**\n\nأرسل أمر واحد بهالشكل:\n`/delservice 1`\n\nالخدمات:\n' + (sections.map((s, i) => `${i + 1}. ${s.title}`).join('\n') || 'لا يوجد خدمات'), adminPromptKeyboard());
});
bot.action('admin:list_sections', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    await safeAnswer(ctx);
    if (!sections.length) return safeEdit(ctx, 'لسه ما في خدمات، ضيف أول خدمة من زر إضافة خدمة.', adminKeyboard());
    return safeEdit(ctx, '📋 **الخدمات:**\n\n' + sections.map((s, i) => `${i + 1}. ${s.title}\n${s.text || ''}\nالسعر: ${s.price || '-'}`).join('\n\n'), adminKeyboard());
});
bot.action('admin:orders', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { orders } = loadOrders();
    await safeAnswer(ctx);
    if (!orders.length) return safeEdit(ctx, 'لسه ما في طلبات.', adminKeyboard());
    const list = orders.slice(-10).map((o) => `${o.id} - ${o.serviceTitle} - ${o.price || ''} - ${o.status} - @${o.username || o.userId}`).join('\n');
    return safeEdit(ctx, '🧾 **آخر الطلبات:**\n\n' + list, adminKeyboard());
});
bot.action('admin:set_payment', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    return safeEdit(ctx, '💳 **تعديل معلومات الدفع**\n\nأرسل أمر واحد بهالشكل:\n`/setpayment معلومات الدفع الجديدة`\n\nالمعلومات الحالية:\n' + loadConfig().paymentInfo, adminPromptKeyboard());
});
bot.action('admin:stats', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const sections = loadSections().sections.length;
    const orders = loadOrders().orders;
    const pendingCount = orders.filter((o) => o.status === 'pending').length;
    await safeAnswer(ctx);
    return safeEdit(ctx, `📊 **إحصائيات:**\n\nعدد الخدمات: ${sections}\nعدد الطلبات: ${orders.length}\nطلبات بانتظار التأكد: ${pendingCount}`, adminKeyboard());
});
bot.action('admin:backup', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await safeAnswer(ctx);
    await backupToAdmin(ctx);
    return safeEdit(ctx, 'تم إرسال النسخة الاحتياطية على الخاص.', adminKeyboard());
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
            const pendingOrder = ordersData.orders.filter((o) => o.userId === String(ctx.from.id) && o.status === 'pending' && !o.txNumber).slice(-1)[0];
            if (pendingOrder && text.length >= 3) {
                pendingOrder.txNumber = text;
                saveJSON(ORDERS_FILE, ordersData);
                if (ADMIN_ID) {
                    try {
                        await ctx.telegram.sendMessage(ADMIN_ID,
                            `🧾 **طلب جديد قيد التنفيذ**\n\nرقم الطلب: \`${pendingOrder.id}\`\nالخدمة: ${pendingOrder.serviceTitle}\nالسعر: ${pendingOrder.price || '-'}\nرقم المعاملة: \`${text}\`\nالزبون: ${pendingOrder.name} (@${pendingOrder.username || 'بدون معرف'})\nآيدي الزبون: \`${pendingOrder.userId}\`\nالحالة: بانتظار التأكد من الدفع`,
                            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
                                [Markup.button.callback('✅ تأكيد الدفع واستلام الطلب', `approve:${pendingOrder.id}`)],
                                [Markup.button.callback('❌ رفض الطلب', `reject:${pendingOrder.id}`)]
                            ]) });
                    } catch (e) {}
                }
                return ctx.reply(`⏳ **تم استلام طلبك، الطلب قيد التنفيذ ريثما يتم التأكد من الدفع.**\n\nالخدمة: ${pendingOrder.serviceTitle}\nرقم الطلب: \`${pendingOrder.id}\`\nرقم المعاملة: \`${text}\`\n\nرح نبلغك بس نتأكد من الدفع.`, { parse_mode: 'Markdown', ...homeKeyboard() });
            }
            return ctx.reply('أرسل رقم المعاملة أولاً، بعد ما تكبس تأكيد الدفع من صفحة الدفع.', { parse_mode: 'Markdown', ...homeKeyboard() });
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
