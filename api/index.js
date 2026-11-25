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
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const DEFAULT_SECTIONS = [];
const DEFAULT_CONFIG = { paymentInfo: 'للدفع تواصل مع الأدمن لتأكيد طريقة الدفع.' };

function loadCodes() { return loadJSON(CODES_FILE, { codes: [] }); }
function loadSections() { return loadJSON(SECTIONS_FILE, { sections: DEFAULT_SECTIONS }); }
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

function isAdmin(ctx) { return ADMIN_ID && String(ctx.from.id) === ADMIN_ID; }
function homeKeyboard() {
    const { sections } = loadSections();
    const rows = sections.map((s) => [Markup.button.callback(s.title, `section:${s.id}`)]);
    return Markup.inlineKeyboard(rows);
}

bot.start((ctx) => {
    return ctx.reply(
        '🛍️ **أهلاً فيك بمتجرنا!**\n\nتصفح الأقسام من الأزرار تحت، واختار اللي بيناسبك.',
        { parse_mode: 'Markdown', ...homeKeyboard() }
    );
});

bot.command('store', (ctx) => ctx.reply('🛍️ **متجرنا**\n\nتصفح الأقسام من الأزرار تحت.', { parse_mode: 'Markdown', ...homeKeyboard() }));

// --- Service / order flow ---
// 1. Click a service -> details + price + Confirm button
// 2. Confirm -> payment page with payment info + Confirm payment button
// 3. Confirm payment -> order pending, message "order in progress pending payment verification", admin notified

bot.action(/^section:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const { sections } = loadSections();
    const sec = sections.find((s) => s.id === id);
    await ctx.answerCbQuery();
    if (!sec) return ctx.reply('هاد القسم مو موجود.');
    const priceLine = sec.price ? `\n💰 السعر: ${sec.price}` : '';
    return ctx.reply(`**${sec.title}**\n\n${sec.text || ''}${priceLine}`, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ تأكيد الطلب', `order:${sec.id}`)],
            [Markup.button.callback('🔙 رجوع', 'home')]
        ])
    });
});

bot.action('home', async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.reply('🛍️ **متجرنا**\n\nتصفح الأقسام من الأزرار تحت.', { parse_mode: 'Markdown', ...homeKeyboard() });
});

bot.action(/^order:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const { sections } = loadSections();
    const sec = sections.find((s) => s.id === id);
    await ctx.answerCbQuery();
    if (!sec) return ctx.reply('هاد القسم مو موجود.');
    const cfg = loadConfig();
    const priceLine = sec.price ? `\n💰 السعر: ${sec.price}` : '';
    return ctx.reply(
        `💳 **صفحة الدفع**\n\n**${sec.title}**${priceLine}\n\n${cfg.paymentInfo}\n\nبعد ما تدفع، كبس زر تأكيد الدفع تحت.`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('💳 تأكيد الدفع', `pay:${sec.id}`)],
                [Markup.button.callback('❌ إلغاء', 'home')]
            ])
        }
    );
});

bot.action(/^pay:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const { sections } = loadSections();
    const sec = sections.find((s) => s.id === id);
    await ctx.answerCbQuery();
    if (!sec) return ctx.reply('هاد القسم مو موجود.');
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
    // Notify admin with approve / reject buttons
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
    return ctx.reply('⏳ **تم استلام طلبك، الطلب قيد التنفيذ ريثما يتم التأكد من الدفع.**\n\nرح نبلغك بس نتأكد من الدفع.', { parse_mode: 'Markdown' });
});

bot.action(/^approve:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const orderId = ctx.match[1];
    const data = loadOrders();
    const order = data.orders.find((o) => o.id === orderId);
    await ctx.answerCbQuery();
    if (!order) return ctx.reply('الطلب مو موجود.');
    order.status = 'confirmed';
    saveJSON(ORDERS_FILE, data);
    try { await ctx.telegram.sendMessage(order.userId, `✅ تم تأكيد الدفع واستلام طلبك: ${order.serviceTitle}\n\nطلبك قيد التنفيذ، شكراً لثقتك.`); } catch (e) {}
    return ctx.reply(`تم تأكيد الدفع للطلب \`${orderId}\`، وبلغت الزبون.`, { parse_mode: 'Markdown' });
});

bot.action(/^reject:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return;
    const orderId = ctx.match[1];
    const data = loadOrders();
    const order = data.orders.find((o) => o.id === orderId);
    await ctx.answerCbQuery();
    if (!order) return ctx.reply('الطلب مو موجود.');
    order.status = 'rejected';
    saveJSON(ORDERS_FILE, data);
    try { await ctx.telegram.sendMessage(order.userId, `❌ تم رفض طلبك: ${order.serviceTitle}\n\nتواصل مع الأدمن للتفاصيل.`); } catch (e) {}
    return ctx.reply(`تم رفض الطلب \`${orderId}\`، وبلغت الزبون.`, { parse_mode: 'Markdown' });
});

// --- Admin panel ---
const pending = {};
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
        [Markup.button.callback('💾 نسخة احتياطية', 'admin:backup')]
    ]);
}

bot.command('admin', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    return ctx.reply('👑 **لوحة تحكم الأدمن**\n\nمن هون بتضيف خدمة، وبتعدل نصها وسعرها، وبتحذفها، وبتعدل معلومات الدفع، وبتشوف الطلبات وبتأكد الدفع. كل تعديل بيبعتلك نسخة احتياطية تلقائياً على الخاص، لحتى ما يضيع شي.', { parse_mode: 'Markdown', ...adminKeyboard() });
});

bot.action('admin:add_section', async (ctx) => {
    if (!isAdmin(ctx)) return;
    pending[ctx.from.id] = { step: 'add_title' };
    await ctx.answerCbQuery();
    return ctx.reply('أرسل اسم الخدمة / القسم الجديد، مثال: عرض 1');
});
bot.action('admin:edit_section', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    pending[ctx.from.id] = { step: 'edit_pick' };
    await ctx.answerCbQuery();
    return ctx.reply('أرسل رقم الخدمة اللي بدك تعدل نصها:\n' + sections.map((s, i) => `${i + 1}. ${s.title}`).join('\n'));
});
bot.action('admin:edit_price', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    pending[ctx.from.id] = { step: 'price_pick' };
    await ctx.answerCbQuery();
    return ctx.reply('أرسل رقم الخدمة اللي بدك تعدل سعرها:\n' + sections.map((s, i) => `${i + 1}. ${s.title} - ${s.price || 'بدون سعر'}`).join('\n'));
});
bot.action('admin:del_section', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    pending[ctx.from.id] = { step: 'del_pick' };
    await ctx.answerCbQuery();
    return ctx.reply('أرسل رقم الخدمة اللي بدك تحذفها:\n' + sections.map((s, i) => `${i + 1}. ${s.title}`).join('\n'));
});
bot.action('admin:list_sections', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    await ctx.answerCbQuery();
    if (!sections.length) return ctx.reply('لسه ما في خدمات، ضيف أول خدمة من زر إضافة خدمة.');
    return ctx.reply('📋 **الخدمات:**\n\n' + sections.map((s, i) => `${i + 1}. ${s.title}\n${s.text || ''}\nالسعر: ${s.price || '-'}`).join('\n\n'), { parse_mode: 'Markdown' });
});
bot.action('admin:orders', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { orders } = loadOrders();
    await ctx.answerCbQuery();
    if (!orders.length) return ctx.reply('لسه ما في طلبات.');
    const list = orders.slice(-10).map((o) => `${o.id} - ${o.serviceTitle} - ${o.price || ''} - ${o.status} - @${o.username || o.userId}`).join('\n');
    return ctx.reply('🧾 **آخر الطلبات:**\n\n' + list);
});
bot.action('admin:set_payment', async (ctx) => {
    if (!isAdmin(ctx)) return;
    pending[ctx.from.id] = { step: 'set_payment' };
    await ctx.answerCbQuery();
    return ctx.reply('أرسل معلومات الدفع الجديدة، مثال: ادفع 1$ على محفظة كذا، وبعدها كبس تأكيد الدفع.\n\nالمعلومات الحالية: ' + loadConfig().paymentInfo);
});
bot.action('admin:stats', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const sections = loadSections().sections.length;
    const orders = loadOrders().orders;
    const pendingCount = orders.filter((o) => o.status === 'pending').length;
    await ctx.answerCbQuery();
    return ctx.reply(`📊 **إحصائيات:**\n\nعدد الخدمات: ${sections}\nعدد الطلبات: ${orders.length}\nطلبات بانتظار التأكد: ${pendingCount}`);
});
bot.action('admin:backup', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await backupToAdmin(ctx);
    return ctx.reply('تم إرسال النسخة الاحتياطية على الخاص.');
});

bot.on('text', async (ctx, next) => {
    if (!isAdmin(ctx) || !pending[ctx.from.id]) return next();
    const p = pending[ctx.from.id];
    const text = ctx.message.text.trim();
    const data = loadSections();
    if (p.step === 'add_title') {
        p.title = text; p.step = 'add_price';
        return ctx.reply('تمام، هلق أرسل سعر الخدمة، مثال: 1$');
    }
    if (p.step === 'add_price') {
        p.price = text; p.step = 'add_text';
        return ctx.reply('تمام، هلق أرسل وصف الخدمة، مثال: 5 صفحات إكسل');
    }
    if (p.step === 'add_text') {
        const id = 'sec_' + Date.now();
        data.sections.push({ id, title: p.title, price: p.price, text });
        saveJSON(SECTIONS_FILE, data);
        delete pending[ctx.from.id];
        await backupToAdmin(ctx);
        return ctx.reply(`تمت إضافة الخدمة "${p.title}" بسعر ${p.price} بنجاح، وبعتلك نسخة احتياطية.`, { parse_mode: 'Markdown' });
    }
    if (p.step === 'edit_pick') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || !data.sections[idx]) { delete pending[ctx.from.id]; return ctx.reply('رقم غير صحيح.'); }
        p.idx = idx; p.step = 'edit_text';
        return ctx.reply(`الخدمة الحالية: ${data.sections[idx].title}\nأرسل النص الجديد:`);
    }
    if (p.step === 'edit_text') {
        data.sections[p.idx].text = text;
        saveJSON(SECTIONS_FILE, data);
        delete pending[ctx.from.id];
        await backupToAdmin(ctx);
        return ctx.reply('تم تعديل نص الخدمة، وبعتلك نسخة احتياطية.');
    }
    if (p.step === 'price_pick') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || !data.sections[idx]) { delete pending[ctx.from.id]; return ctx.reply('رقم غير صحيح.'); }
        p.idx = idx; p.step = 'price_new';
        return ctx.reply(`الخدمة الحالية: ${data.sections[idx].title} - السعر الحالي: ${data.sections[idx].price || '-'}\nأرسل السعر الجديد:`);
    }
    if (p.step === 'price_new') {
        data.sections[p.idx].price = text;
        saveJSON(SECTIONS_FILE, data);
        delete pending[ctx.from.id];
        await backupToAdmin(ctx);
        return ctx.reply('تم تعديل سعر الخدمة، وبعتلك نسخة احتياطية.');
    }
    if (p.step === 'del_pick') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || !data.sections[idx]) { delete pending[ctx.from.id]; return ctx.reply('رقم غير صحيح.'); }
        const removed = data.sections.splice(idx, 1)[0];
        saveJSON(SECTIONS_FILE, data);
        delete pending[ctx.from.id];
        await backupToAdmin(ctx);
        return ctx.reply(`تم حذف الخدمة "${removed.title}"، وبعتلك نسخة احتياطية من الباقي.`);
    }
    if (p.step === 'set_payment') {
        const cfg = loadConfig();
        cfg.paymentInfo = text;
        saveJSON(CONFIG_FILE, cfg);
        delete pending[ctx.from.id];
        await backupToAdmin(ctx);
        return ctx.reply('تم تعديل معلومات الدفع، وبعتلك نسخة احتياطية.');
    }
    return next();
});

// Restore backup by sending a JSON file to the bot (admin only)
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
