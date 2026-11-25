const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID).trim() : null;

const DB_FILE = './codes.json';

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ codes: [] }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function homeKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🛍️ تصفح الأكواد', 'browse_codes')],
        [Markup.button.callback('➕ أضف كودي', 'add_my_code')],
        [Markup.button.callback('❓ كيف تشتغل؟', 'how_it_works')]
    ]);
}

bot.start((ctx) => {
    return ctx.reply(
        '🛍️ **أهلاً فيك بمتجر تبادل أكواد موس!**\n\n' +
        'هون بتلاقي أكواد دعوة من ناس حقيقية من دول مختلفة، وبتضيف كودك لحتى غيرك يستفيد منو.\n\n' +
        '⚠️ مهم: الكود بيشتغل بس لحساب جديد، وخلال أول 48 ساعة من إنشاء الحساب، ومرة وحدة بس لكل حساب. ما في بيع تفعيل، التبادل مجاني.',
        { parse_mode: 'Markdown', ...homeKeyboard() }
    );
});

bot.action('browse_codes', async (ctx) => {
    const db = loadDB();
    if (!db.codes.length) {
        await ctx.answerCbQuery();
        return ctx.reply('لسه ما في أكواد مضافة، كون أول واحد وضيف كودك من زر أضف كودي.');
    }
    const list = db.codes.slice(0, 20).map((c, i) =>
        `${i + 1}. \`${c.code}\` - ${c.country || 'بدون بلد'} - أضافو @${c.username || 'بدون معرف'}`
    ).join('\n');
    await ctx.answerCbQuery();
    return ctx.reply(`🛍️ **الأكواد المتوفرة:**\n\n${list}\n\nانسخ الكود وروح على Muse > Settings > Redeem invite code واكتبو خلال أول 48 ساعة من إنشاء حسابك.`, { parse_mode: 'Markdown' });
});

bot.action('add_my_code', async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.reply('أرسل كودك بهالشكل:\n`/addcode ABC123 بلدك`\n\nمثال: `/addcode ABC123 سوريا`', { parse_mode: 'Markdown' });
});

bot.action('how_it_works', async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.reply(
        '❓ **كيف تشتغل؟**\n\n' +
        '1. إذا عندك حساب جديد على موس، اختار كود من قائمة الأكواد.\n' +
        '2. افتح Muse > Settings > Redeem invite code، واكتب الكود خلال أول 48 ساعة.\n' +
        '3. انت وصاحب الكود بتاخدو 1 مليار توكن.\n' +
        '4. إذا عندك كود، ضيفو بالبوت لحتى غيرك يستعملو.\n\n' +
        'الكود مرة وحدة بس لكل حساب جديد، والتبادل مجاني، وما في دفع ولا تفعيل مدفوع.',
        { parse_mode: 'Markdown' }
    );
});

bot.command('store', (ctx) => {
    return ctx.reply('🛍️ **متجر تبادل أكواد موس**\n\nتصفح الأكواد أو أضف كودك من الأزرار:', { parse_mode: 'Markdown', ...homeKeyboard() });
});

bot.command('codes', (ctx) => {
    const db = loadDB();
    if (!db.codes.length) return ctx.reply('لسه ما في أكواد مضافة.');
    const list = db.codes.slice(0, 20).map((c, i) => `${i + 1}. \`${c.code}\` - ${c.country || ''}`).join('\n');
    return ctx.reply(`🛍️ **الأكواد:**\n\n${list}`, { parse_mode: 'Markdown' });
});

bot.command('addcode', (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const code = (args[0] || '').trim().toUpperCase();
    const country = args.slice(1).join(' ').trim();
    if (!code || code.length < 4) {
        return ctx.reply('طريقة الاستعمال: /addcode ABC123 بلدك');
    }
    const db = loadDB();
    if (db.codes.find((c) => c.code === code)) {
        return ctx.reply('هاد الكود موجود مسبقاً.');
    }
    db.codes.push({
        code,
        country,
        username: ctx.from.username || '',
        userId: String(ctx.from.id),
        addedAt: new Date().toISOString()
    });
    saveDB(db);
    return ctx.reply(`تمت إضافة كودك \`${code}\` بنجاح، شكراً لمشاركتك.`, { parse_mode: 'Markdown' });
});

bot.command('delcode', (ctx) => {
    if (ADMIN_ID && String(ctx.from.id) !== ADMIN_ID) return;
    const args = ctx.message.text.split(' ').slice(1);
    const code = (args[0] || '').trim().toUpperCase();
    if (!code) return ctx.reply('طريقة الاستعمال: /delcode ABC123');
    const db = loadDB();
    db.codes = db.codes.filter((c) => c.code !== code);
    saveDB(db);
    return ctx.reply(`تم حذف الكود \`${code}\`.`, { parse_mode: 'Markdown' });
});

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Muse Code Exchange Store is Live.');
    } catch (err) {
        return res.status(200).send('OK');
    }
};

module.exports.config = {
    maxDuration: 60
};
