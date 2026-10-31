const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

async function askGemini(prompt) {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
        return 'خطأ: لم يتم ضبط GEMINI_API_KEY في Vercel.';
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    // تسريع الاستجابة للحد الأقصى وإلغاء تأخير التفكير المعقد
                    thinkingConfig: {
                        thinkingLevel: "LOW"
                    },
                    maxOutputTokens: 1000
                }
            })
        });

        clearTimeout(timeout);
        const data = await response.json();

        if (response.status === 429) {
            return '⏳ تجاوزت الحد المسموح للخطة المجانية (5 رسائل/دقيقة). انتظر نصف دقيقة ثم أرسل سؤالك.';
        }

        if (response.status === 503) {
            return '⚡ سيرفرات غوغل تواجه ضغطاً مؤقتاً، يرجى المحاولة بعد قليل.';
        }

        if (!response.ok || data.error) {
            return `خطأ من السيرفر (${response.status}):\n${data.error ? data.error.message : 'تعذر إتمام الطلب'}`;
        }

        // استخراج الرد النهائي وتخطي مسودات التفكير
        if (data.candidates && data.candidates[0]?.content?.parts) {
            const parts = data.candidates[0].content.parts;
            const textPart = parts.find(p => !p.thought && p.text) || parts.find(p => p.text);
            if (textPart && textPart.text) {
                return textPart.text;
            }
        }

        return 'لم يتم استلام نص، يرجى إعادة صياغة السؤال.';
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
            return 'استغرق الرد وقتاً أطول من المعتاد، حاول مجدداً.';
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
