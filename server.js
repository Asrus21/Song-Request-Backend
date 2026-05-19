const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

// ==================== CONFIGURAÇÕES ====================
const TWITCH_CLIENT_ID     = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_REDIRECT_URI  = process.env.TWITCH_REDIRECT_URI || 'https://song-request-backend-production.up.railway.app/api/auth/twitch/callback';
const YOUTUBE_API_KEY      = process.env.YOUTUBE_API_KEY;
const FRONTEND_URL         = process.env.FRONTEND_URL || 'https://asrus21.github.io/Song-Request-Queue/callback.html';

// ==================== POSTGRESQL ====================
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
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
        client_id:     TWITCH_CLIENT_ID,
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
        id                   SERIAL PRIMARY KEY,
        twitch_user_id       VARCHAR(30) UNIQUE NOT NULL,
        twitch_login         VARCHAR(50) NOT NULL,
        twitch_display_name  VARCHAR(100) NOT NULL,
        access_token         TEXT NOT NULL,
        refresh_token        TEXT NOT NULL,
        token_expires_at     TIMESTAMP NOT NULL,
        channel_name         VARCHAR(50),
        created_at           TIMESTAMP DEFAULT NOW(),
        updated_at           TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS favorites (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES twitch_users(id) ON DELETE CASCADE,
        video_id   VARCHAR(100) NOT NULL,
        title      TEXT NOT NULL,
        channel    VARCHAR(255) NOT NULL,
        thumbnail  TEXT,
        service    VARCHAR(20) DEFAULT 'youtube',
        added_at   TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, video_id, service)
      );

      CREATE TABLE IF NOT EXISTS user_sessions (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER REFERENCES twitch_users(id) ON DELETE CASCADE,
        session_uuid VARCHAR(32) UNIQUE NOT NULL,
        created_at   TIMESTAMP DEFAULT NOW(),
        expires_at   TIMESTAMP DEFAULT NOW() + INTERVAL '7 days',
        UNIQUE(user_id)
      );

      -- NOVAS TABELAS DE PLAYLISTS
      CREATE TABLE IF NOT EXISTS playlists (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER REFERENCES twitch_users(id) ON DELETE CASCADE,
        name        VARCHAR(100) NOT NULL,
        created_at  TIMESTAMP DEFAULT NOW(),
        updated_at  TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, name)
      );

      CREATE TABLE IF NOT EXISTS playlist_items (
        id          SERIAL PRIMARY KEY,
        playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
        video_id    VARCHAR(100) NOT NULL,
        title       TEXT NOT NULL,
        channel     VARCHAR(255) NOT NULL,
        thumbnail   TEXT,
        service     VARCHAR(20) DEFAULT 'youtube',
        position    INTEGER DEFAULT 0,
        added_at    TIMESTAMP DEFAULT NOW(),
        UNIQUE(playlist_id, video_id, service)
      );

      CREATE INDEX IF NOT EXISTS idx_twitch_users_twitch_user_id ON twitch_users(twitch_user_id);
      CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON favorites(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_sessions_uuid ON user_sessions(session_uuid);
      CREATE INDEX IF NOT EXISTS idx_playlists_user_id ON playlists(user_id);
      CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist_id ON playlist_items(playlist_id);
    `);

    // Migrations para colunas existentes
    await pool.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS service VARCHAR(20) DEFAULT 'youtube'`);
    await pool.query(`UPDATE favorites SET service = 'youtube' WHERE service IS NULL`);
    await pool.query(`ALTER TABLE favorites ALTER COLUMN video_id TYPE VARCHAR(100)`);
    await pool.query(`ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '7 days'`);

    // Ajuste da constraint UNIQUE
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'favorites_user_id_video_id_key') THEN
          ALTER TABLE favorites DROP CONSTRAINT favorites_user_id_video_id_key;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'favorites_user_id_video_id_service_key') THEN
          ALTER TABLE favorites ADD CONSTRAINT favorites_user_id_video_id_service_key UNIQUE (user_id, video_id, service);
        END IF;
      END $$;
    `);

    console.log('✅ Banco de dados inicializado com sucesso!');
  } catch (error) {
    console.error('Erro ao inicializar banco:', error);
  }
}

initDatabase();

// ==================== SPOTIFY TOKEN ====================
let spotifyAccessToken = null;
let spotifyTokenExpiry = null;

async function getSpotifyAccessToken() {
  if (spotifyAccessToken && spotifyTokenExpiry && Date.now() < spotifyTokenExpiry) {
    return spotifyAccessToken;
  }

  const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
  const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error('Spotify credentials not configured');
  }

  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    {
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
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
  const state   = generateUUID();
  const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(TWITCH_REDIRECT_URI)}&response_type=code&scope=user:write:chat+user:read:email&state=${state}`;
  res.json({ url: authUrl, state });
});

app.get('/api/auth/twitch/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect(`${FRONTEND_URL}?login=error`);
  }

  try {
    const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id:     TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        code,
        grant_type:    'authorization_code',
        redirect_uri:  TWITCH_REDIRECT_URI
      }
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    const userResponse = await axios.get('https://api.twitch.tv/helix/users', {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Client-Id':     TWITCH_CLIENT_ID
      }
    });

    const twitchUser        = userResponse.data.data[0];
    const twitchUserId      = twitchUser.id;
    const twitchLogin       = twitchUser.login;
    const twitchDisplayName = twitchUser.display_name;

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
    } else {
      const insertResult = await pool.query(
        `INSERT INTO twitch_users (twitch_user_id, twitch_login, twitch_display_name, access_token, refresh_token, token_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [twitchUserId, twitchLogin, twitchDisplayName, access_token, refresh_token, expiresAt]
      );
      userId = insertResult.rows[0].id;
    }

    const existingSession = await pool.query(
      'SELECT session_uuid FROM user_sessions WHERE user_id = $1',
      [userId]
    );

    let sessionUUID;
    if (existingSession.rows.length > 0) {
      sessionUUID = existingSession.rows[0].session_uuid;
      await pool.query('UPDATE user_sessions SET created_at = NOW() WHERE user_id = $1', [userId]);
    } else {
      sessionUUID = generateUUID();
      await pool.query(
        'INSERT INTO user_sessions (user_id, session_uuid, created_at) VALUES ($1, $2, NOW())',
        [userId, sessionUUID]
      );
    }

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
              u.access_token, u.token_expires_at, u.refresh_token, s.expires_at
       FROM twitch_users u
       JOIN user_sessions s ON u.id = s.user_id
       WHERE s.session_uuid = $1`,
      [uuid]
    );

    if (result.rows.length === 0) {
      return res.json({ authenticated: false });
    }

    const user = result.rows[0];

    if (user.expires_at && new Date() > new Date(user.expires_at)) {
      await pool.query('DELETE FROM user_sessions WHERE session_uuid = $1', [uuid]);
      return res.json({ authenticated: false });
    }

    const favoritesResult = await pool.query(
      `SELECT video_id, title, channel, thumbnail, service, added_at
       FROM favorites
       WHERE user_id = $1
       ORDER BY added_at DESC`,
      [user.id]
    );

    res.json({
      authenticated: true,
      user: {
        id:          user.twitch_user_id,
        login:       user.twitch_login,
        displayName: user.twitch_display_name,
        channelName: user.channel_name
      },
      isTokenValid: new Date() < new Date(user.token_expires_at),
      favorites: favoritesResult.rows
    });

  } catch (error) {
    console.error('Erro ao verificar sessão:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ==================== FAVORITOS ====================
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
    const safeService = (video.service || 'youtube').substring(0, 50);
    const safeVideoId = (video.id || '').substring(0, 100);
    const safeChannel = (video.channel || '').substring(0, 255);

    await pool.query(
      `INSERT INTO favorites (user_id, video_id, title, channel, thumbnail, service)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, video_id, service) DO UPDATE
         SET title = EXCLUDED.title, channel = EXCLUDED.channel, thumbnail = EXCLUDED.thumbnail`,
      [userId, safeVideoId, video.title, safeChannel, video.thumb, safeService]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Erro em /api/favorites/add:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/favorites/one', async (req, res) => {
  const { uuid, videoId, service } = req.body;

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

    await pool.query(
      'DELETE FROM favorites WHERE user_id = $1 AND video_id = $2 AND service = $3',
      [userResult.rows[0].id, videoId, service || 'youtube']
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Erro em /api/favorites/one:', error);
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

    await pool.query('DELETE FROM favorites WHERE user_id = $1', [userResult.rows[0].id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro em /api/favorites/all:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ==================== PLAYLISTS ====================

// Listar playlists do usuário
app.get('/api/playlists', async (req, res) => {
  const { uuid } = req.query;
  
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

    const playlistsResult = await pool.query(
      `SELECT p.id, p.name, p.created_at,
          (SELECT COUNT(*) FROM playlist_items WHERE playlist_id = p.id) as item_count
       FROM playlists p
       WHERE p.user_id = $1
       ORDER BY p.created_at DESC`,
      [userId]
    );

    res.json({ playlists: playlistsResult.rows });
  } catch (error) {
    console.error('Erro ao listar playlists:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Criar playlist
app.post('/api/playlists/create', async (req, res) => {
  const { uuid, name } = req.body;

  if (!uuid || !name || !name.trim()) {
    return res.status(400).json({ error: 'UUID e nome da playlist são obrigatórios' });
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
    const cleanName = name.trim().substring(0, 100);

    const result = await pool.query(
      `INSERT INTO playlists (user_id, name)
       VALUES ($1, $2)
       ON CONFLICT (user_id, name) DO UPDATE SET updated_at = NOW()
       RETURNING id, name`,
      [userId, cleanName]
    );

    res.json({ success: true, playlist: result.rows[0] });
  } catch (error) {
    console.error('Erro ao criar playlist:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Adicionar música à playlist
app.post('/api/playlists/add', async (req, res) => {
  const { uuid, playlistId, video } = req.body;

  if (!uuid || !playlistId || !video) {
    return res.status(400).json({ error: 'UUID, playlistId e vídeo são obrigatórios' });
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

    const playlistCheck = await pool.query(
      'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
      [playlistId, userId]
    );

    if (playlistCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Playlist não pertence ao usuário' });
    }

    const safeService = (video.service || 'youtube').substring(0, 50);
    const safeVideoId = (video.id || '').substring(0, 100);
    const safeChannel = (video.channel || '').substring(0, 255);

    const posResult = await pool.query(
      'SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM playlist_items WHERE playlist_id = $1',
      [playlistId]
    );
    const nextPosition = posResult.rows[0].next_pos;

    await pool.query(
      `INSERT INTO playlist_items (playlist_id, video_id, title, channel, thumbnail, service, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (playlist_id, video_id, service) DO NOTHING`,
      [playlistId, safeVideoId, video.title, safeChannel, video.thumb, safeService, nextPosition]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao adicionar à playlist:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Listar itens de uma playlist
app.get('/api/playlists/items', async (req, res) => {
  const { uuid, playlistId } = req.query;

  if (!uuid || !playlistId) {
    return res.status(400).json({ error: 'UUID e playlistId são obrigatórios' });
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

    const playlistCheck = await pool.query(
      'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
      [playlistId, userId]
    );

    if (playlistCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Playlist não pertence ao usuário' });
    }

    const itemsResult = await pool.query(
      `SELECT video_id, title, channel, thumbnail, service, added_at, position
       FROM playlist_items
       WHERE playlist_id = $1
       ORDER BY position ASC, added_at ASC`,
      [playlistId]
    );

    res.json({ items: itemsResult.rows });
  } catch (error) {
    console.error('Erro ao listar itens da playlist:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Remover música da playlist
app.delete('/api/playlists/remove', async (req, res) => {
  const { uuid, playlistId, videoId, service } = req.body;

  if (!uuid || !playlistId || !videoId) {
    return res.status(400).json({ error: 'UUID, playlistId e videoId são obrigatórios' });
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

    const playlistCheck = await pool.query(
      'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
      [playlistId, userId]
    );

    if (playlistCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Playlist não pertence ao usuário' });
    }

    await pool.query(
      'DELETE FROM playlist_items WHERE playlist_id = $1 AND video_id = $2 AND service = $3',
      [playlistId, videoId, service || 'youtube']
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao remover da playlist:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Excluir playlist inteira
app.delete('/api/playlists/delete', async (req, res) => {
  const { uuid, playlistId } = req.body;

  if (!uuid || !playlistId) {
    return res.status(400).json({ error: 'UUID e playlistId são obrigatórios' });
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

    await pool.query('DELETE FROM playlists WHERE id = $1 AND user_id = $2', [playlistId, userId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao excluir playlist:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Editar nome da playlist
app.put('/api/playlists/edit', async (req, res) => {
  const { uuid, playlistId, newName } = req.body;

  if (!uuid || !playlistId || !newName || !newName.trim()) {
    return res.status(400).json({ error: 'UUID, playlistId e newName são obrigatórios' });
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
    const cleanName = newName.trim().substring(0, 100);

    // Verifica se a playlist pertence ao usuário
    const playlistCheck = await pool.query(
      'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
      [playlistId, userId]
    );

    if (playlistCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Playlist não pertence ao usuário' });
    }

    // Verifica se já existe outra playlist com o mesmo nome
    const existingCheck = await pool.query(
      'SELECT id FROM playlists WHERE user_id = $1 AND name = $2 AND id != $3',
      [userId, cleanName, playlistId]
    );

    if (existingCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Já existe uma playlist com este nome' });
    }

    await pool.query(
      'UPDATE playlists SET name = $1, updated_at = NOW() WHERE id = $2',
      [cleanName, playlistId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao editar playlist:', error);
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
        part:       'snippet',
        type:       'video',
        maxResults: 8,
        q:          query,
        key:        YOUTUBE_API_KEY
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
    const token    = await getSpotifyAccessToken();
    const response = await axios.get('https://api.spotify.com/v1/search', {
      params:  { q: query, type: 'track', limit: 8 },
      headers: { 'Authorization': `Bearer ${token}` }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Erro no proxy Spotify:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.error?.message || 'Erro ao buscar no Spotify' });
  }
});

// ==================== ENVIAR COMANDO ====================
const twitchIdCache = new Map();
const senderIdCache = new Map();

// ==================== LEITOR DE CHAT IRC (detecção de resposta do bot) ====================
// Conecta ao IRC da Twitch como leitor anônimo e escuta por uma resposta do bot
// mencionando o usuário. Retorna o tipo de resposta detectada.
function listenChatResponse(channel, senderLogin, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let settled = false;
    const cleanChannel = channel.toLowerCase().replace('#', '');
    const cleanSender  = senderLogin.toLowerCase();

    let ws;
    try {
      ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    } catch (e) {
      return resolve({ detected: 'ok' });
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(() => finish({ detected: 'ok' }), timeoutMs);

    ws.on('open', () => {
      // Login anônimo (justinfan) — só leitura, não precisa de token
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send('NICK justinfan' + Math.floor(Math.random() * 100000));
      ws.send(`JOIN #${cleanChannel}`);
    });

    ws.on('message', (data) => {
      const raw = data.toString();

      if (raw.startsWith('PING')) {
        ws.send('PONG :tmi.twitch.tv');
        return;
      }

      if (!raw.includes('PRIVMSG')) return;

      const msgMatch = raw.match(/PRIVMSG #[^ ]+ :(.+)/);
      if (!msgMatch) return;
      const text = msgMatch[1].toLowerCase().trim();

      // A resposta do bot precisa mencionar o usuário que pediu
      if (!text.includes(cleanSender)) return;

      // Cooldown: "you have to wait X seconds before you can request a song again"
      const cooldownMatch = text.match(/wait\s+(\d+)\s+seconds?/);
      if (cooldownMatch) {
        return finish({ detected: 'cooldown', seconds: parseInt(cooldownMatch[1]) });
      }

      // Duplicada: "this song is already in the queue"
      if (text.includes('already in the queue') || text.includes('já está na fila')) {
        return finish({ detected: 'duplicate' });
      }

      // Sucesso explícito: "has been added to the queue"
      if (text.includes('added to the queue') || text.includes('adicionada')) {
        return finish({ detected: 'ok' });
      }
    });

    ws.on('error', () => finish({ detected: 'ok' }));
    ws.on('close', () => { if (!settled) finish({ detected: 'ok' }); });
  });
}

// ==================== ENVIAR COMANDO ====================
app.post('/api/send', async (req, res) => {
  const { uuid, videoId, title, service, channelName } = req.body;

  if (!uuid || !videoId) {
    return res.status(400).json({ error: 'UUID e videoId são obrigatórios' });
  }

  if (!channelName) {
    return res.status(400).json({ error: 'Nome do canal é obrigatório' });
  }

  try {
    const userResult = await pool.query(
      `SELECT u.id, u.access_token, u.token_expires_at, u.refresh_token, u.twitch_user_id, u.twitch_login
       FROM twitch_users u
       JOIN user_sessions s ON u.id = s.user_id
       WHERE s.session_uuid = $1`,
      [uuid]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const user         = userResult.rows[0];
    const cleanChannel = channelName.toLowerCase().replace('#', '');
    const accessToken  = await getValidAccessToken(user.id, user.refresh_token);

    if (!accessToken) {
      return res.status(401).json({ error: 'Token Twitch expirado. Faça login novamente.' });
    }

    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'Client-Id':     TWITCH_CLIENT_ID
    };

    const [broadcasterId, senderId] = await Promise.all([
      (async () => {
        if (twitchIdCache.has(cleanChannel)) return twitchIdCache.get(cleanChannel);
        const r = await axios.get('https://api.twitch.tv/helix/users', { params: { login: cleanChannel }, headers });
        if (!r.data.data.length) throw new Error(`Canal "${cleanChannel}" não encontrado.`);
        const id = r.data.data[0].id;
        twitchIdCache.set(cleanChannel, id);
        return id;
      })(),
      (async () => {
        if (senderIdCache.has(user.id)) return senderIdCache.get(user.id);
        const r = await axios.get('https://api.twitch.tv/helix/users', { headers });
        const id = r.data.data[0].id;
        senderIdCache.set(user.id, id);
        return id;
      })()
    ]);

    const message = service === 'spotify'
      ? `!sr https://open.spotify.com/track/${videoId}`
      : `!sr ${videoId}`;

    // Começa a escutar o chat ANTES de enviar (para não perder a resposta)
    const listenPromise = listenChatResponse(cleanChannel, user.twitch_login, 6000);

    // Envia o comando
    await axios.post(
      'https://api.twitch.tv/helix/chat/messages',
      { broadcaster_id: broadcasterId, sender_id: senderId, message },
      { headers: { ...headers, 'Content-Type': 'application/json' } }
    );

    // Aguarda a resposta do bot
    const botResponse = await listenPromise;

    if (botResponse.detected === 'cooldown') {
      return res.json({
        success: false,
        reason:  'cooldown',
        seconds: botResponse.seconds,
        error:   `Cooldown ativo — aguarde ${botResponse.seconds}s`
      });
    }

    if (botResponse.detected === 'duplicate') {
      return res.json({
        success: false,
        reason:  'duplicate',
        error:   'Música já está na fila'
      });
    }

    // 'ok' ou nada detectado → considera sucesso
    res.json({ success: true });

  } catch (error) {
    console.error('Erro ao enviar comando:', error.response?.data || error.message);
    const msg = error.response?.data?.message || error.message || 'Erro ao enviar mensagem no chat.';
    res.status(500).json({ success: false, reason: 'error', error: msg });
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
║  🎮 Twitch OAuth: ${TWITCH_CLIENT_ID ? '✅ CONFIGURADO' : '❌ NÃO CONFIGURADO'}                        
║  ▶️ YouTube API: ${YOUTUBE_API_KEY ? '✅ CONFIGURADA' : '❌ NÃO CONFIGURADA'}                         
║  🎵 Spotify API: ${process.env.SPOTIFY_CLIENT_ID ? '✅ CONFIGURADA' : '❌ NÃO CONFIGURADA'}                         
╠══════════════════════════════════════════════════════════╣
║  🌐 Frontend: ${FRONTEND_URL}
║  🔄 Redirect URI: ${TWITCH_REDIRECT_URI}
╚══════════════════════════════════════════════════════════╝
  `);
});
