const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        api_key_hash VARCHAR(64) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        last_access TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS favorites (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        video_id VARCHAR(20) NOT NULL,
        title TEXT NOT NULL,
        channel VARCHAR(255),
        thumbnail TEXT,
        added_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, video_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(api_key_hash);
      CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON favorites(user_id);
    `);
    console.log('✅ Banco de dados inicializado com sucesso!');
  } catch (error) {
    console.error('Erro ao inicializar banco:', error);
  }
}

initDatabase();

app.get('/api/health', (req, res) => {
  res.json({ status: 'online', timestamp: new Date() });
});

app.post('/api/auth', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API Key é obrigatória' });
  
  const crypto = require('crypto');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  
  try {
    let result = await pool.query('SELECT id FROM users WHERE api_key_hash = $1', [apiKeyHash]);
    let userId;
    
    if (result.rows.length === 0) {
      const insertResult = await pool.query('INSERT INTO users (api_key_hash) VALUES ($1) RETURNING id', [apiKeyHash]);
      userId = insertResult.rows[0].id;
    } else {
      userId = result.rows[0].id;
      await pool.query('UPDATE users SET last_access = NOW() WHERE id = $1', [userId]);
    }
    
    const favoritesResult = await pool.query(
      `SELECT video_id, title, channel, thumbnail FROM favorites WHERE user_id = $1 ORDER BY added_at DESC`,
      [userId]
    );
    
    res.json({ success: true, userId, favorites: favoritesResult.rows });
  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/favorites', async (req, res) => {
  const { apiKey, favorites } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API Key é obrigatória' });
  
  const crypto = require('crypto');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE api_key_hash = $1', [apiKeyHash]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    
    const userId = userResult.rows[0].id;
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM favorites WHERE user_id = $1', [userId]);
      
      for (const fav of favorites) {
        await client.query(
          `INSERT INTO favorites (user_id, video_id, title, channel, thumbnail) VALUES ($1, $2, $3, $4, $5)`,
          [userId, fav.id, fav.title, fav.channel, fav.thumb]
        );
      }
      
      await client.query('COMMIT');
      res.json({ success: true, count: favorites.length });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/favorites/add', async (req, res) => {
  const { apiKey, video } = req.body;
  if (!apiKey || !video) return res.status(400).json({ error: 'API Key e vídeo são obrigatórios' });
  
  const crypto = require('crypto');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE api_key_hash = $1', [apiKeyHash]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    
    const userId = userResult.rows[0].id;
    
    await pool.query(
      `INSERT INTO favorites (user_id, video_id, title, channel, thumbnail) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, video_id) DO NOTHING`,
      [userId, video.id, video.title, video.channel, video.thumb]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/favorites', async (req, res) => {
  const { apiKey, videoId } = req.body;
  if (!apiKey || !videoId) return res.status(400).json({ error: 'API Key e videoId são obrigatórios' });
  
  const crypto = require('crypto');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE api_key_hash = $1', [apiKeyHash]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    
    const userId = userResult.rows[0].id;
    await pool.query('DELETE FROM favorites WHERE user_id = $1 AND video_id = $2', [userId, videoId]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/favorites/all', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API Key é obrigatória' });
  
  const crypto = require('crypto');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE api_key_hash = $1', [apiKeyHash]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    
    const userId = userResult.rows[0].id;
    await pool.query('DELETE FROM favorites WHERE user_id = $1', [userId]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});