const { Telegraf } = require('telegraf');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot is active and running 24/7!');
});

app.listen(PORT, () => {
    console.log(`Web server is running on port ${PORT}`);
});

const bot = new Telegraf(process.env.BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const ADMIN_ID = process.env.ADMIN_ID;

const DB_FILE = './users.json';

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ proUsers: [], usage: {} }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function checkAndUpdateUsage(userId) {
    const db = loadDB();
    const today = new Date().toISOString().split('T')[0];
    
    if (!db.usage[userId] || db.usage[userId].date !== today) {
        db.usage[userId] = { date: today, count: 0 };
    }

    let limit = 5; 
    if (userId.toString() === ADMIN_ID || db.proUsers.includes(userId.toString())) {
        limit = 100; 
    }

    if (db.usage[userId].count >= limit) {
        return { allowed: false, limit };
    }

    db.usage[userId].count += 1;
    saveDB(db);
    return { allowed: true, remaining: limit - db.usage[userId].count };
}

bot.command('addpro', (ctx) => {
    if (ctx.from.id.toString() !== ADMIN_ID) return ctx.reply('للمدير فقط.');
    const args = ctx.message.text.split(' ');
    if (args.length < 2) return ctx.reply('استخدم: /addpro [ID]');
    
    const db = loadDB();
    const targetId = args[1];
    if (!db.proUsers.includes(targetId)) {
        db.proUsers.push(targetId);
        saveDB(db);
        ctx.reply(`تمت إضافة ${targetId} للـ Pro بنجاح.`);
    } else {
        ctx.reply('المستخدم موجود مسبقاً.');
    }
});

bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const db = loadDB();
    
    // استخدام النماذج المستقرة المعتمدة
    let modelName = 'gemini-1.5-flash';

    if (userId === ADMIN_ID || db.proUsers.includes(userId)) {
        modelName = 'gemini-1.5-pro';
    }

    const usageCheck = checkAndUpdateUsage(userId);
    if (!usageCheck.allowed) {
        return ctx.reply(`عذراً، خلص رصيدك اليومي (${usageCheck.limit} رسائل).`);
    }

    try {
        await ctx.sendChatAction('typing');
        const response = await ai.models.generateContent({
            model: modelName,
            contents: ctx.message.text,
        });
        await ctx.reply(response.text);
    } catch (err) {
        console.error(err);
        await ctx.reply('صار في خطأ تقني، حاول مرة تانية.');
    }
});

bot.launch();
console.log('Telegram Bot is running...');
