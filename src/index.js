// Arcade API — Cloudflare Worker + D1
// Leaderboard and stats for Tetris, Pac-Man, Space Invaders

const VALID_GAMES = ['tetris', 'pacman', 'space-invaders'];
const SCORE_LIMITS = {
  'tetris': 999999,
  'pacman': 999999,
  'space-invaders': 99999
};
const MIN_GAME_TIME_MS = 30000; // 30 seconds minimum
const MAX_TOKEN_AGE_MS = 86400000; // 24 hours
const DEDUPE_WINDOW_SEC = 60; // reject duplicate within 60s
const CORS_ORIGIN = '*'; // all origins (games on different subdomains)

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': CORS_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

function err(status, message) {
  return json({ error: message }, status);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': CORS_ORIGIN,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // ── POST /api/score ──────────────────────────────────────────────
    if (path === '/api/score' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch(e) { return err(400, 'invalid JSON'); }

      const { game, player, score, level, token, email } = body;

      // Honeypot
      if (email) return err(400, 'bad request');

      // Validate game
      if (!VALID_GAMES.includes(game)) return err(400, 'invalid game');

      // Validate player: 1-6 uppercase letters
      if (!player || typeof player !== 'string') return err(400, 'player required');
      const cleanPlayer = player.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
      if (cleanPlayer.length < 1) return err(400, 'player must be 1-6 letters');

      // Validate score
      if (typeof score !== 'number' || score <= 0) return err(400, 'invalid score');
      if (score > SCORE_LIMITS[game]) return err(400, 'score exceeds maximum');

      // Validate token (game start timestamp)
      if (!token || typeof token !== 'number') return err(400, 'missing token');
      const now = Date.now();
      if (token > now) return err(400, 'invalid token');
      if (now - token < MIN_GAME_TIME_MS) return err(400, 'game too short');
      if (now - token > MAX_TOKEN_AGE_MS) return err(400, 'token expired');

      // Deduplicate: same player+game+score within 60s
      const dedupe = await env.DB.prepare(
        `SELECT id FROM scores WHERE game = ? AND player = ? AND score = ?
         AND created_at > datetime('now', '-${DEDUPE_WINDOW_SEC} seconds') LIMIT 1`
      ).bind(game, cleanPlayer, score).first();
      if (dedupe) return err(409, 'duplicate score');

      // Get IP for logging (not exposed in API)
      const ip = request.headers.get('CF-Connecting-IP') || '';

      // Insert
      await env.DB.prepare(
        'INSERT INTO scores (game, player, score, level, ip) VALUES (?, ?, ?, ?, ?)'
      ).bind(game, cleanPlayer, Math.floor(score), level || 1, ip).run();

      // Get rank
      const rankResult = await env.DB.prepare(
        `SELECT COUNT(DISTINCT player) + 1 as rank FROM scores
         WHERE game = ? AND score > (SELECT MAX(score) FROM scores WHERE game = ? AND player = ?)`
      ).bind(game, game, cleanPlayer).first();

      return json({ ok: true, rank: rankResult ? rankResult.rank : 1, player: cleanPlayer });
    }

    // ── GET /api/leaderboard/:game ───────────────────────────────────
    const leaderboardMatch = path.match(/^\/api\/leaderboard\/([\w-]+)$/);
    if (leaderboardMatch && request.method === 'GET') {
      const game = leaderboardMatch[1];
      if (!VALID_GAMES.includes(game)) return err(400, 'invalid game');

      const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 50);

      const rows = await env.DB.prepare(
        `SELECT player, MAX(score) as score, MAX(level) as level, COUNT(*) as games
         FROM scores WHERE game = ? GROUP BY player ORDER BY score DESC LIMIT ?`
      ).bind(game, limit).all();

      return json(rows.results);
    }

    // ── GET /api/leaderboard (all games) ─────────────────────────────
    if (path === '/api/leaderboard' && request.method === 'GET') {
      const result = {};
      for (const game of VALID_GAMES) {
        const rows = await env.DB.prepare(
          `SELECT player, MAX(score) as score, MAX(level) as level
           FROM scores WHERE game = ? GROUP BY player ORDER BY score DESC LIMIT 10`
        ).bind(game).all();
        result[game] = rows.results;
      }
      return json(result);
    }

    // ── GET /api/stats/:game/:player ─────────────────────────────────
    const statsMatch = path.match(/^\/api\/stats\/([\w-]+)\/([A-Za-z]{1,6})$/);
    if (statsMatch && request.method === 'GET') {
      const game = statsMatch[1];
      const player = statsMatch[2].toUpperCase();
      if (!VALID_GAMES.includes(game)) return err(400, 'invalid game');

      const stats = await env.DB.prepare(
        `SELECT MAX(score) as bestScore, MAX(level) as bestLevel, COUNT(*) as gamesPlayed
         FROM scores WHERE game = ? AND player = ?`
      ).bind(game, player).first();

      // Get rank
      const rankResult = await env.DB.prepare(
        `SELECT COUNT(DISTINCT player) + 1 as rank FROM scores
         WHERE game = ? AND score > ?`
      ).bind(game, stats ? stats.bestScore || 0 : 0).first();

      return json({
        player,
        bestScore: stats ? stats.bestScore : 0,
        bestLevel: stats ? stats.bestLevel : 0,
        gamesPlayed: stats ? stats.gamesPlayed : 0,
        rank: rankResult ? rankResult.rank : 0
      });
    }

    // ── Health check ─────────────────────────────────────────────────
    if (path === '/api/health') {
      return json({ status: 'ok', games: VALID_GAMES });
    }

    return err(404, 'not found');
  }
};
