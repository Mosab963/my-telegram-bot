const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

// قاعدة بيانات لأشهر الألعاب السحابية الخفيفة الجاهزة للتشغيل المباشر داخل تيليجرام
const gamesLibrary = [
    { id: '2048', title: '🔢 لعبة 2048 العبقرية', category: 'puzzle', url: 'https://play2048.co/' },
    { id: 'tetris', title: '🧱 تيتريس كلاسيك (Tetris)', category: 'classic', url: 'https://chvin.github.io/react-tetris/' },
    { id: 'hextris', title: '🔷 هيكستريس السريعة (Hextris)', category: 'arcade', url: 'https://hextris.io/' },
    { id: 'snake', title: '🐍 لعبة الثعبان الأصلية (Snake)', category: 'classic', url: 'https://playsnake.org/' },
    { id: 'pacman', title: '🟡 باك مان (Pac-Man)', category: 'classic', url: 'https://freepacman.org/' },
    { id: 'doodle', title: '🦘 دودل جمب (Doodle Jump)', category: 'action', url: 'https://apps.thesmartweb.net/doodle-jump/' },
    { id: 'sudoku', title: '🧩 سودوكو التحدي (Sudoku)', category: 'puzzle', url: 'https://sudoku.com/' },
    { id: 'chess', title: '♟️ شطرنج عالمي (Chess)', category: 'puzzle', url: 'https://lichess.org/' },
    { id: 'flappy', title: '🐤 فلابي بيرد (Flappy Bird)', category: 'arcade', url: 'https://flappybird.io/' }
];

// القائمة الرئيسية لمنصة الألعاب
function getMainMenu() {
    return Markup.inlineKeyboard([
        [
            Markup.button.webApp('🌐 صالة الألعاب اللانهائية (GameSnacks)', 'https://gamesnacks.com/')
        ],
        [
            Markup.button.callback('🎲 لعبة عشوائية', 'action_random'),
            Markup.button.callback('📂 تصفح حسب القسم', 'action_categories')
        ],
        [
            Markup.button.callback('🔥 الألعاب الأكثر شعبية', 'action_popular'),
            Markup.button.callback('ℹ️ تعليمات البحث', 'action_help')
        ]
    ]);
}

bot.start((ctx) => {
    return ctx.reply(
        '🎮 **مرحباً بك في أضخم صالة ألعاب على تيليجرام!**\n\n' +
        '• اضغط على **صالة الألعاب اللانهائية** لتفتح مئات الألعاب وتلعبها بملء الشاشة.\n' +
        '• تصفح الألعاب الجاهزة بالأسفل أو اختر لعبة عشوائية.\n' +
        '• أو اكتب اسم أي لعبة بالدردشة مباشرة وسأحضرها لك!',
        { parse_mode: 'Markdown', ...getMainMenu() }
    );
});

// صالة الألعاب الأكثر شعبية
bot.action('action_popular', async (ctx) => {
    await ctx.answerCbQuery();
    const buttons = gamesLibrary.slice(0, 5).map(g => [Markup.button.webApp(g.title, g.url)]);
    buttons.push([Markup.button.callback('🔙 القائمة الرئيسية', 'menu_main')]);

    await ctx.editMessageText(
        '🔥 **أقوى الألعاب السريعة (اختر وابدأ اللعب فوراً داخل الشات):**',
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
});

// اختيار لعبة عشوائية
bot.action('action_random', async (ctx) => {
    await ctx.answerCbQuery();
    const randomGame = gamesLibrary[Math.floor(Math.random() * gamesLibrary.length)];

    await ctx.reply(
        `🎲 **وقع الاختيار على:**\n👉 **${randomGame.title}**\n\nاضغط بالأسفل للتشغيل فوراً:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('🕹️ العب الآن', randomGame.url)],
                [Markup.button.callback('🔄 اختر لعبة تانية', 'action_random')]
            ])
        }
    );
});

// تصنيفات الألعاب
bot.action('action_categories', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        '📂 **اختر قسم الألعاب المفضل لديك:**',
        Markup.inlineKeyboard([
            [
                Markup.button.callback('🧠 ذكاء وألغاز', 'cat_puzzle'),
                Markup.button.callback('🕹️ كلاسيك وريترو', 'cat_classic')
            ],
            [
                Markup.button.callback('⚡ آركيد وسرعة', 'cat_arcade'),
                Markup.button.webApp('🏎️ سيارات وأكشن', 'https://gamesnacks.com/category/action')
            ],
            [Markup.button.callback('🔙 القائمة الرئيسية', 'menu_main')]
        ])
    );
});

// عرض ألعاب قسم معين
bot.action(/cat_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const cat = ctx.match[1];
    const filtered = gamesLibrary.filter(g => g.category === cat);

    const buttons = filtered.map(g => [Markup.button.webApp(g.title, g.url)]);
    buttons.push([Markup.button.callback('🔙 رجوع للأقسام', 'action_categories')]);

    await ctx.editMessageText(
        `🎮 **ألعاب قسم (${cat}):**\nاضغط على أي لعبة لتشغيلها مباشرة:`,
        Markup.inlineKeyboard(buttons)
    );
});

// تعليمات البحث
bot.action('action_help', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        '🔍 **كيف تبحث عن أي لعبة؟**\n\n' +
        'فقط اكتب اسم اللعبة في المحادثة مباشرة، مثل:\n' +
        '• `شطرنج`\n' +
        '• `تيتريس`\n' +
        '• `2048`\n' +
        '• `ثعبان`\n\n' +
        'وسيقوم البوت بإرسال بطاقة تشغيل اللعبة فوراً.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 القائمة الرئيسية', 'menu_main')]])
    );
});

// العودة للقائمة الرئيسية
bot.action('menu_main', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        '🎮 **مرحباً بك في أضخم صالة ألعاب على تيليجرام!**\nاختر من القائمة بالأسفل:',
        { parse_mode: 'Markdown', ...getMainMenu() }
    );
});

// البحث اللحظي بالنص
bot.on('text', async (ctx) => {
    const query = ctx.message.text.trim().toLowerCase();
    
    if (query === '/start') return;

    // البحث في المكتبة المحلية أولاً
    const match = gamesLibrary.find(g => 
        g.title.toLowerCase().includes(query) || g.id.includes(query)
    );

    if (match) {
        return ctx.reply(
            `🎯 وجدنا لعبتك:\n**${match.title}**`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.webApp('🕹️ ابدأ اللعب الآن', match.url)],
                    [Markup.button.callback('🎮 القائمة الرئيسية', 'menu_main')]
                ])
            }
        );
    }

    // إذا كانت لعبة أخرى عامة، يوفر لها بحثاً وتشغيلاً مباشراً من البوابة الكبرى
    const searchUrl = `https://gamesnacks.com/search?q=${encodeURIComponent(query)}`;
    return ctx.reply(
        `🔍 لم نجد "${ctx.message.text}" في المفضلة السريعة، لكن يمكنك تشغيلها والبحث عنها في الصالة الكبرى:`,
        Markup.inlineKeyboard([
            [Markup.button.webApp(`🔎 تشغيل والبحث عن "${ctx.message.text}"`, searchUrl)],
            [Markup.button.callback('🔙 القائمة الرئيسية', 'menu_main')]
        ])
    );
});

// معالج سيرفر Vercel بنظام Webhook المستقر 100%
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Arcade Platform Bot is Live 24/7.');
    } catch (err) {
        return res.status(200).send('OK');
    }
};

module.exports.config = {
    maxDuration: 60
};
