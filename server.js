const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Database = require('better-sqlite3');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

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
    const apiKey = process.env.GEMINI_API_KEY;

    const prompt = `Bu yemek fotoğrafını analiz et. Yemeği tanı ve besin değerlerini hesapla. Hangi kaynağı baz aldığını belirt (USDA, Türk Gıda Kodeksi vb).

Sadece ve sadece aşağıdaki JSON formatında yanıt ver, başka hiçbir şey yazma, markdown kullanma:
{"name":"yemek adı","description":"kısa açıklama","portion":"porsiyon bilgisi","calories":450,"protein":28,"carbs":45,"fat":15,"fiber":5,"sugar":8,"sodium":680,"potassium":420,"calcium":85,"iron":3.2,"vitamin_c":12,"vitamin_a":150,"source":"kaynak adı"}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, 
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
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1000
          }
        })
      }
    );

    const data = await response.json();
    console.log('Gemini yanıtı:', JSON.stringify(data).substring(0, 500));

    if (!data.candidates || data.candidates.length === 0) {
      throw new Error('Gemini yanıt vermedi: ' + JSON.stringify(data));
    }

    const text = data.candidates[0].content.parts[0].text;
    console.log('Ham metin:', text);

    const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.json(parsed);

  } catch (err) {
    console.error('Analiz hatası:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NutriLens backend çalışıyor: port ${PORT}`));
