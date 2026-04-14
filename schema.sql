CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL,
  player TEXT NOT NULL CHECK(length(player) >= 1 AND length(player) <= 6),
  score INTEGER NOT NULL CHECK(score > 0),
  level INTEGER DEFAULT 1,
  ip TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_game_score ON scores(game, score DESC);
CREATE INDEX IF NOT EXISTS idx_game_player ON scores(game, player);
