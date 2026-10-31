const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ذاكرة سريعة لمنع تكرار التحديثات من تيليجرام واستهلاك الحصة المجانية
const processedUpdates = new Set();

// دعم مفتاح واحد أو عدة مفاتيح مفصولة بفاصلة لمضاعفة حد الاستخدام
function getApiKeys() {
    const raw = process.env.GEMINI_API_KEY || '';
    return raw.split(',').map(k => k.trim()).filter(Boolean);
}

let keyIndex = 0;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function requestGemini(prompt, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });

        clearTimeout(timeout);
        const data = await response.json();
        return { status: response.status, ok: response.ok, data };
    } catch (err) {
        clearTimeout(timeout);
        return { status: 0, ok: false, error: err };
    }
}

async function askGemini(prompt) {
    const keys = getApiKeys();
    if (keys.length === 0) {
        return '⚠️ خطأ: لم يتم ضبط GEMINI_API_KEY في إعدادات Vercel.';
    }

    // تجربة المفاتيح المتاحة بالتناوب في حال تجاوز حد أحدهم
    for (let i = 0; i < keys.length; i++) {
        const apiKey = keys[(keyIndex + i) % keys.length];

        // محاولتان لكل مفتاح في حال وجود ضغط لحظي (503)
        for (let attempt = 1; attempt <= 2; attempt++) {
            const res = await requestGemini(prompt, apiKey);

            // استلام الرد بنجاح
            if (res.ok && res.data?.candidates?.[0]?.content?.parts) {
                keyIndex = (keyIndex + i + 1) % keys.length;
                const parts = res.data.candidates[0].content.parts;
                const text = parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n') || parts[0]?.text;
                if (text) return text;
            }

            // ضغط مؤقت على سيرفر غوغل (503)
            if (res.status === 503 && attempt === 1) {
                await sleep(2000);
                continue;
            }

            // استنفاد حد الـ 5 رسائل (429)
            if (res.status === 429) {
                if (keys.length > 1 && i < keys.length - 1) {
                    break; // الانتقال للمفتاح الاحتياطي التالي مباشرة
                }
                return '⏳ استهلكت حد الرسائل المجاني (5 رسائل/دقيقة). انتظر 20 ثانية ثم أرسل سؤالك.';
            }

            if (attempt === 2 || (res.status !== 503 && res.status !== 429)) {
                break;
            }
        }
    }

    return '⚡ سيرفرات الذكاء الاصطناعي تشهد ضغطاً مؤقتاً، يرجى إعادة المحاولة بعد لحظات.';
}

bot.start((ctx) => {
    return ctx.reply('أهلاً بك! أنا بوت ذكاء اصطناعي أعمل 24/7. اسألني أي شيء وسأجيبك فوراً.');
});

bot.on('text', async (ctx) => {
    try {
        ctx.sendChatAction('typing').catch(() => {});
        const reply = await askGemini(ctx.message.text);

        if (reply && reply.length > 4000) {
            for (let i = 0; i < reply.length; i += 4000) {
                await ctx.reply(reply.slice(i, i + 4000));
            }
        } else {
            await ctx.reply(reply || 'لم يتم استلام رد، حاول مرة ثانية.');
        }
    } catch (err) {
        console.error(err);
        await ctx.reply('تعذر إرسال الإجابة، يرجى المحاولة لاحقاً.');
    }
});

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST' && req.body) {
            const updateId = req.body.update_id;
            if (updateId) {
                if (processedUpdates.has(updateId)) {
                    return res.status(200).send('OK');
                }
                processedUpdates.add(updateId);
                if (processedUpdates.size > 150) {
                    const firstItem = processedUpdates.values().next().value;
                    processedUpdates.delete(firstItem);
                }
            }

            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Bot is live and running 24/7 on Vercel.');
    } catch (err) {
        console.error(err);
        return res.status(200).send('OK');
    }
};

module.exports.config = {
    maxDuration: 60
};
