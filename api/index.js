const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

// توليد رقم غرفة عشوائي مستقل لكل طاولة
function generateRoomCode() {
    return Math.floor(100000 + Math.random() * 900000);
}

// قائمة الألعاب المرنة (تتكيف تلقائياً من 2 إلى 4 لاعبين فورياً)
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

// القائمة الرئيسية في الخاص
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
            Markup.button.callback('ℹ️ كيف يبدأ اللعب بثنائي؟', 'action_flex_info')
        ]
    ]);
}

bot.start((ctx) => {
    return ctx.reply(
        '🎮 **أهلاً بك في منصة الألعاب التفاعلية المرنة!**\n\n' +
        '• الطاولات مصممة لتتكيف تلقائياً: **إذا دخل شخصان فقط، يبدأ اللعب فوراً** كرأس برأس.\n' +
        '• إذا دخل 3 أو 4 لاعبين، تتحول الطاولة تلقائياً إلى تحدٍ جماعي كامل.\n\n' +
        'اضغط بالأسفل لبدء طاولة أو مشاركتها مع أصدقائك:',
        { parse_mode: 'Markdown', ...getMainMenu() }
    );
});

// أوامر القروبات المباشرة
bot.command(['ludo', 'play'], (ctx) => {
    const room = generateRoomCode();
    const ludo = getFlexibleGames(room)[0];

    return ctx.reply(
        `🎲 **تم إنشاء طاولة لودو مفتوحة!**\n` +
        `👑 المنشئ: ${ctx.from.first_name}\n` +
        `🔑 رمز الغرفة: \`${room}\`\n\n` +
        `⚡ **نظام اللعب:** تتسع من 2 إلى 4 لاعبين.\n` +
        `👉 بمجرد دخول لاعبين اثنين، يمكن الضغط على **Start** وبدء الجولة مباشرة دون انتظار!`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('🕹️ الدخول للطاولة واللعب', ludo.url)],
                [Markup.button.switchToChat('📢 مشاركة الروم بقروب آخر', 'ludo')]
            ])
        }
    );
});

// بدء لودو من المحادثة الخاصة
bot.action('start_ludo_flex', async (ctx) => {
    await ctx.answerCbQuery();
    const room = generateRoomCode();
    const ludoUrl = `https://ludo.party/?room=${room}`;

    await ctx.reply(
        `🎲 **طاولة لودو جاهزة (2 - 4 لاعبين)!**\n` +
        `🔑 كود الغرفة: \`${room}\`\n\n` +
        `💡 يمكنك الدخول والبدء مباشرة بمجرد انضمام صديقك، أو مشاركة الزر مع أصدقاء إضافيين:`,
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

// بدء أونو من المحادثة الخاصة
bot.action('start_uno_flex', async (ctx) => {
    await ctx.answerCbQuery();
    const room = generateRoomCode();
    const unoUrl = `https://play.unofreak.com/?room=${room}`;

    await ctx.reply(
        `🃏 **طاولة أونو جاهزة (2 - 4 لاعبين)!**\n` +
        `🔑 كود الغرفة: \`${room}\`\n\n` +
        `💡 تبدأ الجولة فور انضمام شخصين، ويمكن انضمام حتى 4 لاعبين:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('🕹️ دخول اللعبة', unoUrl)],
                [Markup.button.switchToChat('📢 إرسال الرابط لصديق / قروب', `uno_${room}`)],
                [Markup.button.callback('🔙 القائمة الرئيسية', 'menu_main')]
            ])
        }
    );
});

// شرح نظام اللعب التكيفي
bot.action('action_flex_info', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        '💡 **كيف تعمل الطاولات المرنة؟**\n\n' +
        '1. عند إنشاء الغرفة، يكون الحد الأقصى 4 لاعبين.\n' +
        '2. إذا انضم **شخص واحد فقط معك** (أصبحتم 2)، يظهر لك في شاشة اللعبة زر أخضر لبدء اللعبة فوراً كـ 1 ضد 1.\n' +
        '3. لستم مضطرين لانتظار بقية اللاعبين؛ ابدأوا اللعب فوراً، واللعبة ستغلق المقاعد الفارغة تلقائياً.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 القائمة الرئيسية', 'menu_main')]])
    );
});

// العودة للقائمة
bot.action('menu_main', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        '🎮 **منصة ألعاب تيليجرام التفاعلية:**\nاختر من الخيارات بالأسفل:',
        { parse_mode: 'Markdown', ...getMainMenu() }
    );
});

// دعم الإرسال المباشر لأي محادثة أو قروب (Inline Query)
bot.on('inline_query', async (ctx) => {
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
                `⚡ **تبدأ اللعبة فور دخول شخصين فقط، وتتسع حتى 4 لاعبين!**\n` +
                `اضغطوا على الزر بالأسفل للانضمام معاً 👇`,
            parse_mode: 'Markdown'
        },
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.webApp('🕹️ انضمام إلى الطاولة فوراً', game.url)]
        ])
    }));

    return ctx.answerInlineQuery(results, { cache_time: 0 });
});

// معالج Vercel
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Flexible Multiplayer Bot is active 24/7.');
    } catch (err) {
        return res.status(200).send('OK');
    }
};

module.exports.config = {
    maxDuration: 60
};
