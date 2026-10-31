const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

// جلب المفاتيح ودعم وضع أكثر من مفتاح مفصولين بفاصلة لمضاعفة السرعة والحد
function getApiKeys() {
    const raw = process.env.GEMINI_API_KEY || '';
    return raw.split(',').map(k => k.trim()).filter(Boolean);
}

let keyIndex = 0;

async function askGemini(prompt) {
    const keys = getApiKeys();
    if (keys.length === 0) {
        return 'خطأ: لم يتم تعيين GEMINI_API_KEY في Vercel.';
    }

    // تدوير المفتاح المستخدم في كل طلب
    const currentKey = keys[keyIndex % keys.length];
    keyIndex++;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${currentKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 1000
                }
            })
        });

        clearTimeout(timeout);
        const data = await response.json();

        // معالجة قيود الاستخدام وضغط السيرفرات باحترافية
        if (response.status === 429) {
            return '⏳ تجاوزت الحد المسموح للخطة المجانية (5 رسائل/دقيقة). انتظر 30 ثانية وجرب مجدداً.';
        }

        if (response.status === 503) {
            return '⚡ سيرفرات الذكاء الاصطناعي تشهد ضغطاً مؤقتاً، يرجى إعادة إرسال سؤالك بعد لحظات.';
        }

        if (!response.ok || data.error) {
            return `تنبيه من غوغل (${response.status}):\n${data.error ? data.error.message : 'تعذر إتمام الطلب'}`;
        }

        if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
            return data.candidates[0].content.parts[0].text;
        }

        return 'لم يصل رد من النموذج، حاول بصيغة أخرى.';
    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
            return 'استغرق الطلب وقتاً أطول من المعتاد، حاول مرة ثانية.';
        }
        return `خطأ اتصال:\n${err.message}`;
    }
}

bot.start((ctx) => {
    return ctx.reply('أهلاً بك! أنا بوت ذكاء اصطناعي أعمل 24/7. تفضل بإرسال سؤالك.');
});

bot.on('text', async (ctx) => {
    try {
        ctx.sendChatAction('typing').catch(() => {});
        const reply = await askGemini(ctx.message.text);

        // تقسيم الرسائل الطويلة تلقائياً
        if (reply.length > 4000) {
            for (let i = 0; i < reply.length; i += 4000) {
                await ctx.reply(reply.slice(i, i + 4000));
            }
        } else {
            await ctx.reply(reply);
        }
    } catch (err) {
        await ctx.reply('تعذر إرسال الرسالة، يرجى المحاولة لاحقاً.');
    }
});

const handler = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Bot is live and running 24/7.');
    } catch (err) {
        return res.status(500).send('Error');
    }
};

module.exports = handler;
module.exports.config = {
    maxDuration: 60
};
