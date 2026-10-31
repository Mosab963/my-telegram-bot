const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID).trim() : null;

const activeUsers = new Set();
let sessionActions = 0;

// تسجيل وإرسال إشعار فوري بحسابك عند دخول أي شخص
async function logToAdmin(ctx, activity) {
    if (!ADMIN_ID) return;
    try {
        const u = ctx.from;
        if (!u || String(u.id) === ADMIN_ID) return;

        activeUsers.add(u.id);
        sessionActions++;

        const userTag = u.username ? `@${u.username}` : 'بدون معرف';
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
        const time = new Date().toLocaleTimeString('ar-SY', { hour: '2-digit', minute: '2-digit' });

        const report = 
            `📊 **نشاط جديد في بوت الألعاب:**\n` +
            `━━━━━━━━━━━━━━━\n` +
            `👤 **اللاعب:** ${name} (${userTag})\n` +
            `🆔 **الآيدي:** \`${u.id}\`\n` +
            `🎮 **النشاط:** ${activity}\n` +
            `⏰ **الوقت:** ${time}`;

        await ctx.telegram.sendMessage(ADMIN_ID, report, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error('Log error:', err.message);
    }
}

// قائمة الألعاب الرسمية والشغالة 100%
const verifiedGames = {
    ludo: {
        title: '🎲 لودو الرسمية (2 - 4 لاعبين)',
        desc: 'طاولة لودو كلاسيكية وسريعة من سيرفرات غوغل',
        url: 'https://gamesnacks.com/games/ludolegend'
    },
    uno: {
        title: '🃏 أونو التحدي (Uno - 2 إلى 4 لاعبين)',
        desc: 'لعبة كروت الأونو الأصلية السريعة والخفيفة',
        url: 'https://gamesnacks.com/games/duocards'
    },
    gartic: {
        title: '🎨 خمن الرسمة (Gartic - قروبات)',
        desc: 'لعبة تخمين ورسم بالعربي للقروبات بروم خاص',
        url: 'https://gartic.io/'
    },
    connect4: {
        title: '🔴 تحدي 4 على التوالي (Connect 4)',
        desc: 'تحدي ذكاء مباشر وسريع لشخصين 1v1',
        url: 'https://papergames.io/en/connect-4'
    },
    battleship: {
        title: '🚢 حرب السفن البحرية',
        desc: 'دمر أسطول صديقك - تحدي ثنائي حماسي',
        url: 'https://papergames.io/en/battleship'
    },
    billiards: {
        title: '🎱 بلياردو التحدي (8 Ball)',
        desc: 'طاولة بلياردو احترافية وسريعة',
        url: 'https://gamesnacks.com/games/8ballbilliardsclassic'
    }
};

// القائمة الرئيسية للبوت
function getHomeKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.switchToChat('📢 إرسال طاولة لقروب أو صديق', 'game')
        ],
        [
            Markup.button.url('🎲 لودو (2 - 4 لاعبين)', verifiedGames.ludo.url),
            Markup.button.url('🃏 أونو (2 - 4 لاعبين)', verifiedGames.uno.url)
        ],
        [
            Markup.button.url('🎨 خمن الرسمة (قروبات)', verifiedGames.gartic.url),
            Markup.button.url('🔴 تحدي Connect 4', verifiedGames.connect4.url)
        ],
        [
            Markup.button.url('🚢 حرب السفن', verifiedGames.battleship.url),
            Markup.button.url('🎱 بلياردو', verifiedGames.billiards.url)
        ],
        [
            Markup.button.callback('ℹ️ كيف تلعب مع أصدقائك؟', 'help_info')
        ]
    ]);
}

bot.start(async (ctx) => {
    await logToAdmin(ctx, 'فتح البوت (/start)');
    return ctx.reply(
        '🎮 **مرحباً بك في منصة الألعاب التفاعلية المباشرة!**\n\n' +
        '• تم تجهيز طاولات **اللودو والأونو** الرسمية للعب الفردي والجماعي.\n' +
        '• تفتح الألعاب فوراً بلمسة زر داخل تيليجرام دون أي تحميل أو إعلانات.\n\n' +
        'اختر اللعبة وابدأ اللعب فوراً 👇',
        { parse_mode: 'Markdown', ...getHomeKeyboard() }
    );
});

// أوامر القروبات السريعة
bot.command(['ludo', 'uno', 'play', 'games'], async (ctx) => {
    await logToAdmin(ctx, 'طلب طاولة بالقروب');
    return ctx.reply(
        `🎲 **طاولة ألعاب جماعية جاهزة للقروب!**\n` +
        `👑 فتح الطاولة: ${ctx.from.first_name}\n\n` +
        `اضغطوا على اللعبة التي تناسبكم للبدء فوراً:`,
        Markup.inlineKeyboard([
            [
                Markup.button.url('🎲 دخول لودو (2-4)', verifiedGames.ludo.url),
                Markup.button.url('🃏 دخول أونو (2-4)', verifiedGames.uno.url)
            ],
            [
                Markup.button.url('🎨 خمن الرسمة', verifiedGames.gartic.url),
                Markup.button.url('🔴 تحدي Connect 4', verifiedGames.connect4.url)
            ]
        ])
    );
});

// لوحة تحكم المدير
bot.command(['stats', 'admin'], async (ctx) => {
    if (String(ctx.from.id) !== ADMIN_ID) return;

    return ctx.reply(
        `👑 **لوحة تحكم المدير:**\n` +
        `━━━━━━━━━━━━━━━\n` +
        `👥 مستخدمو الجلسة: ${activeUsers.size}\n` +
        `🎯 إجمالي التفاعلات: ${sessionActions}\n` +
        `⚡ سيرفر Vercel يعمل 24/7 باستقرار تام.`,
        { parse_mode: 'Markdown' }
    );
});

// التعليمات
bot.action('help_info', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
        '💡 **كيف تلعب مع أصدقائك؟**\n\n' +
        '1. اضغط على زر **«📢 إرسال طاولة لقروب أو صديق»**.\n' +
        '2. اختر القروب أو شات رفيقك لتصل بطاقة اللعبة فوراً.\n' +
        '3. يضغط الطرف الثاني على الزر وتبدأ الجولة مباشرة من شاشة تيليجرام.',
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('🔙 رجوع', 'home_menu')]])
        }
    );
});

bot.action('home_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        '🎮 **منصة الألعاب التفاعلية:**\nاختر لعبتك المفضلة:',
        { parse_mode: 'Markdown', ...getHomeKeyboard() }
    );
});

// نظام مشاركة الألعاب داخل أي محادثة (Inline Mode)
bot.on('inline_query', async (ctx) => {
    await logToAdmin(ctx, 'مشاركة طاولة في محادثة (Inline)');

    const gamesList = Object.values(verifiedGames);
    const results = gamesList.map((game, index) => ({
        type: 'article',
        id: `game_${index}`,
        title: game.title,
        description: game.desc,
        thumb_url: 'https://cdn-icons-png.flaticon.com/512/808/808439.png',
        input_message_content: {
            message_text:
                `⚔️ **دعوة لعب وتحدي مفتوحة!**\n\n` +
                `🎮 اللعبة: **${game.title}**\n` +
                `👑 المنشئ: ${ctx.from.first_name}\n\n` +
                `اضغطوا على الزر بالأسفل للدخول واللعب معاً فوراً 👇`,
            parse_mode: 'Markdown'
        },
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.url('🕹️ دخول اللعبة وبدء التحدي', game.url)]
        ])
    }));

    return ctx.answerInlineQuery(results, { cache_time: 10 });
});

// معالج Vercel
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Ludo & Uno Arcade Platform is Live 24/7.');
    } catch (err) {
        return res.status(200).send('OK');
    }
};

module.exports.config = {
    maxDuration: 60
};
