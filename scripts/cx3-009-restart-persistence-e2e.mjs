import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PHASE = process.env.CX3_RESTART_PHASE || '';
const ADMIN_PASSWORD = 'cx3-009-ci-password';
const APP_MASTER_KEY = 'cx3-009-master-key-that-is-longer-than-thirty-two-characters';
const RANGE_FROM = '2026-10-10T00:00:00.000Z';
const RANGE_TO = '2026-10-20T00:00:00.000Z';

async function openApplication() {
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.APP_MASTER_KEY = APP_MASTER_KEY;
  process.env.PUBLIC_BASE_URL = 'https://publisher.example.test';

  const { db, migrate, id, nowIso } = await import('../dist/db.js');
  const { buildApp } = await import('../dist/app.js');
  migrate();
  const app = await buildApp();
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: ADMIN_PASSWORD }
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];

  async function request(method, url, payload) {
    return app.inject({
      method,
      url,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload })
    });
  }

  return { app, db, id, nowIso, request };
}

async function closeApplication(app, db) {
  await app.close();
  db.close();
}

async function seedPhase() {
  const stateFile = process.env.CX3_STATE_FILE;
  assert.ok(stateFile, 'CX3_STATE_FILE is required in seed phase');
  const { app, db, id, nowIso, request } = await openApplication();

  try {
    const project = db.prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get();
    assert.ok(project?.id, 'default project missing after migration');

    const activePosts = [];
    for (let index = 0; index < 12; index += 1) {
      const when = new Date(Date.parse(RANGE_FROM) + index * 6 * 60 * 60 * 1000);
      const response = await request('POST', '/api/posts', {
        projectId: project.id,
        title: `Restart fixture ${String(index).padStart(2, '0')}`,
        body: `Persistent body ${index}`,
        scheduleMode: 'AT',
        scheduledAt: when.toISOString(),
        scheduleTimezone: index % 2 === 0 ? 'Europe/Moscow' : 'UTC'
      });
      assert.equal(response.statusCode, 201, response.body);
      activePosts.push(response.json());
    }

    const sample = activePosts[3];
    const accountId = id('acc');
    db.prepare(`INSERT INTO social_accounts
      (id,platform,name,credentials_encrypted,enabled,created_at,updated_at)
      VALUES (?,?,?,?,1,?,?)`).run(
      accountId,
      'telegram',
      'Restart persistence channel',
      'fixture',
      nowIso(),
      nowIso()
    );
    db.prepare(`INSERT INTO post_targets
      (id,post_id,account_id,enabled,state,attempts,updated_at)
      VALUES (?,?,?,1,'PENDING',0,?)`).run(
      id('target'),
      sample.id,
      accountId,
      nowIso()
    );
    db.prepare(`INSERT INTO media
      (id,post_id,original_name,relative_path,mime_type,size_bytes,width,height,sha256,created_at,sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,0)`).run(
      id('med'),
      sample.id,
      'restart.jpg',
      `${sample.id}/restart.jpg`,
      'image/jpeg',
      1024,
      1200,
      630,
      'b'.repeat(64),
      nowIso()
    );
    db.prepare(`UPDATE posts
      SET source_type='integration_api', source_ref='cx3-009-restart'
      WHERE id=?`).run(sample.id);

    db.prepare("UPDATE posts SET editorial_stage='ARCHIVED' WHERE id=?").run(activePosts[0].id);
    db.prepare("UPDATE posts SET editorial_stage='TRASHED' WHERE id=?").run(activePosts[1].id);

    const manual = await request('POST', '/api/posts', {
      projectId: project.id,
      title: 'Restart manual unscheduled',
      body: 'Must stay outside calendar after restart',
      scheduleMode: 'MANUAL'
    });
    assert.equal(manual.statusCode, 201, manual.body);

    const response = await request(
      'GET',
      `/api/calendar?from=${encodeURIComponent(RANGE_FROM)}&to=${encodeURIComponent(RANGE_TO)}`
    );
    assert.equal(response.statusCode, 200, response.body);
    const calendar = response.json();
    assert.equal(calendar.count, 10);
    assert.equal(calendar.items.length, 10);

    const projected = calendar.items.find((item) => item.id === sample.id);
    assert.ok(projected, 'sample post missing from seeded calendar projection');
    assert.equal(projected.thumbnail_path, `${sample.id}/restart.jpg`);
    assert.deepEqual(projected.platforms, ['telegram']);
    assert.equal(projected.source_type, 'integration_api');
    assert.equal(projected.source_ref, 'cx3-009-restart');
    assert.equal(projected.schedule_timezone, 'UTC');

    const schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(schemaVersion, 11);

    await fs.writeFile(
      stateFile,
      `${JSON.stringify({ calendar, sampleId: sample.id, schemaVersion }, null, 2)}\n`,
      'utf8'
    );
  } finally {
    await closeApplication(app, db);
  }
}

async function verifyPhase() {
  const stateFile = process.env.CX3_STATE_FILE;
  assert.ok(stateFile, 'CX3_STATE_FILE is required in verify phase');
  const expected = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  const { app, db, request } = await openApplication();

  try {
    const schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(schemaVersion, expected.schemaVersion);
    assert.equal(schemaVersion, 11);

    const response = await request(
      'GET',
      `/api/calendar?from=${encodeURIComponent(RANGE_FROM)}&to=${encodeURIComponent(RANGE_TO)}`
    );
    assert.equal(response.statusCode, 200, response.body);
    const afterRestart = response.json();

    assert.deepEqual(afterRestart, expected.calendar);
    const projected = afterRestart.items.find((item) => item.id === expected.sampleId);
    assert.ok(projected, 'sample post missing after process restart');
    assert.equal(projected.thumbnail_path, `${expected.sampleId}/restart.jpg`);
    assert.deepEqual(projected.platforms, ['telegram']);
    assert.equal(projected.source_type, 'integration_api');
    assert.equal(projected.source_ref, 'cx3-009-restart');
  } finally {
    await closeApplication(app, db);
  }
}

if (PHASE === 'seed') {
  await seedPhase();
  process.exit(0);
}

if (PHASE === 'verify') {
  await verifyPhase();
  process.exit(0);
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publikator-cx3-009-'));
const stateFile = path.join(dataDir, 'expected-calendar.json');
const scriptPath = path.resolve(process.argv[1]);

function runPhase(phase) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      ADMIN_PASSWORD,
      APP_MASTER_KEY,
      PUBLIC_BASE_URL: 'https://publisher.example.test',
      CX3_RESTART_PHASE: phase,
      CX3_STATE_FILE: stateFile
    },
    encoding: 'utf8',
    timeout: 120000
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `CX3-009 ${phase} phase failed`);
}

try {
  runPhase('seed');
  runPhase('verify');

  const persisted = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  console.log(JSON.stringify({
    ok: true,
    checkpoint: 'CX3-009',
    processRestartPersistence: true,
    exactCanonicalCalendarProjectionPreserved: true,
    schemaVersionPreserved: persisted.schemaVersion,
    projectedItems: persisted.calendar.items.length,
    mediaPlatformSourceProjectionPreserved: true
  }, null, 2));
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}
