const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

// دالة اتصال مباشر ومضمونة 100% مع واجهة غوغل الرسمية
async function askGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY is missing');
    }

    // تجربة أحدث النماذج المتاحة مجاناً بالترتيب
    const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];

    for (const model of models) {
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }]
                })
            });

            const data = await response.json();

            if (response.ok && data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
                return data.candidates[0].content.parts[0].text;
            }

            console.error(`Model ${model} response error:`, JSON.stringify(data));
        } catch (err) {
            console.error(`Request failed for model ${model}:`, err);
        }
    }

    throw new Error('All AI models failed to respond.');
}

// أمر البدء
bot.start((ctx) => {
    return ctx.reply('أهلاً بك! أنا بوت ذكاء اصطناعي أعمل بنظام Webhook الدائم 24/7 وبأعلى سرعة. تفضل واسألني أي شيء!');
});

// استقبال ومعالجة الرسائل
bot.on('text', async (ctx) => {
    const text = ctx.message.text;

    try {
        await ctx.sendChatAction('typing');

        const reply = await askGemini(text);

        // تيليجرام يرفض أي رسالة تتجاوز 4096 حرف، هنا نقسم الردود الطويلة تلقائياً
        if (reply.length > 4000) {
            for (let i = 0; i < reply.length; i += 4000) {
                await ctx.reply(reply.slice(i, i + 4000));
            }
        } else {
            await ctx.reply(reply);
        }
    } catch (error) {
        console.error('Bot Handling Error:', error);
        await ctx.reply('حدث خطأ أثناء معالجة الطلب، يرجى المحاولة لاحقاً.');
    }
});

// معالج Webhook المعتمد لمنصة Vercel
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Bot is live and running 24/7 on Vercel!');
    } catch (err) {
        console.error('Webhook execution error:', err);
        return res.status(500).send('Internal Server Error');
    }
};
