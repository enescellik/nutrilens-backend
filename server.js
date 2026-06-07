const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json());

const db = new Database('nutrilens.db');
db.exec(`
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
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/meals', (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const meals = db.prepare('SELECT * FROM meals WHERE date = ? ORDER BY created_at ASC').all(date);
  res.json(meals);
});

app.post('/meals', (req, res) => {
  const m = req.body;
  const date = m.date || new Date().toISOString().split('T')[0];
  const stmt = db.prepare(`
    INSERT INTO meals (date, name, description, portion, calories, protein, carbs, fat, fiber, sugar, sodium, potassium, calcium, iron, vitamin_c, vitamin_a, source, image_base64)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(date, m.name, m.description, m.portion, m.calories, m.protein, m.carbs, m.fat, m.fiber, m.sugar, m.sodium, m.potassium, m.calcium, m.iron, m.vitamin_c, m.vitamin_a, m.source, m.image_base64);
  res.json({ id: result.lastInsertRowid, ...m });
});

app.delete('/meals/:id', (req, res) => {
  db.prepare('DELETE FROM meals WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/analyze', upload.single('image'), async (req, res) => {
  try {
    const imageBase64 = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype;

    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: `Bu yemek fotoğrafını analiz et. 

ADIM 1: Fotoğraftaki yemeği tanımla.
ADIM 2: Web'de ara - önce resmi kaynaklar: USDA FoodData Central, Türk Gıda Kodeksi, ürün markası sitesi. Bulamazsan Cronometer, Nutritionix gibi veritabanlarına bak. Birden fazla kaynak bul ve karşılaştır.
ADIM 3: En güvenilir kaynağı seç ve bunu belirt.

Sonucu SADECE şu JSON formatında döndür, başka hiçbir şey yazma:
{
  "name": "Yemeğin Türkçe adı",
  "description": "Kısa açıklama",
  "portion": "Porsiyon bilgisi (örn: 1 tabak ~350g)",
  "calories": 450,
  "protein": 28,
  "carbs": 45,
  "fat": 15,
  "fiber": 5,
  "sugar": 8,
  "sodium": 680,
  "potassium": 420,
  "calcium": 85,
  "iron": 3.2,
  "vitamin_c": 12,
  "vitamin_a": 150,
  "source": "Kaynak: USDA FoodData Central"
}` }
        ]
      }]
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) throw new Error('Yanıt alınamadı');
    
    const clean = textBlock.text.replace(/```json|```/g, '').trim();
    const data = JSON.parse(clean);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NutriLens backend çalışıyor: port ${PORT}`));
