const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

async function askGemini(prompt) {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
        return 'تنبيه: متغير GEMINI_API_KEY غير موجود في إعدادات Vercel.';
    }

    // الاعتماد المباشر على النموذج المطلوب رسمياً من غوغل
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
        })
    });

    const data = await response.json();

    if (!response.ok || data.error) {
        return `خطأ من غوغل (${response.status}):\n${data.error ? data.error.message : JSON.stringify(data)}`;
    }

    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text;
    }

    return 'لم يتم استلام رد من النموذج.';
}

bot.start((ctx) => {
    return ctx.reply('أهلاً بك! البوت متصل بالذكاء الاصطناعي وجاهز للعمل 24/7. اسألني أي شيء!');
});

bot.on('text', async (ctx) => {
    try {
        await ctx.sendChatAction('typing');
        const reply = await askGemini(ctx.message.text);

        if (reply.length > 4000) {
            for (let i = 0; i < reply.length; i += 4000) {
                await ctx.reply(reply.slice(i, i + 4000));
            }
        } else {
            await ctx.reply(reply);
        }
    } catch (err) {
        await ctx.reply(`خطأ داخلي:\n${err.message}`);
    }
});

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Live 24/7 on Vercel');
    } catch (err) {
        return res.status(500).send(err.message);
    }
};
