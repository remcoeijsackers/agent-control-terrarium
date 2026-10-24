-- Tasks the plugin has seen (only ids, codes and status; never titles or prompts), the beats of activity that drive the
-- pulse, and the worlds people and agents chose to keep. No composite primary keys: SQLite would name their index
-- sqlite_autoindex_…, which Agent Control's SQL sandbox refuses because it is not one of the plugin's own names.
CREATE TABLE {{tasks}} (id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT NOT NULL, code TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX {{tasks}}_key ON {{tasks}} (workspace_id, task_id);
CREATE TABLE {{beats}} (id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, task_id TEXT, at TEXT NOT NULL);
CREATE INDEX {{beats}}_ws_at ON {{beats}} (workspace_id, at);
CREATE TABLE {{worlds}} (id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, seed TEXT NOT NULL, heat REAL NOT NULL, water REAL NOT NULL, life REAL NOT NULL, weird REAL NOT NULL, species INTEGER NOT NULL, lore TEXT, author TEXT NOT NULL, task_id TEXT, created_at TEXT NOT NULL);
