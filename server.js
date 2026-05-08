const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ==================== CONFIGURAÇÕES ====================
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_REDIRECT_URI = process.env.TWITCH_REDIRECT_URI || 'https://song-request-backend-production.up.railway.app/api/auth/twitch/callback';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://asrus21.github.io/Song-Request-Queue';

// Configuração do PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ==================== FUNÇÕES AUXILIARES ====================
function generateUUID() {
  return crypto.randomBytes(16).toString('hex');
}

async function refreshTwitchToken(userId, refreshToken) {
  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET
      }
    });
    
    const { access_token, expires_in } = response.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);
    
    await pool.query(
      `UPDATE twitch_users 
       SET access_token = $1, token_expires_at = $2, updated_at = NOW() 
       WHERE id = $3`,
      [access_token, expiresAt, userId]
    );
    
    return access_token;
  } catch (error) {
    console.error('Erro ao renovar token:', error.response?.data || error.message);
    return null;
  }
}

async function getValidAccessToken(userId, refreshToken) {
  const result = await pool.query(
    'SELECT access_token, token_expires_at FROM twitch_users WHERE id = $1',
    [userId]
  );
  
  if (result.rows.length === 0) return null;
  
  const { access_token, token_expires_at } = result.rows[0];
  
  if (new Date() < token_expires_at) {
    return access_token;
  }
  
  return await refreshTwitchToken(userId, refreshToken);
}

// ==================== BANCO DE DADOS ====================
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS twitch_users (
        id SERIAL PRIMARY KEY,
        twitch_user_id VARCHAR(30) UNIQUE NOT NULL,
        twitch_login VARCHAR(50) NOT NULL,
        twitch_display_name VARCHAR(100) NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        token_expires_at TIMESTAMP NOT NULL,
        channel_name VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS favorites (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES twitch_users(id) ON DELETE CASCADE,
        video_id VARCHAR(50) NOT NULL,
        title TEXT NOT NULL,
        channel VARCHAR(255) NOT NULL,
        thumbnail TEXT,
        service VARCHAR(20) DEFAULT 'youtube',
        added_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, video_id, service)
      );
      
      CREATE TABLE IF NOT EXISTS user_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES twitch_users(id) ON DELETE CASCADE,
        session_uuid VARCHAR(32) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_twitch_users_twitch_user_id ON twitch_users(twitch_user_id);
      CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON favorites(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_sessions_uuid ON user_sessions(session_uuid);
    `);

    // Migrations — adiciona colunas novas em tabelas já existentes
await pool.query(`
  ALTER TABLE favorites 
  ADD COLUMN IF NOT EXISTS service VARCHAR(20) DEFAULT 'youtube'
`);
    
    console.log('✅ Banco de dados inicializado com sucesso!');
  } catch (error) {
    console.error('Erro ao inicializar banco:', error);
  }
}

initDatabase();

// ==================== SPOTIFY PROXY ====================
let spotifyAccessToken = null;
let spotifyTokenExpiry = null;

async function getSpotifyAccessToken() {
  if (spotifyAccessToken && spotifyTokenExpiry && Date.now() < spotifyTokenExpiry) {
    return spotifyAccessToken;
  }
  
  const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
  const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
  
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error('Spotify credentials not configured');
  }
  
  const response = await axios.post('https://accounts.spotify.com/api/token', 
    'grant_type=client_credentials',
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')
      }
    }
  );
  
  spotifyAccessToken = response.data.access_token;
  spotifyTokenExpiry = Date.now() + (response.data.expires_in * 1000);
  return spotifyAccessToken;
}

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
  res.json({ status: 'online', timestamp: new Date() });
});

// ==================== TWITCH OAUTH ====================
app.get('/api/auth/twitch', (req, res) => {
  const state = generateUUID();
  const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(TWITCH_REDIRECT_URI)}&response_type=code&scope=chat:edit+user:read:email&state=${state}`;
  res.json({ url: authUrl, state });
});

app.get('/api/auth/twitch/callback', async (req, res) => {
  const { code, state } = req.query;
  
  if (!code) {
    return res.status(400).send('Código de autorização não encontrado');
  }
  
  try {
    // Trocar código por token
    const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: TWITCH_REDIRECT_URI
      }
    });
    
    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);
    
    // Obter dados do usuário
    const userResponse = await axios.get('https://api.twitch.tv/helix/users', {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Client-Id': TWITCH_CLIENT_ID
      }
    });
    
    const twitchUser = userResponse.data.data[0];
    const twitchUserId = twitchUser.id;
    const twitchLogin = twitchUser.login;
    const twitchDisplayName = twitchUser.display_name;
    
    // Verificar se usuário já existe
    const existingUser = await pool.query(
      'SELECT id FROM twitch_users WHERE twitch_user_id = $1',
      [twitchUserId]
    );
    
    let userId;
    if (existingUser.rows.length > 0) {
      userId = existingUser.rows[0].id;
      await pool.query(
        `UPDATE twitch_users 
         SET access_token = $1, refresh_token = $2, token_expires_at = $3, 
             twitch_login = $4, twitch_display_name = $5, updated_at = NOW()
         WHERE id = $6`,
        [access_token, refresh_token, expiresAt, twitchLogin, twitchDisplayName, userId]
      );
      console.log(`🔄 Usuário atualizado: ${twitchDisplayName} (${twitchUserId})`);
    } else {
      const insertResult = await pool.query(
        `INSERT INTO twitch_users (twitch_user_id, twitch_login, twitch_display_name, access_token, refresh_token, token_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [twitchUserId, twitchLogin, twitchDisplayName, access_token, refresh_token, expiresAt]
      );
      userId = insertResult.rows[0].id;
      console.log(`🆕 Novo usuário criado: ${twitchDisplayName} (${twitchUserId})`);
    }
    
    // Gerar UUID da sessão
    const sessionUUID = generateUUID();
    
    // Salvar sessão
    await pool.query(
      `INSERT INTO user_sessions (user_id, session_uuid, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET session_uuid = $2, created_at = NOW()`,
      [userId, sessionUUID]
    );
    
    // Redirecionar para o frontend com os parâmetros de sucesso
    console.log(`✅ Login bem sucedido! Redirecionando para ${FRONTEND_URL}?login=success&uuid=${sessionUUID}`);
    res.redirect(`${FRONTEND_URL}?login=success&uuid=${sessionUUID}`);
    
  } catch (error) {
    console.error('Erro no callback:', error.response?.data || error.message);
    res.redirect(`${FRONTEND_URL}?login=error`);
  }
});

// ==================== VERIFICAR SESSÃO ====================
app.post('/api/auth/verify', async (req, res) => {
  const { uuid } = req.body;
  
  if (!uuid) {
    return res.status(400).json({ error: 'UUID é obrigatório' });
  }
  
  try {
    const result = await pool.query(
      `SELECT u.id, u.twitch_user_id, u.twitch_login, u.twitch_display_name, u.channel_name,
              u.access_token, u.token_expires_at, u.refresh_token
       FROM twitch_users u
       JOIN user_sessions s ON u.id = s.user_id
       WHERE s.session_uuid = $1`,
      [uuid]
    );
    
    if (result.rows.length === 0) {
      console.log(`⚠️ Sessão não encontrada para UUID: ${uuid}`);
      return res.json({ authenticated: false });
    }
    
    const user = result.rows[0];
    const isTokenValid = new Date() < user.token_expires_at;
    
    // Buscar favoritos do usuário
    const favoritesResult = await pool.query(
      `SELECT video_id, title, channel, thumbnail, service, added_at
       FROM favorites 
       WHERE user_id = $1 
       ORDER BY added_at DESC`,
      [user.id]
    );
    
    console.log(`✅ Sessão válida para: ${user.twitch_display_name} (${favoritesResult.rowCount} favoritos)`);
    
    res.json({
      authenticated: true,
      user: {
        id: user.twitch_user_id,
        login: user.twitch_login,
        displayName: user.twitch_display_name,
        channelName: user.channel_name
      },
      isTokenValid,
      favorites: favoritesResult.rows
    });
    
  } catch (error) {
    console.error('Erro ao verificar sessão:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ==================== SALVAR CANAL ====================
app.post('/api/user/channel', async (req, res) => {
  const { uuid, channelName } = req.body;
  
  if (!uuid || !channelName) {
    return res.status(400).json({ error: 'UUID e channelName são obrigatórios' });
  }
  
  try {
    const result = await pool.query(
      `SELECT u.id FROM twitch_users u
       JOIN user_sessions s ON u.id = s.user_id
       WHERE s.session_uuid = $1`,
      [uuid]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }
    
    const cleanChannelName = channelName.toLowerCase().replace('#', '');
    await pool.query(
      'UPDATE twitch_users SET channel_name = $1, updated_at = NOW() WHERE id = $2',
      [cleanChannelName, result.rows[0].id]
    );
    
    console.log(`💾 Canal salvo: ${cleanChannelName} para usuário ${result.rows[0].id}`);
    res.json({ success: true });
    
  } catch (error) {
    console.error('Erro ao salvar canal:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ==================== FAVORITOS ====================
app.post('/api/favorites', async (req, res) => {
  const { uuid, favorites } = req.body;
  
  if (!uuid) {
    return res.status(400).json({ error: 'UUID é obrigatório' });
  }
  
  try {
    const userResult = await pool.query(
      `SELECT u.id FROM twitch_users u
       JOIN user_sessions s ON u.id = s.user_id
       WHERE s.session_uuid = $1`,
      [uuid]
    );
    
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

app.post('/api/favorites/add', async (req, res) => {
  const { uuid, video } = req.body;
  
  if (!uuid || !video) {
    return res.status(400).json({ error: 'UUID e vídeo são obrigatórios' });
  }
  
  try {
    const userResult = await pool.query(
      `SELECT u.id FROM twitch_users u
       JOIN user_sessions s ON u.id = s.user_id
       WHERE s.session_uuid = $1`,
      [uuid]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const userId = userResult.rows[0].id;
    
    await pool.query(
      `INSERT INTO favorites (user_id, video_id, title, channel, thumbnail, service)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, video_id, service) DO NOTHING`,
      [userId, video.id, video.title, video.channel, video.thumb, video.service || 'youtube']
    );
    
    console.log(`➕ Favorito adicionado para usuário ${userId}: ${video.title}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro em /api/favorites/add:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/favorites', async (req, res) => {
  const { uuid, videoId } = req.body;
  
  if (!uuid || !videoId) {
    return res.status(400).json({ error: 'UUID e videoId são obrigatórios' });
  }
  
  try {
    const userResult = await pool.query(
      `SELECT u.id FROM twitch_users u
       JOIN user_sessions s ON u.id = s.user_id
       WHERE s.session_uuid = $1`,
      [uuid]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const userId = userResult.rows[0].id;
    await pool.query(
      'DELETE FROM favorites WHERE user_id = $1 AND video_id = $2',
      [userId, videoId]
    );
    
    console.log(`❌ Favorito removido para usuário ${userId}: ${videoId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro em /api/favorites (DELETE):', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/favorites/all', async (req, res) => {
  const { uuid } = req.body;
  
  if (!uuid) {
    return res.status(400).json({ error: 'UUID é obrigatório' });
  }
  
  try {
    const userResult = await pool.query(
      `SELECT u.id FROM twitch_users u
       JOIN user_sessions s ON u.id = s.user_id
       WHERE s.session_uuid = $1`,
      [uuid]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const userId = userResult.rows[0].id;
    await pool.query('DELETE FROM favorites WHERE user_id = $1', [userId]);
    
    console.log(`🗑️ Todos favoritos removidos para usuário ${userId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro em /api/favorites/all:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ==================== YOUTUBE PROXY ====================
app.post('/api/youtube/search', async (req, res) => {
  const { query } = req.body;
  
  if (!query) {
    return res.status(400).json({ error: 'Query é obrigatória' });
  }
  
  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ error: 'YouTube API Key não configurada no servidor' });
  }
  
  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        type: 'video',
        maxResults: 8,
        q: query,
        key: YOUTUBE_API_KEY
      }
    });
    
    res.json(response.data);
  } catch (error) {
    console.error('Erro no proxy YouTube:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.error?.message || 'Erro ao buscar no YouTube' });
  }
});

// ==================== SPOTIFY PROXY ====================
app.post('/api/spotify/search', async (req, res) => {
  const { query } = req.body;
  
  if (!query) {
    return res.status(400).json({ error: 'Query é obrigatória' });
  }
  
  try {
    const token = await getSpotifyAccessToken();
    const response = await axios.get('https://api.spotify.com/v1/search', {
      params: {
        q: query,
        type: 'track',
        limit: 8
      },
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    res.json(response.data);
  } catch (error) {
    console.error('Erro no proxy Spotify:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.error?.message || 'Erro ao buscar no Spotify' });
  }
});

// ==================== ENVIAR COMANDO ====================
app.post('/api/send', async (req, res) => {
  const { uuid, videoId, title, service } = req.body;
  
  if (!uuid || !videoId) {
    return res.status(400).json({ error: 'UUID e videoId são obrigatórios' });
  }
  
  try {
    const userResult = await pool.query(
      `SELECT u.id, u.access_token, u.token_expires_at, u.refresh_token, u.channel_name, u.twitch_user_id
       FROM twitch_users u
       JOIN user_sessions s ON u.id = s.user_id
       WHERE s.session_uuid = $1`,
      [uuid]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const user = userResult.rows[0];
    
    if (!user.channel_name) {
      return res.status(400).json({ error: 'Canal não configurado' });
    }
    
    const accessToken = await getValidAccessToken(user.id, user.refresh_token);
    
    if (!accessToken) {
      return res.status(401).json({ error: 'Token Twitch expirado. Faça login novamente.' });
    }
    
    // Usar a API Helix para enviar mensagem
    try {
      // Obter o ID do broadcaster
      const userInfoResponse = await axios.get('https://api.twitch.tv/helix/users', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Client-Id': TWITCH_CLIENT_ID
        }
      });
      
      const broadcasterId = userInfoResponse.data.data[0].id;
      const message = `!sr ${videoId}`;
      
      // Enviar mensagem usando a API Helix
      await axios.post(
        'https://api.twitch.tv/helix/chat/messages',
        {
          broadcaster_id: broadcasterId,
          moderator_id: broadcasterId,
          message: message
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Client-Id': TWITCH_CLIENT_ID,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`✅ Comando enviado: ${message} para #${user.channel_name} (${service || 'youtube'})`);
      res.json({ success: true });
      
    } catch (apiError) {
      console.error('Erro ao enviar via Helix:', apiError.response?.data || apiError.message);
      res.status(500).json({ error: 'Erro ao enviar mensagem no chat. Verifique se o bot tem permissão.' });
    }
    
  } catch (error) {
    console.error('Erro ao enviar comando:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ==================== INICIAR SERVIDOR ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║          🚀 SONG REQUEST BACKEND - ONLINE 🚀            ║
╠══════════════════════════════════════════════════════════╣
║  📡 Porta: ${PORT}                                          ║
║  🔗 Health: http://localhost:${PORT}/api/health               ║
╠══════════════════════════════════════════════════════════╣
║  🎮 Twitch OAuth: ${TWITCH_CLIENT_ID ? '✅ CONFIGURADO' : '❌ NÃO CONFIGURADO'}                        ║
║  ▶️ YouTube API: ${YOUTUBE_API_KEY ? '✅ CONFIGURADA' : '❌ NÃO CONFIGURADA'}                         ║
║  🎵 Spotify API: ${process.env.SPOTIFY_CLIENT_ID ? '✅ CONFIGURADA' : '❌ NÃO CONFIGURADA'}                         ║
╠══════════════════════════════════════════════════════════╣
║  🌐 Frontend: ${FRONTEND_URL}                              ║
║  🔄 Redirect URI: ${TWITCH_REDIRECT_URI}                    ║
╚══════════════════════════════════════════════════════════╝
  `);
});
