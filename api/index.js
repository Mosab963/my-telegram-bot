const { Telegraf } = require('telegraf');
const { GoogleGenAI } = require('@google/genai');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const ADMIN_ID = process.env.ADMIN_ID;

// أمر البداية
bot.start((ctx) => {
    ctx.reply('أهلاً بك! أنا بوت ذكاء اصطناعي أعمل بنظام Webhook وسريع الاستجابة.');
});

// التعامل مع الرسائل
bot.on('text', async (ctx) => {
    const text = ctx.message.text;

    try {
        await ctx.sendChatAction('typing');
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: text,
        });

        await ctx.reply(response.text);
    } catch (err) {
        console.error(err);
        await ctx.reply('حدث خطأ تقني، يرجى المحاولة لاحقاً.');
    }
});

// الدالة المسؤولة عن استقبال رسائل التيليجرام عبر Vercel
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            res.status(200).send('OK');
        } else {
            res.status(200).send('Bot Webhook is running 24/7 on Vercel!');
        }
    } catch (error) {
        console.error(error);
        res.status(500).send('Error');
    }
};
