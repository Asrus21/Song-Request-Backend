const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// Configuração do PostgreSQL (Railway fornece a variável DATABASE_URL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Configuração do Spotify (variáveis de ambiente no Railway)
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// Cache do token do Spotify
let spotifyAccessToken = null;
let spotifyTokenExpiry = null;

// Função para obter token do Spotify
async function getSpotifyAccessToken() {
  // Verificar se o token em cache ainda é válido
  if (spotifyAccessToken && spotifyTokenExpiry && Date.now() < spotifyTokenExpiry) {
    return spotifyAccessToken;
  }
  
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error('Spotify credentials not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in Railway variables.');
  }
  
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')
    },
    body: 'grant_type=client_credentials'
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.error_description || 'Erro ao autenticar no Spotify');
  }
  
  spotifyAccessToken = data.access_token;
  spotifyTokenExpiry = Date.now() + (data.expires_in * 1000);
  return spotifyAccessToken;
}

// Função para inicializar o banco de dados
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
        video_id VARCHAR(50) NOT NULL,
        title TEXT NOT NULL,
        channel VARCHAR(255),
        thumbnail TEXT,
        service VARCHAR(20) DEFAULT 'youtube',
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

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
  res.json({ status: 'online', timestamp: new Date() });
});

// ==================== SPOTIFY PROXY ====================
app.post('/api/spotify/search', async (req, res) => {
  const { query } = req.body;
  
  if (!query) {
    return res.status(400).json({ error: 'Query é obrigatória' });
  }
  
  try {
    const token = await getSpotifyAccessToken();
    
    const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=8`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      console.error('Erro Spotify API:', data);
      return res.status(response.status).json({ error: data.error?.message || 'Erro na API do Spotify' });
    }
    
    res.json(data);
    
  } catch (error) {
    console.error('Erro no proxy Spotify:', error);
    res.status(500).json({ error: error.message || 'Erro ao pesquisar no Spotify' });
  }
});

// ==================== AUTH ====================
app.post('/api/auth', async (req, res) => {
  const { apiKey } = req.body;
  
  if (!apiKey) {
    return res.status(400).json({ error: 'API Key é obrigatória' });
  }
  
  const crypto = require('crypto');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  
  try {
    let result = await pool.query('SELECT id FROM users WHERE api_key_hash = $1', [apiKeyHash]);
    let userId;
    
    if (result.rows.length === 0) {
      const insertResult = await pool.query('INSERT INTO users (api_key_hash) VALUES ($1) RETURNING id', [apiKeyHash]);
      userId = insertResult.rows[0].id;
      console.log(`🆕 Novo usuário criado: ${userId}`);
    } else {
      userId = result.rows[0].id;
      await pool.query('UPDATE users SET last_access = NOW() WHERE id = $1', [userId]);
      console.log(`👤 Usuário existente: ${userId}`);
    }
    
    const favoritesResult = await pool.query(
      `SELECT video_id, title, channel, thumbnail, service 
       FROM favorites 
       WHERE user_id = $1 
       ORDER BY added_at DESC`,
      [userId]
    );
    
    res.json({
      success: true,
      userId,
      favorites: favoritesResult.rows
    });
    
  } catch (error) {
    console.error('Erro em /api/auth:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ==================== FAVORITES (salvar todos) ====================
app.post('/api/favorites', async (req, res) => {
  const { apiKey, favorites } = req.body;
  
  if (!apiKey) {
    return res.status(400).json({ error: 'API Key é obrigatória' });
  }
  
  const crypto = require('crypto');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE api_key_hash = $1', [apiKeyHash]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const userId = userResult.rows[0].id;
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM favorites WHERE user_id = $1', [userId]);
      
      for (const fav of favorites) {
        await client.query(
          `INSERT INTO favorites (user_id, video_id, title, channel, thumbnail, service)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, fav.id, fav.title, fav.channel, fav.thumb, fav.service || 'youtube']
        );
      }
      
      await client.query('COMMIT');
      console.log(`💾 Favoritos salvos para usuário ${userId}: ${favorites.length} itens`);
      res.json({ success: true, count: favorites.length });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Erro em /api/favorites:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ==================== FAVORITES (adicionar um) ====================
app.post('/api/favorites/add', async (req, res) => {
  const { apiKey, video } = req.body;
  
  if (!apiKey || !video) {
    return res.status(400).json({ error: 'API Key e vídeo são obrigatórios' });
  }
  
  const crypto = require('crypto');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE api_key_hash = $1', [apiKeyHash]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const userId = userResult.rows[0].id;
    
    await pool.query(
      `INSERT INTO favorites (user_id, video_id, title, channel, thumbnail, service)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, video_id) DO NOTHING`,
      [userId, video.id, video.title, video.channel, video.thumb, video.service || 'youtube']
    );
    
    console.log(`➕ Favorito adicionado para usuário ${userId}: ${video.title}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro em /api/favorites/add:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ==================== FAVORITES (remover um) ====================
app.delete('/api/favorites', async (req, res) => {
  const { apiKey, videoId } = req.body;
  
  if (!apiKey || !videoId) {
    return res.status(400).json({ error: 'API Key e videoId são obrigatórios' });
  }
  
  const crypto = require('crypto');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE api_key_hash = $1', [apiKeyHash]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const userId = userResult.rows[0].id;
    await pool.query('DELETE FROM favorites WHERE user_id = $1 AND video_id = $2', [userId, videoId]);
    
    console.log(`❌ Favorito removido para usuário ${userId}: ${videoId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro em /api/favorites (DELETE):', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ==================== FAVORITES (limpar todos) ====================
app.delete('/api/favorites/all', async (req, res) => {
  const { apiKey } = req.body;
  
  if (!apiKey) {
    return res.status(400).json({ error: 'API Key é obrigatória' });
  }
  
  const crypto = require('crypto');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE api_key_hash = $1', [apiKeyHash]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const userId = userResult.rows[0].id;
    await pool.query('DELETE FROM favorites WHERE user_id = $1', [userId]);
    
    console.log(`🗑️ Todos favoritos removidos para usuário ${userId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro em /api/favorites/all:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ==================== INICIAR SERVIDOR ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
  
  if (SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET) {
    console.log(`🎵 Spotify credentials configuradas! Proxy disponível.`);
  } else {
    console.log(`⚠️  Spotify credentials NÃO configuradas. Adicione SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET nas variáveis de ambiente.`);
  }
});
