const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

// منع تيليجرام من إعادة إرسال نفس الرسالة واستهلاك الرصيد المجاني
const processedUpdates = new Set();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callModel(model, prompt, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
        })
    });

    const data = await response.json();
    return { status: response.status, ok: response.ok, data };
}

async function askGemini(prompt) {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
        return 'خطأ: لم يتم ضبط GEMINI_API_KEY في Vercel.';
    }

    // النماذج المعتمدة للحسابات الجديدة (الأساسي + البديل المجاني المفتوح عند امتلاء الحد)
    const models = ['gemini-3.8-flash', 'gemma-3-27b-it', 'gemma-3-12b-it'];
    let lastError = '';

    for (const model of models) {
        try {
            let res = await callModel(model, prompt, apiKey);

            // إذا كان هناك ضغط لحظي (503) نعيد المحاولة مرة واحدة بعد ثانيتين
            if (res.status === 503) {
                await sleep(2000);
                res = await callModel(model, prompt, apiKey);
            }

            if (res.ok && res.data.candidates && res.data.candidates[0]?.content?.parts) {
                const parts = res.data.candidates[0].content.parts;
                const answer = parts.filter(p => !p.thought && p.text).map(p => p.text).join('\n') || parts[0]?.text;
                if (answer) return answer;
            }

            lastError = `${res.status}: ${res.data.error?.message || 'Unknown error'}`;
        } catch (err) {
            lastError = err.message;
        }
    }

    return `تعذر الحصول على رد حالياً (${lastError})`;
}

bot.start((ctx) => {
    return ctx.reply('أهلاً بك! البوت متصل وجاهز للرد على أسئلتك.');
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
        await ctx.reply('حدث خطأ أثناء إرسال الرد.');
    }
});

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST' && req.body) {
            const updateId = req.body.update_id;
            if (updateId && processedUpdates.has(updateId)) {
                return res.status(200).send('OK');
            }
            if (updateId) {
                processedUpdates.add(updateId);
                if (processedUpdates.size > 200) {
                    const first = processedUpdates.values().next().value;
                    processedUpdates.delete(first);
                }
            }

            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Bot is running 24/7.');
    } catch (err) {
        return res.status(200).send('OK');
    }
};

module.exports.config = {
    maxDuration: 60
};
