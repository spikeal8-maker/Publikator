import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-schema-v3-'));
const dbPath = path.join(dataDir, 'publikator.sqlite');

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = 'schema-v3-ci-password';
process.env.APP_MASTER_KEY = 'schema-v3-master-key-that-is-longer-than-32-characters';
process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE schedule_slots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
    time_hhmm TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_fired_on TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO projects (id,name,slug,created_at)
    VALUES ('legacy-project','Legacy project','legacy-project','2026-01-01T00:00:00.000Z');
  INSERT INTO schedule_slots (id,project_id,weekday,time_hhmm,timezone,enabled,last_fired_on,created_at)
    VALUES
      ('slot-old','legacy-project',1,'18:00','Europe/Moscow',1,'2026-09-01','2026-01-01T00:00:00.000Z'),
      ('slot-new','legacy-project',1,'18:00','Europe/Moscow',1,'2026-09-08','2026-02-01T00:00:00.000Z');
  PRAGMA user_version = 2;
`);
legacy.close();

const { db, migrate } = await import('../dist/db.js');
const { buildApp } = await import('../dist/app.js');

migrate();

try {
  assert.equal(Number(db.pragma('user_version', { simple: true })), 5);

  const slots = db.prepare(`SELECT id,last_fired_on FROM schedule_slots
    WHERE project_id='legacy-project' AND weekday=1 AND time_hhmm='18:00' AND timezone='Europe/Moscow'`).all();
  assert.equal(slots.length, 1, 'migration must collapse duplicate schedule slots');
  assert.equal(slots[0].id, 'slot-old', 'earliest created slot is the deterministic keeper');
  assert.equal(slots[0].last_fired_on, '2026-09-08', 'keeper must preserve the latest last_fired_on across duplicates');

  const uniqueIndex = db.prepare(`SELECT name FROM sqlite_master
    WHERE type='index' AND name='uq_schedule_slots_project_weekday_time_timezone'`).get();
  assert.ok(uniqueIndex, 'schema v3 unique schedule index is missing');

  assert.throws(() => {
    db.prepare(`INSERT INTO schedule_slots
      (id,project_id,weekday,time_hhmm,timezone,enabled,last_fired_on,created_at)
      VALUES ('slot-direct-duplicate','legacy-project',1,'18:00','Europe/Moscow',1,NULL,?)`)
      .run(new Date().toISOString());
  }, /UNIQUE constraint failed/);

  const app = await buildApp();
  await app.ready();
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: process.env.ADMIN_PASSWORD }
    });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = String(login.headers['set-cookie']).split(';')[0];

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      headers: { cookie },
      payload: { projectId: 'legacy-project', weekday: 1, time: '18:00', timezone: 'Europe/Moscow' }
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.match(duplicate.json().error, /уже существует/i);

    const distinct = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      headers: { cookie },
      payload: { projectId: 'legacy-project', weekday: 1, time: '19:00', timezone: 'Europe/Moscow' }
    });
    assert.equal(distinct.statusCode, 201, distinct.body);
  } finally {
    await app.close();
  }

  console.log(JSON.stringify({ ok: true, schemaVersion: 5, duplicateSlotsCollapsed: true, duplicateApiStatus: 409 }, null, 2));
} finally {
  db.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
