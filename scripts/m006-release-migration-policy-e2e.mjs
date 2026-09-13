import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const { DATABASE_SCHEMA_VERSION, SCHEMA_MILESTONES } = await import('../dist/schema.js');
const versions = SCHEMA_MILESTONES.map((milestone) => milestone.version);
assert.equal(versions[0], 3, 'schema 3 must remain the V1 baseline');
assert.equal(versions.at(-1), DATABASE_SCHEMA_VERSION, 'latest milestone must equal DATABASE_SCHEMA_VERSION');
for (let index = 1; index < versions.length; index += 1) {
  assert.equal(versions[index], versions[index - 1] + 1, 'schema milestones must be contiguous');
}

const workflow = await fs.readFile('.github/workflows/publikator-ci.yml', 'utf8');
const dbSource = await fs.readFile('src/db.ts', 'utf8');
for (const milestone of SCHEMA_MILESTONES.filter((item) => item.version > 3)) {
  assert.ok(milestone.backupRegression, `schema ${milestone.version} requires a backup regression`);
  await fs.access(milestone.migrationRegression);
  await fs.access(milestone.backupRegression);
  assert.ok(workflow.includes(milestone.migrationRegression), `${milestone.migrationRegression} missing from Acceptance`);
  assert.ok(workflow.includes(milestone.backupRegression), `${milestone.backupRegression} missing from Acceptance`);
  assert.ok(dbSource.includes(`currentSchemaVersion < ${milestone.version}`), `schema ${milestone.version} migration gate missing`);
}
const policy = await fs.readFile('docs/RELEASE_MIGRATION_POLICY.md', 'utf8');
for (const required of ['release/1.0', 'main', 'forward-port', 'SCHEMA_MILESTONES', 'backup/restore']) {
  assert.ok(policy.includes(required), `release/migration policy missing ${required}`);
}
assert.match(policy, /Never merge `main` back into `release\/1\.0`/);
assert.match(policy, /security, data-loss, backup\/restore, publication-safety/);

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'M0-006',
  databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
  milestones: versions,
  forwardPortPolicy: true,
  contiguousSchemaMilestones: true,
  migrationAndBackupEvidenceEnforced: true
}, null, 2));
