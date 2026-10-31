const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

async function askGemini(prompt) {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
        return 'خطأ: لم يتم ضبط GEMINI_API_KEY في Vercel.';
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;

    // مهلة أمان قصوى 50 ثانية لمنع أي انقطاع ذاتي
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 50000);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 1000,
                    thinkingConfig: {
                        thinkingBudget: 0 // إيقاف التفكير كلياً لتوليد الرد فوراً خلال ثوانٍ معدودة
                    }
                }
            })
        });

        clearTimeout(timeout);
        const data = await response.json();

        if (response.status === 429) {
            return '⏳ تجاوزت حد الرسائل المجاني مؤقتاً (5 رسائل/دقيقة). انتظر نصف دقيقة وجرب مجدداً.';
        }

        if (response.status === 503) {
            return '⚡ ضغط مؤقت على سيرفرات غوغل، أعد إرسال سؤالك الآن.';
        }

        if (!response.ok || data.error) {
            return `خطأ من غوغل (${response.status}):\n${data.error ? data.error.message : 'تعذر إتمام الطلب'}`;
        }

        if (data.candidates && data.candidates[0]?.content?.parts) {
            const parts = data.candidates[0].content.parts;
            const textPart = parts.find(p => !p.thought && p.text) || parts.find(p => p.text);
            if (textPart && textPart.text) {
                return textPart.text;
            }
        }

        return 'لم يتم استلام نص، يرجى إعادة إرسال السؤال.';
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
            return 'استغرق السيرفر وقتاً طويلاً في المعالجة، حاول مجدداً.';
        }
        return `خطأ داخلي:\n${err.message}`;
    }
}

bot.start((ctx) => {
    return ctx.reply('أهلاً بك! البوت جاهز للاستخدام الفوري والسريع. تفضل بإرسال سؤالك!');
});

bot.on('text', async (ctx) => {
    try {
        ctx.sendChatAction('typing').catch(() => {});
        const reply = await askGemini(ctx.message.text);

        if (reply.length > 4000) {
            for (let i = 0; i < reply.length; i += 4000) {
                await ctx.reply(reply.slice(i, i + 4000));
            }
        } else {
            await ctx.reply(reply);
        }
    } catch (err) {
        await ctx.reply('تعذر إرسال الرسالة.');
    }
});

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Bot is live and fast.');
    } catch (err) {
        return res.status(500).send('Error');
    }
};

module.exports.config = {
    maxDuration: 60
};
