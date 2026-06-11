const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const JWT_SECRET = process.env.JWT_SECRET || 'nutrilens-secret-key';

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      gender TEXT,
      age INTEGER,
      height REAL,
      weight REAL,
      target_weight REAL,
      weekly_loss REAL DEFAULT 0.5,
      activity TEXT,
      goal TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('Veritabanı hazır');
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token gerekli' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Geçersiz token' });
  }
}

function adminMiddleware(req, res, next) {
  const adminPassword = req.headers['x-admin-password'];
  if (adminPassword !== (process.env.ADMIN_PASSWORD || 'nutrilens-admin-2026')) {
    return res.status(401).json({ error: 'Yetkisiz erişim' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/auth/register', async (req, res) => {
  const { first_name, last_name, email, password } = req.body;
  if (!first_name || !last_name || !email || !password) {
    return res.status(400).json({ error: 'Tüm alanlar zorunlu' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (first_name, last_name, email, password) VALUES ($1, $2, $3, $4) RETURNING id',
      [first_name, last_name, email, hashedPassword]
    );
    const token = jwt.sign({ userId: result.rows[0].id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: result.rows[0].id, first_name, last_name, email } });
  } catch(err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Bu email zaten kayıtlı' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email ve şifre gerekli' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!result.rows[0]) return res.status(400).json({ error: 'Email veya şifre hatalı' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Email veya şifre hatalı' });
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, first_name: user.first_name, last_name: user.last_name, email: user.email, gender: user.gender, age: user.age, height: user.height, weight: user.weight, target_weight: user.target_weight, weekly_loss: user.weekly_loss, activity: user.activity, goal: user.goal } });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/auth/profile', authMiddleware, async (req, res) => {
  const { gender, age, height, weight, target_weight, weekly_loss, activity, goal } = req.body;
  try {
    await pool.query(
      'UPDATE users SET gender=$1, age=$2, height=$3, weight=$4, target_weight=$5, weekly_loss=$6, activity=$7, goal=$8 WHERE id=$9',
      [gender, age, height, weight, target_weight || null, weekly_loss || 0.5, activity, goal, req.userId]
    );
    const result = await pool.query('SELECT * FROM users WHERE id=$1', [req.userId]);
    res.json({ user: result.rows[0] });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/meals', authMiddleware, async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  try {
    const result = await pool.query('SELECT * FROM meals WHERE user_id=$1 AND date=$2 ORDER BY created_at ASC', [req.userId, date]);
    res.json(result.rows);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/meals', authMiddleware, async (req, res) => {
  const m = req.body;
  const date = m.date || new Date().toISOString().split('T')[0];
  try {
    const result = await pool.query(
      `INSERT INTO meals (user_id, date, name, description, portion, calories, protein, carbs, fat, fiber, sugar, sodium, potassium, calcium, iron, vitamin_c, vitamin_a, source, image_base64)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [req.userId, date, m.name, m.description, m.portion, m.calories, m.protein, m.carbs, m.fat, m.fiber, m.sugar, m.sodium, m.potassium, m.calcium, m.iron, m.vitamin_c, m.vitamin_a, m.source, m.image_base64]
    );
    res.json({ id: result.rows[0].id, ...m });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/meals/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM meals WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

const GEMINI_MODEL = 'gemini-2.5-flash';

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
  return data.candidates[0].content.parts[0].text.replace(/```json/g, '').replace(/```/g, '').trim();
}

async function geminiImage(imageBase64, mediaType, prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: mediaType, data: imageBase64 } }, { text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
      })
    }
  );
  const data = await response.json();
  if (!data.candidates || !data.candidates[0]) throw new Error('Gemini yanıt vermedi: ' + JSON.stringify(data));
  return data.candidates[0].content.parts[0].text.replace(/```json/g, '').replace(/```/g, '').trim();
}

const JSON_TEMPLATE = '{"name":"food name in Turkish","description":"brief","portion":"amount","calories":0,"protein":0,"carbs":0,"fat":0,"fiber":0,"sugar":0,"sodium":0,"potassium":0,"calcium":0,"iron":0,"vitamin_c":0,"vitamin_a":0,"source":"source"}';

async function analyzeWithGemini(imageBase64, mediaType) {
  const clean = await geminiImage(imageBase64, mediaType, `Analyze this food image. Reply ONLY with this JSON, no markdown: ${JSON_TEMPLATE}`);
  return JSON.parse(clean);
}

app.post('/analyze', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    const result = await analyzeWithGemini(req.file.buffer.toString('base64'), req.file.mimetype);
    res.json(result);
  } catch (err) {
    console.error('Analiz hatası:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/suggestions', authMiddleware, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const todayResult = await pool.query('SELECT * FROM meals WHERE user_id=$1 AND date=$2', [req.userId, date]);
    const weekResult = await pool.query(`SELECT * FROM meals WHERE user_id=$1 AND date >= $2::date - interval '7 days'`, [req.userId, date]);
    const todayMeals = todayResult.rows;
    const weekMeals = weekResult.rows;

    const t = todayMeals.reduce((a, m) => ({
      kcal: a.kcal+(m.calories||0), protein: a.protein+(m.protein||0),
      carbs: a.carbs+(m.carbs||0), fat: a.fat+(m.fat||0),
      fiber: a.fiber+(m.fiber||0), iron: a.iron+(m.iron||0),
      calcium: a.calcium+(m.calcium||0), vitamin_c: a.vitamin_c+(m.vitamin_c||0),
      vitamin_a: a.vitamin_a+(m.vitamin_a||0)
    }), { kcal:0,protein:0,carbs:0,fat:0,fiber:0,iron:0,calcium:0,vitamin_c:0,vitamin_a:0 });

    const goals = req.query.goals ? JSON.parse(req.query.goals) : { kcal:2000, protein:150, carbs:250, fat:65 };
    const prompt = `Sen bir diyetisyensin. Kullanıcının bugünkü değerleri: Kalori: ${Math.round(t.kcal)}/${goals.kcal}kcal, Protein: ${Math.round(t.protein)}/${goals.protein}g, Karb: ${Math.round(t.carbs)}/${goals.carbs}g, Yağ: ${Math.round(t.fat)}/${goals.fat}g, Lif: ${t.fiber.toFixed(1)}g, Demir: ${t.iron.toFixed(1)}mg, Kalsiyum: ${Math.round(t.calcium)}mg, C Vit: ${Math.round(t.vitamin_c)}mg. Son 7 gün: ${weekMeals.length} öğün. Eksikleri kapatacak 3 yemek öner. Sadece JSON: [{"food":"isim","reason":"neden (max 60 karakter)","nutrients":"besinler","calories":0,"weekly_tip":"haftalık yorum (sadece ilk öneride)"}]`;

    const clean = await geminiText(prompt);
    res.json({ suggestions: JSON.parse(clean), todayTotals: t, goals });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/recipe', authMiddleware, async (req, res) => {
  try {
    const food = req.query.food;
    if (!food) return res.status(400).json({ error: 'Yemek adı gerekli' });
    const clean = await geminiText(`"${food}" tarifini ver. Sadece JSON: {"name":"isim","servings":"kişi","time":"süre","ingredients":["malzeme"],"steps":["adım"],"tip":"püf nokta"}`);
    res.json(JSON.parse(clean));
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin endpoints
app.get('/admin/users', adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.first_name, u.last_name, u.email, u.gender, u.age, u.height, u.weight, u.goal, u.created_at,
      COUNT(m.id) as meal_count, COALESCE(SUM(m.calories), 0) as total_calories
      FROM users u LEFT JOIN meals m ON u.id = m.user_id
      GROUP BY u.id ORDER BY u.created_at DESC
    `);
    res.json(result.rows);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const user = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!user.rows[0]) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    const meals = await pool.query('SELECT * FROM meals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [req.params.id]);
    res.json({ user: user.rows[0], meals: meals.rows });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/stats', adminMiddleware, async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) as total FROM users');
    const meals = await pool.query('SELECT COUNT(*) as total, COALESCE(SUM(calories),0) as calories FROM meals');
    const today = await pool.query('SELECT COUNT(*) as total FROM meals WHERE date=$1', [new Date().toISOString().split('T')[0]]);
    res.json({
      total_users: parseInt(users.rows[0].total),
      total_meals: parseInt(meals.rows[0].total),
      total_calories: Math.round(meals.rows[0].calories),
      today_meals: parseInt(today.rows[0].total)
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Telegram bot
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function telegramRequest(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}

async function sendMessage(chatId, text, keyboard) {
  const body = { chat_id: chatId, text };
  if (keyboard) body.reply_markup = { keyboard, resize_keyboard: true, one_time_keyboard: true };
  return telegramRequest('sendMessage', body);
}

const userStates = {};

async function saveMealToDB(result, userId) {
  const date = new Date().toISOString().split('T')[0];
  await pool.query(
    `INSERT INTO meals (user_id, date, name, description, portion, calories, protein, carbs, fat, fiber, sugar, sodium, potassium, calcium, iron, vitamin_c, vitamin_a, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [userId || 1, date, result.name, result.description, result.portion, result.calories, result.protein, result.carbs, result.fat, result.fiber, result.sugar, result.sodium, result.potassium, result.calcium, result.iron, result.vitamin_c, result.vitamin_a, result.source]
  );
}

function mealSummary(result) {
  return `✅ ${result.name} kaydedildi!\n\n🔥 ${Math.round(result.calories||0)} kcal\n💪 Protein: ${Math.round(result.protein||0)}g\n🍞 Karb: ${Math.round(result.carbs||0)}g\n🧈 Yağ: ${Math.round(result.fat||0)}g\n📌 ${result.source||'-'}`;
}

async function recalculateWithPortion(foodData, portionText) {
  const prompt = `Food: ${foodData.name}, original: ${foodData.portion}, ${foodData.calories}kcal. User ate: "${portionText}". Recalculate. Reply ONLY with JSON: ${JSON_TEMPLATE}`;
  return JSON.parse(await geminiText(prompt));
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
    await sendMessage(chatId, '🥗 NutriLens\'e hoş geldin!\n\nYemek fotoğrafı gönder veya ne yediğini yaz.\n\nKomutlar:\n/bugun - günlük özet\n/iptal - iptal et');
    return;
  }

  if (text === '/iptal') {
    userStates[chatId] = null;
    await sendMessage(chatId, '❌ İptal edildi.');
    return;
  }

  if (text === '/bugun') {
    const date = new Date().toISOString().split('T')[0];
    const result = await pool.query('SELECT * FROM meals WHERE date=$1', [date]);
    const rows = result.rows;
    if (!rows.length) { await sendMessage(chatId, 'Bugün henüz öğün kaydedilmedi.'); return; }
    const t = rows.reduce((a,m) => ({ kcal:a.kcal+(m.calories||0), protein:a.protein+(m.protein||0), carbs:a.carbs+(m.carbs||0), fat:a.fat+(m.fat||0) }), { kcal:0,protein:0,carbs:0,fat:0 });
    let msg = `📊 Bugünkü özet (${rows.length} öğün):\n\n`;
    rows.forEach(m => { msg += `• ${m.name} — ${Math.round(m.calories||0)} kcal\n`; });
    msg += `\n🔥 Toplam: ${Math.round(t.kcal)} kcal\n💪 ${Math.round(t.protein)}g protein\n🍞 ${Math.round(t.carbs)}g karb\n🧈 ${Math.round(t.fat)}g yağ`;
    await sendMessage(chatId, msg);
    return;
  }

  if (state && state.step === 'waiting_portion' && text) {
    const gramMatch = text.match(/(\d+)g/);
    if (text.toLowerCase().includes('tamam') || text.toLowerCase().includes('tahmini')) {
      await saveMealToDB(state.foodData);
      userStates[chatId] = null;
      await sendMessage(chatId, mealSummary(state.foodData));
      return;
    }
    await sendMessage(chatId, '⏳ Hesaplanıyor...');
    try {
      const portionText = gramMatch ? `${gramMatch[1]}g` : text;
      const result = await recalculateWithPortion(state.foodData, portionText);
      userStates[chatId] = null;
      await saveMealToDB(result);
      await sendMessage(chatId, mealSummary(result));
    } catch(err) { await sendMessage(chatId, '❌ ' + err.message); }
    return;
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
        `🍽️ ${result.name} tespit ettim!\n\nTahmini: ${result.portion} — ~${Math.round(result.calories||0)} kcal\n\nKaç gram/adet yedin?`,
        [['Tamam, tahmini kaydet'], ['❌ İptal']]
      );
    } catch(err) {
      userStates[chatId] = null;
      await sendMessage(chatId, '❌ ' + err.message);
    }
    return;
  }

  if (text && !text.startsWith('/')) {
    await sendMessage(chatId, '⏳ Hesaplanıyor...');
    try {
      const clean = await geminiText(`User ate: "${text}". Calculate nutritional values. Reply ONLY with this JSON: ${JSON_TEMPLATE}`);
      const result = JSON.parse(clean);
      await saveMealToDB(result);
      await sendMessage(chatId, mealSummary(result));
    } catch(err) { await sendMessage(chatId, '❌ ' + err.message); }
    return;
  }

  await sendMessage(chatId, 'Fotoğraf gönder veya ne yediğini yaz.');
});

async function setWebhook() {
  if (!TELEGRAM_TOKEN) return;
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!domain) return;
  const result = await telegramRequest('setWebhook', { url: `https://${domain}/telegram` });
  console.log('Webhook:', result);
}

const PORT = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORT, async () => {
    console.log(`NutriLens backend çalışıyor: port ${PORT}`);
    await setWebhook();
  });
}).catch(err => {
  console.error('DB başlatma hatası:', err);
  process.exit(1);
});
