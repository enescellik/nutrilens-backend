const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const db = new sqlite3.Database('nutrilens.db');

db.run(`
  CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    name TEXT,
    description TEXT,
    portion TEXT,
    calories REAL,
    protein REAL,
    carbs REAL,
    fat REAL,
    fiber REAL,
    sugar REAL,
    sodium REAL,
    potassium REAL,
    calcium REAL,
    iron REAL,
    vitamin_c REAL,
    vitamin_a REAL,
    source TEXT,
    image_base64 TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const userStates = {};
const GEMINI_MODEL = 'gemini-2.0-flash';

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/meals', (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  db.all('SELECT * FROM meals WHERE date = ? ORDER BY created_at ASC', [date], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/meals', (req, res) => {
  const m = req.body;
  const date = m.date || new Date().toISOString().split('T')[0];
  db.run(
    `INSERT INTO meals (date, name, description, portion, calories, protein, carbs, fat, fiber, sugar, sodium, potassium, calcium, iron, vitamin_c, vitamin_a, source, image_base64)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [date, m.name, m.description, m.portion, m.calories, m.protein, m.carbs, m.fat, m.fiber, m.sugar, m.sodium, m.potassium, m.calcium, m.iron, m.vitamin_c, m.vitamin_a, m.source, m.image_base64],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, ...m });
    }
  );
});

app.delete('/meals/:id', (req, res) => {
  db.run('DELETE FROM meals WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

async function geminiText(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
      })
    }
  );
  const data = await response.json();
  if (!data.candidates || !data.candidates[0]) throw new Error('Gemini yanıt vermedi: ' + JSON.stringify(data));
  const text = data.candidates[0].content.parts[0].text;
  return text.replace(/```json/g, '').replace(/```/g, '').trim();
}

async function geminiImage(imageBase64, mediaType, prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mediaType, data: imageBase64 } },
            { text: prompt }
          ]
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
      })
    }
  );
  const data = await response.json();
  if (!data.candidates || !data.candidates[0]) throw new Error('Gemini yanıt vermedi: ' + JSON.stringify(data));
  const text = data.candidates[0].content.parts[0].text;
  return text.replace(/```json/g, '').replace(/```/g, '').trim();
}

const JSON_TEMPLATE = '{"name":"food name in Turkish","description":"brief","portion":"amount","calories":0,"protein":0,"carbs":0,"fat":0,"fiber":0,"sugar":0,"sodium":0,"potassium":0,"calcium":0,"iron":0,"vitamin_c":0,"vitamin_a":0,"source":"source"}';

async function analyzeWithGemini(imageBase64, mediaType) {
  const prompt = `Analyze this food image. Reply ONLY with this JSON, no markdown: ${JSON_TEMPLATE}`;
  const clean = await geminiImage(imageBase64, mediaType, prompt);
  return JSON.parse(clean);
}

async function analyzeTextFood(userText) {
  const prompt = `User ate: "${userText}". Calculate nutritional values. Reply ONLY with this JSON, no markdown: ${JSON_TEMPLATE}`;
  const clean = await geminiText(prompt);
  return JSON.parse(clean);
}

async function recalculateWithPortion(foodData, portionText) {
  const prompt = `Food: ${foodData.name}, original portion: ${foodData.portion}, original calories: ${foodData.calories}kcal. User actually ate: "${portionText}". Recalculate all nutritional values. Reply ONLY with this JSON, no markdown: ${JSON_TEMPLATE}`;
  const clean = await geminiText(prompt);
  return JSON.parse(clean);
}

app.post('/analyze', upload.single('image'), async (req, res) => {
  try {
    const result = await analyzeWithGemini(req.file.buffer.toString('base64'), req.file.mimetype);
    res.json(result);
  } catch (err) {
    console.error('Analiz hatası:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function telegramRequest(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

async function sendMessage(chatId, text, keyboard) {
  const body = { chat_id: chatId, text };
  if (keyboard) body.reply_markup = { keyboard, resize_keyboard: true, one_time_keyboard: true };
  return telegramRequest('sendMessage', body);
}

function saveMealToDB(result) {
  const date = new Date().toISOString().split('T')[0];
  db.run(
    `INSERT INTO meals (date, name, description, portion, calories, protein, carbs, fat, fiber, sugar, sodium, potassium, calcium, iron, vitamin_c, vitamin_a, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [date, result.name, result.description, result.portion, result.calories, result.protein, result.carbs, result.fat, result.fiber, result.sugar, result.sodium, result.potassium, result.calcium, result.iron, result.vitamin_c, result.vitamin_a, result.source]
  );
}

function mealSummary(result) {
  return `✅ ${result.name} kaydedildi!\n\n🔥 ${Math.round(result.calories||0)} kcal\n💪 Protein: ${Math.round(result.protein||0)}g\n🍞 Karb: ${Math.round(result.carbs||0)}g\n🧈 Yağ: ${Math.round(result.fat||0)}g\n📌 ${result.source||'-'}`;
}

app.post('/telegram', async (req, res) => {
  res.json({ ok: true });
  const update = req.body;
  if (!update.message) return;

  const chatId = update.message.chat.id;
  const text = update.message.text;
  const photo = update.message.photo;
  const state = userStates[chatId];

  if (text === '/start') {
    userStates[chatId] = null;
    await sendMessage(chatId, '🥗 NutriLens\'e hoş geldin!\n\nYemek fotoğrafı gönder veya ne yediğini yaz.\n\nÖrnekler:\n• "2 adet elma"\n• "Ülker çikolata 1 paket"\n• "1 porsiyon mercimek çorbası"\n\nKomutlar:\n/bugun - günlük özet\n/iptal - işlemi iptal et');
    return;
  }

  if (text === '/iptal') {
    userStates[chatId] = null;
    await sendMessage(chatId, '❌ İptal edildi.');
    return;
  }

  if (text === '/bugun') {
    const date = new Date().toISOString().split('T')[0];
    db.all('SELECT * FROM meals WHERE date = ?', [date], async (err, rows) => {
      if (err || !rows.length) { await sendMessage(chatId, 'Bugün henüz öğün kaydedilmedi.'); return; }
      const t = rows.reduce((a, m) => ({ kcal: a.kcal+(m.calories||0), protein: a.protein+(m.protein||0), carbs: a.carbs+(m.carbs||0), fat: a.fat+(m.fat||0) }), { kcal:0, protein:0, carbs:0, fat:0 });
      let msg = `📊 Bugünkü özet (${rows.length} öğün):\n\n`;
      rows.forEach(m => { msg += `• ${m.name} — ${Math.round(m.calories||0)} kcal\n`; });
      msg += `\n🔥 Toplam: ${Math.round(t.kcal)} kcal\n💪 Protein: ${Math.round(t.protein)}g\n🍞 Karb: ${Math.round(t.carbs)}g\n🧈 Yağ: ${Math.round(t.fat)}g`;
      await sendMessage(chatId, msg);
    });
    return;
  }

  // Porsiyon cevabı bekleniyor
  if (state && state.step === 'waiting_portion' && text) {
    if (text.toLowerCase().includes('tamam') || text.toLowerCase().includes('tahmini')) {
      saveMealToDB(state.foodData);
      userStates[chatId] = null;
      await sendMessage(chatId, mealSummary(state.foodData));
      return;
    }
    await sendMessage(chatId, '⏳ Hesaplanıyor...');
    try {
      const result = await recalculateWithPortion(state.foodData, text);
      userStates[chatId] = null;
      saveMealToDB(result);
      await sendMessage(chatId, mealSummary(result));
    } catch (err) {
      await sendMessage(chatId, '❌ Hesaplama hatası: ' + err.message);
    }
    return;
  }

  // Fotoğraf
  if (photo) {
    await sendMessage(chatId, '📸 Analiz ediliyor...');
    try {
      const fileId = photo[photo.length-1].file_id;
      const fileInfo = await telegramRequest('getFile', { file_id: fileId });
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.result.file_path}`;
      const imgResponse = await fetch(fileUrl);
      const imageBase64 = Buffer.from(await imgResponse.arrayBuffer()).toString('base64');
      const result = await analyzeWithGemini(imageBase64, 'image/jpeg');
      userStates[chatId] = { step: 'waiting_portion', foodData: result };
      await sendMessage(chatId,
        `🍽️ ${result.name} tespit ettim!\n\nTahmini porsiyon: ${result.portion}\nTahmini kalori: ~${Math.round(result.calories||0)} kcal\n\nKaç gram/adet yedin? (örn: "2 adet", "150g")\nBilmiyorsan "tamam" yaz.`,
        [['Tamam, tahmini kaydet'], ['❌ İptal']]
      );
    } catch (err) {
      userStates[chatId] = null;
      await sendMessage(chatId, '❌ Analiz başarısız: ' + err.message);
    }
    return;
  }

  // Metin ile yemek girişi
  if (text && !text.startsWith('/')) {
    await sendMessage(chatId, '⏳ Hesaplanıyor...');
    try {
      const result = await analyzeTextFood(text);
      saveMealToDB(result);
      await sendMessage(chatId, mealSummary(result));
    } catch (err) {
      await sendMessage(chatId, '❌ Hesaplanamadı: ' + err.message);
    }
    return;
  }

  await sendMessage(chatId, 'Fotoğraf gönder veya ne yediğini yaz. /bugun ile günlük özet alabilirsin.');
});

async function setWebhook() {
  if (!TELEGRAM_TOKEN) return;
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!domain) return;
  const result = await telegramRequest('setWebhook', { url: `https://${domain}/telegram` });
  console.log('Webhook:', result);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`NutriLens backend çalışıyor: port ${PORT}`);
  await setWebhook();
});
