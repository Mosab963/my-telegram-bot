const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = process.env.ADMIN_ID ? String(process.env.ADMIN_ID).trim() : null;

// ذاكرة سريعة لتسجيل زوار الجلسة النشطة
const activeSessionUsers = new Set();
let totalPlaysCount = 0;

// دالة إرسال تقرير فوري للمدير (أنت) عند حدوث أي نشاط
async function logActivityToAdmin(ctx, actionName) {
    if (!ADMIN_ID) return;

    try {
        const user = ctx.from;
        if (!user) return;

        // تجاهل إرسال إشعار إذا كان الفاعل هو الأدمن نفسه لمنع الإزعاج
        if (String(user.id) === ADMIN_ID && actionName.includes('لوحة')) return;

        activeSessionUsers.add(user.id);
        totalPlaysCount++;

        const usernameText = user.username ? `@${user.username}` : 'بدون معرف';
        const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');

        const now = new Date();
        const timeString = now.toLocaleTimeString('ar-SY', { hour: '2-digit', minute: '2-digit' });

        const reportMessage = 
            `📊 **تقرير نشاط جديد في البوت:**\n` +
            `━━━━━━━━━━━━━━━\n` +
            `👤 **المستخدم:** ${fullName}\n` +
            `🔗 **المعرف:** ${usernameText}\n` +
            `🆔 **الآيدي:** \`${user.id}\`\n` +
            `🎮 **النشاط:** ${actionName}\n` +
            `⏰ **الوقت:** ${timeString}\n` +
            `━━━━━━━━━━━━━━━`;

        await ctx.telegram.sendMessage(ADMIN_ID, reportMessage, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error('Failed to send admin log:', err.message);
    }
}

// توليد رقم الغرف التلقائي
function generateRoomCode() {
    return Math.floor(100000 + Math.random() * 900000);
}

// قائمة الألعاب المرنة
function getFlexibleGames(roomCode) {
    return [
        {
            id: 'ludo_flex',
            title: '🎲 لودو التحدي (من 2 إلى 4 لاعبين)',
            desc: `تبدأ بلاعبين اثنين فقط دون انتظار | كود: ${roomCode}`,
            url: `https://ludo.party/?room=${roomCode}`
        },
        {
            id: 'uno_flex',
            title: '🃏 أونو الكروت (من 2 إلى 4 لاعبين)',
            desc: `تحدي ثنائي فوري أو جماعي | كود: ${roomCode}`,
            url: `https://play.unofreak.com/?room=${roomCode}`
        },
        {
            id: 'domino_flex',
            title: '🀄 دومينو حية (من 2 إلى 4 لاعبين)',
            desc: `رأس برأس أو طاولة رباعية | كود: ${roomCode}`,
            url: `https://papergames.io/en/dominoes`
        },
        {
            id: 'xo_instant',
            title: '⚔️ إكس أو السريعة (تحدي ثنائي مباشر)',
            desc: 'مواجهة فورية بين لاعبين 1v1',
            url: `https://papergames.io/en/tic-tac-toe`
        }
    ];
}

// القائمة الرئيسية
function getMainMenu() {
    return Markup.inlineKeyboard([
        [
            Markup.button.switchToChat('📢 إرسال طاولة للقروب (2 - 4 لاعبين)', 'ludo')
        ],
        [
            Markup.button.callback('🎲 طاولة لودو مرنة (2-4)', 'start_ludo_flex'),
            Markup.button.callback('🃏 طاولة أونو مرنة (2-4)', 'start_uno_flex')
        ],
        [
            Markup.button.webApp('🌐 صالة الألعاب الفردية', 'https://gamesnacks.com/'),
            Markup.button.callback('ℹ️ كيف تلعب؟', 'action_flex_info')
        ]
    ]);
}

// أمر البداية
bot.start(async (ctx) => {
    await logActivityToAdmin(ctx, 'فتح البوت عبر /start');
    return ctx.reply(
        '🎮 **أهلاً بك في منصة الألعاب التفاعلية المرنة!**\n\n' +
        '• الطاولات تتكيف تلقائياً: **تبدأ فور دخول شخصين** أو تتوسع حتى 4 لاعبين.\n' +
        'اختر ما يناسبك من الأسفل:',
        { parse_mode: 'Markdown', ...getMainMenu() }
    );
});

// أمر سري للمدير فقط لعرض تقرير فوري
bot.command(['stats', 'admin'], async (ctx) => {
    const senderId = String(ctx.from.id);
    if (senderId !== ADMIN_ID) {
        return; // تجاهل أي شخص غير الأدمن
    }

    return ctx.reply(
        `👑 **لوحة تحكم المدير السريعة:**\n` +
        `━━━━━━━━━━━━━━━\n` +
        `👥 **مستخدمو الجلسة الحالية:** ${activeSessionUsers.size} شخص\n` +
        `🎯 **إجمالي الجولات والأنشطة:** ${totalPlaysCount} جولة\n` +
        `⚡ **حالة السيرفر:** متصل 24/7 على Vercel بنجاح.\n` +
        `━━━━━━━━━━━━━━━\n` +
        `💡 ملاحظة: كل مستخدم جديد أو نشاط يأتيك تقريره بتفاصيله في رسالة مستقلة أولاً بأول.`,
        { parse_mode: 'Markdown' }
    );
});

// أوامر القروبات
bot.command(['ludo', 'play'], async (ctx) => {
    await logActivityToAdmin(ctx, 'أنشأ طاولة لودو في محادثة/قروب');
    const room = generateRoomCode();
    const ludo = getFlexibleGames(room)[0];

    return ctx.reply(
        `🎲 **تم إنشاء طاولة لودو جديدة!**\n` +
        `👑 المنشئ: ${ctx.from.first_name}\n` +
        `🔑 رمز الغرفة: \`${room}\`\n\n` +
        `👉 تبدأ اللعبة فور دخول شخصين وتتسع حتى 4 لاعبين:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('🕹️ الدخول للطاولة', ludo.url)],
                [Markup.button.switchToChat('📢 دعوة أصدقاء', 'ludo')]
            ])
        }
    );
});

// أزرار التحكم
bot.action('start_ludo_flex', async (ctx) => {
    await ctx.answerCbQuery();
    await logActivityToAdmin(ctx, 'طلب طاولة لودو خاصة');
    const room = generateRoomCode();
    const ludoUrl = `https://ludo.party/?room=${room}`;

    await ctx.reply(
        `🎲 **طاولة لودو جاهزة (2 - 4 لاعبين)!**\n` +
        `🔑 كود الغرفة: \`${room}\`\n\n` +
        `اضغط بالأسفل للدخول أو شارك الطاولة مع أصدقائك:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('🕹️ دخول الطاولة', ludoUrl)],
                [Markup.button.switchToChat('📢 إرسال الرابط لصديق / قروب', `ludo_${room}`)],
                [Markup.button.callback('🔙 القائمة الرئيسية', 'menu_main')]
            ])
        }
    );
});

bot.action('start_uno_flex', async (ctx) => {
    await ctx.answerCbQuery();
    await logActivityToAdmin(ctx, 'طلب طاولة أونو خاصة');
    const room = generateRoomCode();
    const unoUrl = `https://play.unofreak.com/?room=${room}`;

    await ctx.reply(
        `🃏 **طاولة أونو جاهزة (2 - 4 لاعبين)!**\n` +
        `🔑 كود الغرفة: \`${room}\``,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('🕹️ دخول اللعبة', unoUrl)],
                [Markup.button.switchToChat('📢 إرسال الرابط للقروب', `uno_${room}`)],
                [Markup.button.callback('🔙 القائمة الرئيسية', 'menu_main')]
            ])
        }
    );
});

bot.action('action_flex_info', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        '💡 **كيف تعمل الطاولات المرنة؟**\n\n' +
        '1. بمجرد دخول شخصين، يظهر زر لبدء اللعبة فوراً كـ 1 ضد 1.\n' +
        '2. إذا انضم أشخاص إضافيون، تتسع الطاولة تلقائياً حتى 4 لاعبين.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 القائمة الرئيسية', 'menu_main')]])
    );
});

bot.action('menu_main', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        '🎮 **منصة ألعاب تيليجرام التفاعلية:**\nاختر من الخيارات بالأسفل:',
        { parse_mode: 'Markdown', ...getMainMenu() }
    );
});

// استعلامات الـ Inline في القروبات
bot.on('inline_query', async (ctx) => {
    await logActivityToAdmin(ctx, 'فتح قائمة التحديات السريعة (Inline)');
    const room = generateRoomCode();
    const games = getFlexibleGames(room);

    const results = games.map((game, index) => ({
        type: 'article',
        id: `flex_${index}_${room}`,
        title: game.title,
        description: game.desc,
        thumb_url: 'https://cdn-icons-png.flaticon.com/512/808/808439.png',
        input_message_content: {
            message_text:
                `⚔️ **دعوة تحدي مفتوحة!**\n\n` +
                `🎮 اللعبة: **${game.title}**\n` +
                `👑 منشئ التحدي: ${ctx.from.first_name}\n` +
                `🔑 رمز الطاولة: \`${room}\`\n\n` +
                `⚡ **تبدأ اللعبة فور دخول شخصين فقط، وتتسع حتى 4 لاعبين!**`,
            parse_mode: 'Markdown'
        },
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.webApp('🕹️ انضمام إلى الطاولة فوراً', game.url)]
        ])
    }));

    return ctx.answerInlineQuery(results, { cache_time: 0 });
});

// معالج Vercel الدائم
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Game Bot with Live Admin Logging is Live 24/7.');
    } catch (err) {
        return res.status(200).send('OK');
    }
};

module.exports.config = {
    maxDuration: 60
};
