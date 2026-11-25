const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID).trim() : null;

const CODES_FILE = './codes.json';
const SECTIONS_FILE = './sections.json';

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

function loadCodes() { return loadJSON(CODES_FILE, { codes: [] }); }
function loadSections() { return loadJSON(SECTIONS_FILE, { sections: DEFAULT_SECTIONS }); }

async function backupToAdmin(ctx) {
    if (!ADMIN_ID) return;
    try {
        await ctx.telegram.sendDocument(ADMIN_ID, { source: Buffer.from(JSON.stringify(loadCodes(), null, 2)), filename: 'codes-backup.json' }, { caption: 'نسخة احتياطية من الأكواد - احتفظ فيها' });
        await ctx.telegram.sendDocument(ADMIN_ID, { source: Buffer.from(JSON.stringify(loadSections(), null, 2)), filename: 'sections-backup.json' }, { caption: 'نسخة احتياطية من الأقسام - احتفظ فيها' });
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

bot.command('codes', (ctx) => {
    const db = loadCodes();
    if (!db.codes.length) return ctx.reply('لسه ما في أكواد مضافة.');
    const list = db.codes.slice(0, 20).map((c, i) => `${i + 1}. \`${c.code}\` - ${c.country || ''}`).join('\n');
    return ctx.reply(`🛍️ **الأكواد:**\n\n${list}`, { parse_mode: 'Markdown' });
});

bot.command('addcode', (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const code = (args[0] || '').trim().toUpperCase();
    const country = args.slice(1).join(' ').trim();
    if (!code || code.length < 4) return ctx.reply('طريقة الاستعمال: /addcode ABC123 بلدك');
    const db = loadCodes();
    if (db.codes.find((c) => c.code === code)) return ctx.reply('هاد الكود موجود مسبقاً.');
    db.codes.push({ code, country, username: ctx.from.username || '', userId: String(ctx.from.id), addedAt: new Date().toISOString() });
    saveJSON(CODES_FILE, db);
    backupToAdmin(ctx);
    return ctx.reply(`تمت إضافة كودك \`${code}\` بنجاح.`, { parse_mode: 'Markdown' });
});

bot.command('delcode', (ctx) => {
    if (!isAdmin(ctx)) return;
    const code = (ctx.message.text.split(' ').slice(1)[0] || '').trim().toUpperCase();
    if (!code) return ctx.reply('طريقة الاستعمال: /delcode ABC123');
    const db = loadCodes();
    db.codes = db.codes.filter((c) => c.code !== code);
    saveJSON(CODES_FILE, db);
    backupToAdmin(ctx);
    return ctx.reply(`تم حذف الكود \`${code}\`.`, { parse_mode: 'Markdown' });
});

// --- Admin panel ---
const pending = {};
function adminKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('➕ إضافة قسم', 'admin:add_section')],
        [Markup.button.callback('✏️ تعديل نص قسم', 'admin:edit_section')],
        [Markup.button.callback('🗑️ حذف قسم', 'admin:del_section')],
        [Markup.button.callback('📋 عرض الأقسام', 'admin:list_sections')],
        [Markup.button.callback('📊 إحصائيات', 'admin:stats')],
        [Markup.button.callback('💾 نسخة احتياطية', 'admin:backup')]
    ]);
}

bot.command('admin', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('هاد الأمر للأدمن بس.');
    return ctx.reply('👑 **لوحة تحكم الأدمن**\n\nمن هون بتضيف قسم، وبتعدل نصو وأزرارو، وبتحذفو، وبتاخد نسخة احتياطية. كل تعديل بيبعتلك نسخة احتياطية تلقائياً على الخاص، لحتى ما يضيع شي.', { parse_mode: 'Markdown', ...adminKeyboard() });
});

bot.action('admin:add_section', async (ctx) => {
    if (!isAdmin(ctx)) return;
    pending[ctx.from.id] = { step: 'add_title' };
    await ctx.answerCbQuery();
    return ctx.reply('أرسل اسم القسم الجديد، مثال: عروض اليوم');
});
bot.action('admin:edit_section', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    pending[ctx.from.id] = { step: 'edit_pick' };
    await ctx.answerCbQuery();
    return ctx.reply('أرسل رقم القسم اللي بدك تعدلو:\n' + sections.map((s, i) => `${i + 1}. ${s.title}`).join('\n'));
});
bot.action('admin:del_section', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    pending[ctx.from.id] = { step: 'del_pick' };
    await ctx.answerCbQuery();
    return ctx.reply('أرسل رقم القسم اللي بدك تحذفو:\n' + sections.map((s, i) => `${i + 1}. ${s.title}`).join('\n'));
});
bot.action('admin:list_sections', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const { sections } = loadSections();
    await ctx.answerCbQuery();
    return ctx.reply('📋 **الأقسام:**\n\n' + sections.map((s, i) => `${i + 1}. ${s.title}\n${s.text}`).join('\n\n'), { parse_mode: 'Markdown' });
});
bot.action('admin:stats', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const codes = loadCodes().codes.length;
    const sections = loadSections().sections.length;
    await ctx.answerCbQuery();
    return ctx.reply(`📊 **إحصائيات:**\n\nعدد الأكواد: ${codes}\nعدد الأقسام: ${sections}`);
});
bot.action('admin:backup', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    await backupToAdmin(ctx);
    return ctx.reply('تم إرسال النسخة الاحتياطية على الخاص.');
});

bot.action(/^section:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const { sections } = loadSections();
    const sec = sections.find((s) => s.id === id);
    await ctx.answerCbQuery();
    if (!sec) return ctx.reply('هاد القسم مو موجود.');
    if (id === 'browse') {
        const db = loadCodes();
        if (!db.codes.length) return ctx.reply('لسه ما في أكواد مضافة.');
        const list = db.codes.slice(0, 20).map((c, i) => `${i + 1}. \`${c.code}\` - ${c.country || ''}`).join('\n');
        return ctx.reply(`🛍️ **الأكواد:**\n\n${list}\n\nانسخ الكود وروح على Muse > Settings > Redeem invite code واكتبو خلال أول 48 ساعة.`, { parse_mode: 'Markdown' });
    }
    if (id === 'add') return ctx.reply('أرسل كودك بهالشكل:\n`/addcode ABC123 بلدك`', { parse_mode: 'Markdown' });
    return ctx.reply(`**${sec.title}**\n\n${sec.text}`, { parse_mode: 'Markdown' });
});

bot.on('text', async (ctx, next) => {
    if (!isAdmin(ctx) || !pending[ctx.from.id]) return next();
    const p = pending[ctx.from.id];
    const text = ctx.message.text.trim();
    const data = loadSections();
    if (p.step === 'add_title') {
        p.title = text; p.step = 'add_text';
        return ctx.reply('تمام، هلق أرسل نص القسم الجديد.');
    }
    if (p.step === 'add_text') {
        const id = 'sec_' + Date.now();
        data.sections.push({ id, title: p.title, text });
        saveJSON(SECTIONS_FILE, data);
        delete pending[ctx.from.id];
        await backupToAdmin(ctx);
        return ctx.reply(`تمت إضافة القسم "${p.title}" بنجاح، وبعتلك نسخة احتياطية.`, { parse_mode: 'Markdown' });
    }
    if (p.step === 'edit_pick') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || !data.sections[idx]) { delete pending[ctx.from.id]; return ctx.reply('رقم غير صحيح.'); }
        p.idx = idx; p.step = 'edit_text';
        return ctx.reply(`القسم الحالي: ${data.sections[idx].title}\nأرسل النص الجديد:`);
    }
    if (p.step === 'edit_text') {
        data.sections[p.idx].text = text;
        saveJSON(SECTIONS_FILE, data);
        delete pending[ctx.from.id];
        await backupToAdmin(ctx);
        return ctx.reply('تم تعديل نص القسم، وبعتلك نسخة احتياطية.');
    }
    if (p.step === 'del_pick') {
        const idx = parseInt(text, 10) - 1;
        if (isNaN(idx) || !data.sections[idx]) { delete pending[ctx.from.id]; return ctx.reply('رقم غير صحيح.'); }
        const removed = data.sections.splice(idx, 1)[0];
        saveJSON(SECTIONS_FILE, data);
        delete pending[ctx.from.id];
        await backupToAdmin(ctx);
        return ctx.reply(`تم حذف القسم "${removed.title}"، وبعتلك نسخة احتياطية من الباقي.`);
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
        if (ctx.message.document.file_name.includes('codes')) {
            saveJSON(CODES_FILE, json); return ctx.reply('تم استرجاع نسخة الأكواد.');
        }
        if (ctx.message.document.file_name.includes('sections')) {
            saveJSON(SECTIONS_FILE, json); return ctx.reply('تم استرجاع نسخة الأقسام.');
        }
        return ctx.reply('ابعت ملف codes-backup.json أو sections-backup.json للاسترجاع.');
    } catch (e) { return ctx.reply('ما قدرت اقرأ الملف، تأكد إنو ملف نسخة احتياطية صحيح.'); }
});

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') { await bot.handleUpdate(req.body); return res.status(200).send('OK'); }
        return res.status(200).send('Muse Code Exchange Store is Live.');
    } catch (err) { return res.status(200).send('OK'); }
};
module.exports.config = { maxDuration: 60 };
