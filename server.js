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
const GEMINI_MODEL = 'gemini-2.5-flash';

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
    // Gram seçeneği seçildi
    const gramMatch = text.match(/(\d+)g/);
    if (gramMatch) {
      const gram = parseInt(gramMatch[1]);
      await sendMessage(chatId, '⏳ Hesaplanıyor...');
      try {
        const portionText = `${gram}g`;
        const result = await recalculateWithPortion(state.foodData, portionText);
        userStates[chatId] = null;
        saveMealToDB(result);
        await sendMessage(chatId, mealSummary(result));
      } catch(err) {
        await sendMessage(chatId, '❌ Hesaplama hatası: ' + err.message);
      }
      return;
    }
    
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
  // Barkod fotoğrafı kontrolü
  if (photo) {
    const caption = update.message.caption || '';
    if (caption.toLowerCase().includes('barkod') || caption.toLowerCase().includes('barcode')) {
      await sendMessage(chatId, '📷 Barkod okunuyor...');
      try {
        const fileId = photo[photo.length-1].file_id;
        const fileInfo = await telegramRequest('getFile', { file_id: fileId });
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.result.file_path}`;
        const imgResponse = await fetch(fileUrl);
        const imageBase64 = Buffer.from(await imgResponse.arrayBuffer()).toString('base64');

        // Gemini ile barkod numarasını oku
        const barcodePrompt = `This is a barcode image. Read the barcode number and return ONLY the number, nothing else. If you cannot read it, return "NOT_FOUND".`;
        const barcodeNum = await geminiImage(imageBase64, 'image/jpeg', barcodePrompt);
        const cleanBarcode = barcodeNum.trim().replace(/[^0-9]/g, '');

        if (!cleanBarcode || cleanBarcode.length < 8) {
          await sendMessage(chatId, '❌ Barkod okunamadı. Daha net bir fotoğraf çek.');
          return;
        }

        await sendMessage(chatId, `🔍 Barkod: ${cleanBarcode}\nÜrün aranıyor...`);

        // Open Food Facts'ten ürün bilgisini al
        const offResponse = await fetch(`https://world.openfoodfacts.org/api/v0/product/${cleanBarcode}.json`);
        const offData = await offResponse.json();

        let result;
        if (offData.status === 1 && offData.product) {
          const p = offData.product;
          const nutriments = p.nutriments || {};
          result = {
            name: p.product_name || p.product_name_tr || 'Bilinmeyen ürün',
            description: p.brands || '',
            portion: `100g (${p.quantity || 'belirtilmemiş'})`,
            calories: Math.round(nutriments['energy-kcal_100g'] || nutriments['energy-kcal'] || 0),
            protein: parseFloat(nutriments['proteins_100g'] || 0),
            carbs: parseFloat(nutriments['carbohydrates_100g'] || 0),
            fat: parseFloat(nutriments['fat_100g'] || 0),
            fiber: parseFloat(nutriments['fiber_100g'] || 0),
            sugar: parseFloat(nutriments['sugars_100g'] || 0),
            sodium: parseFloat((nutriments['sodium_100g'] || 0) * 1000),
            potassium: parseFloat(nutriments['potassium_100g'] || 0),
            calcium: parseFloat(nutriments['calcium_100g'] || 0),
            iron: parseFloat(nutriments['iron_100g'] || 0),
            vitamin_c: parseFloat(nutriments['vitamin-c_100g'] || 0),
            vitamin_a: parseFloat(nutriments['vitamin-a_100g'] || 0),
            source: 'Open Food Facts'
          };
        } else {
          // Open Food Facts'te bulunamadı, Gemini ile tahmin et
          await sendMessage(chatId, '⚠️ Veritabanında bulunamadı, AI ile tahmin ediliyor...');
          const imagePrompt = `Analyze this product barcode/packaging image. Return ONLY this JSON: {"name":"product name in Turkish","description":"brand","portion":"100g","calories":0,"protein":0,"carbs":0,"fat":0,"fiber":0,"sugar":0,"sodium":0,"potassium":0,"calcium":0,"iron":0,"vitamin_c":0,"vitamin_a":0,"source":"AI tahmini"}`;
          const clean = await geminiImage(imageBase64, 'image/jpeg', imagePrompt);
          result = JSON.parse(clean);
        }

        userStates[chatId] = { step: 'waiting_portion', foodData: result };
        await sendMessage(chatId,
          `✅ Ürün bulundu!\n\n📦 ${result.name}\n${result.description ? '🏷️ ' + result.description + '\n' : ''}\n100g için:\n🔥 ${result.calories} kcal\n💪 Protein: ${result.protein}g\n🍞 Karb: ${result.carbs}g\n🧈 Yağ: ${result.fat}g\n\nKaç gram yedin?`,
          [['100g kaydet'], ['150g kaydet'], ['200g kaydet'], ['❌ İptal']]
        );
      } catch(err) {
        await sendMessage(chatId, '❌ Barkod okunamadı: ' + err.message);
      }
      return;
    }
  }
  
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
app.get('/suggestions', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    
    // Bugünkü öğünleri al
    db.all('SELECT * FROM meals WHERE date = ?', [date], async (err, todayMeals) => {
      if (err) return res.status(500).json({ error: err.message });

      // Son 7 günün öğünlerini al
      db.all(`SELECT * FROM meals WHERE date >= date(?, '-7 days') ORDER BY date ASC`, [date], async (err2, weekMeals) => {
        if (err2) return res.status(500).json({ error: err2.message });

        const todayTotals = todayMeals.reduce((a, m) => ({
          kcal: a.kcal + (m.calories || 0),
          protein: a.protein + (m.protein || 0),
          carbs: a.carbs + (m.carbs || 0),
          fat: a.fat + (m.fat || 0),
          fiber: a.fiber + (m.fiber || 0),
          iron: a.iron + (m.iron || 0),
          calcium: a.calcium + (m.calcium || 0),
          vitamin_c: a.vitamin_c + (m.vitamin_c || 0),
          vitamin_a: a.vitamin_a + (m.vitamin_a || 0)
        }), { kcal:0, protein:0, carbs:0, fat:0, fiber:0, iron:0, calcium:0, vitamin_c:0, vitamin_a:0 });

        const goals = req.query.goals ? JSON.parse(req.query.goals) : { kcal: 2000, protein: 150, carbs: 250, fat: 65 };

        const prompt = `Sen bir diyetisyensin. Kullanıcının bugünkü besin değerleri ve hedefleri:

BUGÜNKÜ DEĞERLER:
- Kalori: ${Math.round(todayTotals.kcal)} / ${goals.kcal} kcal
- Protein: ${Math.round(todayTotals.protein)} / ${goals.protein}g
- Karbonhidrat: ${Math.round(todayTotals.carbs)} / ${goals.carbs}g
- Yağ: ${Math.round(todayTotals.fat)} / ${goals.fat}g
- Lif: ${Math.round(todayTotals.fiber)}g
- Demir: ${todayTotals.iron.toFixed(1)}mg
- Kalsiyum: ${Math.round(todayTotals.calcium)}mg
- C Vitamini: ${Math.round(todayTotals.vitamin_c)}mg
- A Vitamini: ${Math.round(todayTotals.vitamin_a)}mcg

SON 7 GÜN TREND:
${weekMeals.length > 0 ? `Toplam ${weekMeals.length} öğün kaydedildi. Ortalama günlük kalori: ${Math.round(weekMeals.reduce((a,m) => a + (m.calories||0), 0) / 7)} kcal` : 'Veri yok'}

Eksik besinleri kapatacak 3 yemek önerisi yap. Her öneri için bu JSON formatını kullan:
[
  {
    "food": "Yemek adı",
    "reason": "Neden öneriyorum (eksik besine göre, maks 60 karakter)",
    "nutrients": "Hangi besinleri karşılar",
    "calories": 250,
    "weekly_tip": "Haftalık trend yorumu (sadece ilk öneride, diğerlerinde boş bırak)"
  }
]

Sadece JSON döndür, başka hiçbir şey yazma.`;

        try {
          const clean = await geminiText(prompt);
          const suggestions = JSON.parse(clean);
          res.json({ suggestions, todayTotals, goals });
        } catch (e) {
          res.status(500).json({ error: e.message });
        }
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/recipe', async (req, res) => {
  try {
    const food = req.query.food;
    if (!food) return res.status(400).json({ error: 'Yemek adı gerekli' });

    const prompt = `"${food}" yemeğinin tarifini ver. Sadece bu JSON formatında döndür:
{
  "name": "Yemek adı",
  "servings": "Kaç kişilik",
  "time": "Hazırlık süresi",
  "ingredients": ["malzeme 1", "malzeme 2"],
  "steps": ["adım 1", "adım 2", "adım 3"],
  "tip": "Püf nokta"
}`;

    const clean = await geminiText(prompt);
    const recipe = JSON.parse(clean);
    res.json(recipe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`NutriLens backend çalışıyor: port ${PORT}`);
  await setWebhook();
});
