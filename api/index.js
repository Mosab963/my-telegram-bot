const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

// متغير لتخزين النموذج الشغال تلقائياً لتسريع الردود اللاحقة
let activeModel = null;

// دالة لجلب أفضل نموذج يدعمه مفتاحك من غوغل مباشرة
async function resolveWorkingModel(apiKey) {
    if (activeModel) return activeModel;

    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const res = await fetch(listUrl);
    const data = await res.json();

    if (!res.ok || !data.models) {
        throw new Error(data.error?.message || 'فشل جلب قائمة النماذج من غوغل.');
    }

    // فلترة النماذج الداعمة لتوليد النصوص
    const generateModels = data.models.filter(m => 
        m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent')
    );

    if (generateModels.length === 0) {
        throw new Error('لا يوجد أي نموذج توليد نصوص متاح لهذا المفتاح.');
    }

    // اختيار أحدث نموذج Flash متاح، أو أول نموذج نصوص معتمد
    const chosen = generateModels.find(m => m.name.includes('flash') && (m.name.includes('2.5') || m.name.includes('2.0')))
                || generateModels.find(m => m.name.includes('flash'))
                || generateModels[0];

    activeModel = chosen.name; // الاسم جاهز بصيغة models/xxxx
    return activeModel;
}

// دالة إرسال الطلب لـ Gemini
async function askGemini(prompt) {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
        return 'تنبيه: متغير GEMINI_API_KEY غير موجود في إعدادات Vercel.';
    }

    try {
        const modelName = await resolveWorkingModel(apiKey);
        const url = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });

        const data = await response.json();

        if (!response.ok || data.error) {
            activeModel = null; // إعادة ضبط للبحث عن نموذج بديل في حال حدوث عطل
            return `خطأ في المعالجة (${response.status}):\n${data.error ? data.error.message : JSON.stringify(data)}`;
        }

        if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
            return data.candidates[0].content.parts[0].text;
        }

        return 'تم استلام رد فارغ من الذكاء الاصطناعي.';
    } catch (err) {
        activeModel = null;
        return `تعذر الاتصال بـ Gemini:\n${err.message}`;
    }
}

bot.start((ctx) => {
    return ctx.reply('أهلاً بك! البوت متصل بالذكاء الاصطناعي ويعمل 24/7. اكتب رسالتك وسأجيبك فوراً.');
});

bot.on('text', async (ctx) => {
    try {
        await ctx.sendChatAction('typing');
        const reply = await askGemini(ctx.message.text);

        // تقسيم الرسائل الطويلة تلقائياً لتفادي حدود تيليجرام
        if (reply.length > 4000) {
            for (let i = 0; i < reply.length; i += 4000) {
                await ctx.reply(reply.slice(i, i + 4000));
            }
        } else {
            await ctx.reply(reply);
        }
    } catch (err) {
        await ctx.reply(`خطأ تقني:\n${err.message}`);
    }
});

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            return res.status(200).send('OK');
        }
        return res.status(200).send('Bot is live and running 24/7 on Vercel!');
    } catch (err) {
        return res.status(500).send(err.message);
    }
};
