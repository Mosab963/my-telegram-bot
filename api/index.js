const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

// دالة تفحص مفتاح غوغل وتعيد السبب الحرفي في حال الرفض
async function askGemini(prompt) {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();

    if (!apiKey) {
        return 'تنبيه: متغير GEMINI_API_KEY غير موجود في إعدادات Vercel إطلاقاً.';
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
        })
    });

    const data = await response.json();

    // إذا أعادت غوغل أي خطأ يظهر مباشرة بالرسالة
    if (!response.ok || data.error) {
        return `خطأ من غوغل (${response.status}):\n${data.error ? data.error.message : JSON.stringify(data)}`;
    }

    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text;
    }

    return 'لم يتم استلام نص من النموذج، الرد فارغ.';
}

bot.start((ctx) => {
    return ctx.reply('أهلاً بك! البوت متصل الآن. اكتب رسالتك وسأجيبك فوراً.');
});

bot.on('text', async (ctx) => {
    try {
        await ctx.sendChatAction('typing');
        const reply = await askGemini(ctx.message.text);

        // تقسيم الرسالة تلقائياً إذا كانت طويلة
        if (reply.length > 4000) {
            for (let i = 0; i < reply.length; i += 4000) {
                await ctx.reply(reply.slice(i, i + 4000));
            }
        } else {
            await ctx.reply(reply);
        }
    } catch (err) {
        await ctx.reply(`خطأ برمجي داخلي:\n${err.message}`);
    }
});

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Live 24/7');
    } catch (err) {
        return res.status(500).send(err.message);
    }
};
