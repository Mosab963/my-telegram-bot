const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID).trim() : null;

const CODES_FILE = './codes.json';
const SECTIONS_FILE = './services.json';
const ORDERS_FILE = './orders.json';
const CONFIG_FILE = './config.json';
const PENDING_FILE = './pending.json';

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

const DEFAULT_SECTIONS = [];
const DEFAULT_CONFIG = { paymentInfo: 'للدفع تواصل مع الأدمن لتأكيد طريقة الدفع.' };

function loadCodes() { return loadJSON(CODES_FILE, { codes: [] }); }
function loadSections() { return loadJSON(SECTIONS_FILE, { sections: DEFAULT_SECTIONS }); }
function loadOrders() { return loadJSON(ORDERS_FILE, { orders: [] }); }
function loadConfig() { return loadJSON(CONFIG_FILE, DEFAULT_CONFIG); }
function loadPending() { return loadJSON(PENDING_FILE, {}); }
function savePending(p) { saveJSON(PENDING_FILE, p); }

async function backupToAdmin(ctx) {
    if (!ADMIN_ID) return;
    try {
        await ctx.telegram.sendDocument(ADMIN_ID, { source: Buffer.from(JSON.stringify(loadSections(), null, 2)), filename: 'services-backup.json' }, { caption: 'نسخة احتياطية من الخدمات - احتفظ فيها' });
        await ctx.telegram.sendDocument(ADMIN_ID, { source: Buffer.from(JSON.stringify(loadOrders(), null, 2)), filename: 'orders-backup.json' }, { caption: 'نسخة احتياطية من الطلبات - احتفظ فيها' });
        await ctx.telegram.sendDocument(ADMIN_ID, { source: Buffer.from(JSON.stringify(loadConfig(), null, 2)), filename: 'config-backup.json' }, { caption: 'نسخة احتياطية من إعدادات الدفع - احتفظ فيها' });
    } catch (e) { console.error('Backup failed:', e.message); }
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
    const p = loadPending(); delete p[String(ctx.from.id)]; savePending(p);
    return ctx.reply('تم الإلغاء، رجعت للقائمة الرئيسية.', { parse_mode: 'Markdown', ...homeKeyboard() });
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
    const list = mine.slice(-10).map((o) => `• ${o.serviceTitle} - ${o.price || ''} - ${o.status === 'pending' ? 'قيد التنفيذ، بانتظار التأكد من الدفع' : o.status === 'confirmed' ? 'تم تأكيد الدفع' : 'مرفوض'}`).join('\n');
    return safeEdit(ctx, '📦 **طلباتي:**\n\n' + list, homeKeyboard());
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
        `💳 **صفحة الدفع**\n\n**${sec.title}**${priceLine}\n\n${cfg.paymentInfo}\n\nبعد ما تدفع، كبس زر تأكيد الدفع تحت.`,
        Markup.inlineKeyboard([
            [Markup.button.callback('💳 تأكيد الدفع', `pay:${sec.id}`)],
            [Markup.button.callback('❌ إلغاء', 'home')]
        ]));
});

bot.action(/^pay:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const { sections } = loadSections();
    const sec = sections.find((s) => s.id === id);
    await safeAnswer(ctx);
    if (!sec) return safeEdit(ctx, 'هاد القسم مو موجود.', homeKeyboard());
    const ordersData = loadOrders();
    const orderId = 'ord_' + Date.now();
    const order = {
        id: orderId,
        serviceId: sec.id,
        serviceTitle: sec.title,
        price: sec.price || '',
        userId: String(ctx.from.id),
        username: ctx.from.username || '',
        name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
        status: 'pending',
        createdAt: new Date().toISOString()
    };
    ordersData.orders.push(order);
    saveJSON(ORDERS_FILE, ordersData);
    if (ADMIN_ID) {
        try {
            await ctx.telegram.sendMessage(ADMIN_ID,
                `🧾 **طلب جديد قيد التنفيذ**\n\nرقم الطلب: \`${orderId}\`\nالخدمة: ${sec.title}\nالسعر: ${sec.price || '-'}\nالزبون: ${order.name} (@${order.username || 'بدون معرف'})\nآيدي الزبون: \`${order.userId}\`\nالحالة: بانتظار التأكد من الدفع`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ تأكيد الدفع واستلام الطلب', `approve:${orderId}`)],
                        [Markup.button.callback('❌ رفض الطلب', `reject:${orderId}`)]
                    ])
                });
        } catch (e) { console.error('Admin notify failed:', e.message); }
    }
    return safeEdit(ctx, `⏳ **تم استلام طلبك، الطلب قيد التنفيذ ريثما يتم التأكد من الدفع.**\n\nالخدمة: ${sec.title}\nرقم الطلب: \`${orderId}\`\n\nرح نبلغك بس نتأكد من الدفع.`, homeKeyboard());
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
    return '👑 **لوحة تحكم الأدمن**\n\nمن هون بتضيف خدمة، وبتعدل نصها وسعرها، وبتحذفها، وبتعدل معلومات الدفع، وبتشوف الطلبات وبتأكد الدفع. كل تعديل بيبعتلك نسخة احتياطية تلقائياً على الخاص، لحتى ما يضيع شي.';
}

bot.command('admin', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    return ctx.reply(adminText(), { parse_mode: 'Markdown', ...adminKeyboard() });
});

bot.action('admin:add_section', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const p = loadPending(); p[String(ctx.from.id)] = { step: 'add_title' }; savePending(p);
    await safeAnswer(ctx);
    return safeEdit(ctx, 'أرسل اسم الخدمة / القسم الجديد، مثال: عرض 1\n\nاكتب /cancel للإلغاء.', adminKeyboard());
});
bot.action('admin:edit_section', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    const p = loadPending(); p[String(ctx.from.id)] = { step: 'edit_pick' }; savePending(p);
    await safeAnswer(ctx);
    return safeEdit(ctx, 'أرسل رقم الخدمة اللي بدك تعدل نصها:\n' + (sections.map((s, i) => `${i + 1}. ${s.title}`).join('\n') || 'لا يوجد خدمات'), adminKeyboard());
});
bot.action('admin:edit_price', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    const p = loadPending(); p[String(ctx.from.id)] = { step: 'price_pick' }; savePending(p);
    await safeAnswer(ctx);
    return safeEdit(ctx, 'أرسل رقم الخدمة اللي بدك تعدل سعرها:\n' + (sections.map((s, i) => `${i + 1}. ${s.title} - ${s.price || 'بدون سعر'}`).join('\n') || 'لا يوجد خدمات'), adminKeyboard());
});
bot.action('admin:del_section', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    const p = loadPending(); p[String(ctx.from.id)] = { step: 'del_pick' }; savePending(p);
    await safeAnswer(ctx);
    return safeEdit(ctx, 'أرسل رقم الخدمة اللي بدك تحذفها:\n' + (sections.map((s, i) => `${i + 1}. ${s.title}`).join('\n') || 'لا يوجد خدمات'), adminKeyboard());
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
    const p = loadPending(); p[String(ctx.from.id)] = { step: 'set_payment' }; savePending(p);
    await safeAnswer(ctx);
    return safeEdit(ctx, 'أرسل معلومات الدفع الجديدة.\n\nالمعلومات الحالية: ' + loadConfig().paymentInfo + '\n\nاكتب /cancel للإلغاء.', adminKeyboard());
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

bot.on('text', async (ctx, next) => {
    const allPending = loadPending();
    const key = String(ctx.from.id);
    if (!isAdmin(ctx) || !allPending[key]) return next();
    if (ctx.message.text.trim() === '/cancel') {
        delete allPending[key]; savePending(allPending);
        return ctx.reply('تم الإلغاء.', { parse_mode: 'Markdown', ...adminKeyboard() });
    }
    const p = allPending[key];
    const text = ctx.message.text.trim();
    const data = loadSections();
    const clear = () => { const pp = loadPending(); delete pp[key]; savePending(pp); };
    if (p.step === 'add_title') {
        p.title = text; p.step = 'add_price'; savePending(allPending);
        return ctx.reply('تمام، هلق أرسل سعر الخدمة، مثال: 1$');
    }
    if (p.step === 'add_price') {
        p.price = text; p.step = 'add_text'; savePending(allPending);
        return ctx.reply('تمام، هلق أرسل وصف الخدمة، مثال: 5 صفحات إكسل');
    }
    if (p.step === 'add_text') {
        const id = 'sec_' + Date.now();
        data.sections.push({ id, title: p.title, price: p.price, text });
        saveJSON(SECTIONS_FILE, data);
        clear();
        await backupToAdmin(ctx);
        return ctx.reply(`تمت إضافة الخدمة "${p.title}" بسعر ${p.price} بنجاح، وبعتلك نسخة احتياطية.`, { parse_mode: 'Markdown', ...adminKeyboard() });
    }
    if (p.step === 'edit_pick') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || !data.sections[idx]) { clear(); return ctx.reply('رقم غير صحيح.'); }
        p.idx = idx; p.step = 'edit_text'; savePending(allPending);
        return ctx.reply(`الخدمة الحالية: ${data.sections[idx].title}\nأرسل النص الجديد:`);
    }
    if (p.step === 'edit_text') {
        data.sections[p.idx].text = text;
        saveJSON(SECTIONS_FILE, data);
        clear();
        await backupToAdmin(ctx);
        return ctx.reply('تم تعديل نص الخدمة، وبعتلك نسخة احتياطية.', { parse_mode: 'Markdown', ...adminKeyboard() });
    }
    if (p.step === 'price_pick') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || !data.sections[idx]) { clear(); return ctx.reply('رقم غير صحيح.'); }
        p.idx = idx; p.step = 'price_new'; savePending(allPending);
        return ctx.reply(`الخدمة الحالية: ${data.sections[idx].title} - السعر الحالي: ${data.sections[idx].price || '-'}\nأرسل السعر الجديد:`);
    }
    if (p.step === 'price_new') {
        data.sections[p.idx].price = text;
        saveJSON(SECTIONS_FILE, data);
        clear();
        await backupToAdmin(ctx);
        return ctx.reply('تم تعديل سعر الخدمة، وبعتلك نسخة احتياطية.', { parse_mode: 'Markdown', ...adminKeyboard() });
    }
    if (p.step === 'del_pick') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || !data.sections[idx]) { clear(); return ctx.reply('رقم غير صحيح.'); }
        const removed = data.sections.splice(idx, 1)[0];
        saveJSON(SECTIONS_FILE, data);
        clear();
        await backupToAdmin(ctx);
        return ctx.reply(`تم حذف الخدمة "${removed.title}"، وبعتلك نسخة احتياطية من الباقي.`, { parse_mode: 'Markdown', ...adminKeyboard() });
    }
    if (p.step === 'set_payment') {
        const cfg = loadConfig();
        cfg.paymentInfo = text;
        saveJSON(CONFIG_FILE, cfg);
        clear();
        await backupToAdmin(ctx);
        return ctx.reply('تم تعديل معلومات الدفع، وبعتلك نسخة احتياطية.', { parse_mode: 'Markdown', ...adminKeyboard() });
    }
    return next();
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

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') { await bot.handleUpdate(req.body); return res.status(200).send('OK'); }
        return res.status(200).send('Muse Code Exchange Store is Live.');
    } catch (err) { return res.status(200).send('OK'); }
};
module.exports.config = { maxDuration: 60 };
