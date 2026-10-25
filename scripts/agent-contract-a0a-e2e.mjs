import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const presetsPath = 'docs/contracts/agent-access-presets.v1.json';
const eventPath = 'docs/contracts/agent-activity.v1.schema.json';
const [presets, eventSchema] = await Promise.all([
  readFile(presetsPath, 'utf8').then(JSON.parse),
  readFile(eventPath, 'utf8').then(JSON.parse)
]);

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, label + ' must not contain duplicates');
}

function validateSchema(schema, value, path = '$') {
  assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema), path + ' invalid schema object');
  if (Object.hasOwn(schema, 'const')) assert.deepEqual(value, schema.const, path + ' const mismatch');
  if (Array.isArray(schema.enum)) assert.ok(schema.enum.includes(value), path + ' must be an enum value');
  if (schema.type) {
    const matches = schema.type === 'object'
      ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : schema.type === 'array' ? Array.isArray(value)
      : schema.type === 'integer' ? Number.isInteger(value)
      : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === schema.type;
    assert.ok(matches, path + ' must be ' + schema.type);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, path + ' minLength');
    if (schema.maxLength !== undefined) assert.ok(value.length <= schema.maxLength, path + ' maxLength');
    if (schema.pattern !== undefined) assert.match(value, new RegExp(schema.pattern), path + ' pattern');
    if (schema.format === 'date-time') {
      assert.ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && !Number.isNaN(Date.parse(value)), path + ' UTC/offset date-time');
    }
    if (schema.format === 'uri') assert.ok(/^https?:\/\//.test(value), path + ' HTTPS/HTTP URI');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, path + ' minimum');
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, path + ' maximum');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, path + ' minItems');
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, path + ' maxItems');
    if (schema.uniqueItems) unique(value.map(x => JSON.stringify(x)), path);
    if (schema.items) value.forEach((item, i) => validateSchema(schema.items, item, path + '[' + i + ']'));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const field of schema.required || []) assert.ok(Object.hasOwn(value, field), path + '.' + field + ' required');
    for (const [key, prop] of Object.entries(value)) {
      if (schema.properties?.[key]) validateSchema(schema.properties[key], prop, path + '.' + key);
      else if (schema.additionalProperties === false) assert.fail(path + '.' + key + ' additionalProperties forbidden');
    }
    for (const clause of schema.allOf || []) {
      if (clause.if) {
        let matches = false;
        try { validateSchema(clause.if, value, path); matches = true; } catch {}
        if (matches && clause.then) validateSchema(clause.then, value, path);
        else if (!matches && clause.else) validateSchema(clause.else, value, path);
      } else {
        validateSchema(clause, value, path);
      }
    }
    if (value.progress) {
      assert.ok(value.progress.completed <= value.progress.total, path + '.progress cannot exceed total');
    }
  }
}

function mustReject(value, label) {
  assert.throws(() => validateSchema(eventSchema, value), undefined, label + ' must fail validation');
}

assert.equal(presets.schemaVersion, 1);
assert.equal(presets.presetVersion, 1);
assert.equal(presets.status, 'PLANNED_CONTRACT_NOT_DEPLOYED');
assert.deepEqual(presets.defaultGrant.presetId, 'OBSERVER');
assert.deepEqual(presets.defaultGrant.publishMode, 'DRAFT_ONLY');
for (const field of ['projectIds', 'accountIds', 'sourceConnectorIds', 'scopes']) {
  assert.deepEqual(presets.defaultGrant[field], [], 'default ' + field + ' must be empty');
}

const catalog = presets.scopes.map(s => s.id);
unique(catalog, 'scope IDs');
assert.equal(catalog.length, 13, 'every scope must be explicitly versioned');
assert.ok(catalog.every(s => /^[a-z]+:[a-z-]+$/.test(s)));
const byId = Object.fromEntries(presets.presets.map(p => [p.id, p]));
unique(presets.presets.map(p => p.id), 'preset IDs');
assert.deepEqual(Object.keys(byId), ['OBSERVER', 'LIMITED', 'EXTENDED', 'FULL_CONTENT', 'CUSTOM']);
assert.deepEqual(presets.publishModes.map(p => p.id), ['DRAFT_ONLY', 'OWNER_APPROVAL', 'PREAPPROVED_POLICY']);
const modeSet = new Set(presets.publishModes.map(p => p.id));
const scopeSet = new Set(catalog);
const forbidden = new Set(['admin:write', 'credentials:read', 'credential:export', 'grants:write', 'secrets:read', 'server:shell']);
for (const p of presets.presets) {
  assert.equal(typeof p.label, 'string');
  assert.ok(p.description && p.can?.length && p.cannot?.length, p.id + ' missing user-facing description');
  unique(p.scopes, p.id + ' scope list');
  assert.ok(p.scopes.every(scope => scopeSet.has(scope) && !forbidden.has(scope)), p.id + ' unknown or privileged scopes');
  unique(p.allowedPublishModes, p.id + ' modes');
  assert.ok(p.allowedPublishModes.every(mode => modeSet.has(mode)), p.id + ' invalid send mode');
}
assert.deepEqual(byId.OBSERVER.allowedPublishModes, ['DRAFT_ONLY']);
assert.deepEqual(byId.LIMITED.allowedPublishModes, ['DRAFT_ONLY']);
assert.ok(!byId.LIMITED.scopes.includes('publish:request'));
assert.ok(byId.LIMITED.scopes.includes('approval:request'), 'editorial review must be distinct from send request');
assert.deepEqual(byId.EXTENDED.allowedPublishModes, ['DRAFT_ONLY', 'OWNER_APPROVAL']);
assert.deepEqual(byId.FULL_CONTENT.allowedPublishModes, ['DRAFT_ONLY', 'OWNER_APPROVAL', 'PREAPPROVED_POLICY']);
assert.equal(byId.CUSTOM.scopeSource, 'owner-selection');
assert.deepEqual(byId.CUSTOM.scopes, [], 'custom cannot silently copy full scopes');
assert.equal(byId.CUSTOM.modeRules.PREAPPROVED_POLICY.ownerApprovedPolicy, true);
assert.ok(byId.CUSTOM.modeRules.PREAPPROVED_POLICY.requires.every(s => scopeSet.has(s)));
assert.equal(presets.rules.newAccountAutoInheritance, false);
assert.equal(presets.rules.noImplicitWildcard, true);
assert.equal(presets.rules.fullContentIsNotAdmin, true);
assert.equal(presets.rules.externalPublishNeedsExplicitConsentOrPreapprovedPolicy, true);
assert.ok(presets.ownerOnlyOperations.includes('grant:update'));
assert.ok(presets.ownerOnlyOperations.includes('intent:approve'));
assert.ok(presets.ownerOnlyOperations.every(name => !scopeSet.has(name)));

assert.equal(eventSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
assert.equal(eventSchema.type, 'object');
assert.equal(eventSchema.additionalProperties, false);
assert.equal(eventSchema.properties.schemaVersion.const, 1);
assert.ok(eventSchema.required.includes('requestId'));
assert.ok(eventSchema.required.includes('safeSummary'));
assert.ok(eventSchema.properties.stage.enum.includes('RECOVERY_NEEDED'));
assert.ok(eventSchema.properties.stage.enum.includes('DENIED'));
assert.ok(eventSchema.properties.stage.enum.includes('WAITING_APPROVAL'));
assert.ok(eventSchema.properties.origin.enum.includes('MCP'));
assert.ok(eventSchema.properties.origin.enum.includes('SCHEDULER'));
for (const secretField of ['authorization', 'accessToken', 'refreshToken', 'rawPrompt', 'requestBody', 'privateKey', 'APP_MASTER_KEY', 'credentials']) {
  assert.ok(!Object.hasOwn(eventSchema.properties, secretField), 'forbidden audit field ' + secretField);
}
assert.equal(eventSchema.examples.length, 3);
for (const [i, event] of eventSchema.examples.entries()) validateSchema(eventSchema, event, 'example ' + i);

const sample = structuredClone(eventSchema.examples[0]);
const withoutAgent = structuredClone(sample);
delete withoutAgent.agentId;
mustReject(withoutAgent, 'AGENT without agentId');
const leakedToken = { ...sample, authorization: 'Bearer hidden-secret' };
mustReject(leakedToken, 'extra authorization secret');
const leakedPrompt = { ...sample, rawPrompt: 'ignore your rules' };
mustReject(leakedPrompt, 'untrusted model reasoning');
mustReject({ ...sample, stage: 'FAKE_SUCCESS' }, 'invented stage');
mustReject({ ...sample, safeSummary: 'x'.repeat(241) }, 'unbounded audit string');
const progress = structuredClone(eventSchema.examples[2]);
mustReject({ ...progress, progress: { completed: 4, total: 3 } }, 'fake >100% progress');
const withoutJob = structuredClone(progress);
delete withoutJob.jobId;
mustReject(withoutJob, 'PROGRESS without real jobId');
const withWrongTarget = { ...sample, targetAccountIds: ['vk1', 'vk1'] };
mustReject(withWrongTarget, 'duplicate target IDs');
const withSecretTarget = { ...sample, externalResults: [{ accountId: 'vk1', state: 'PUBLISHED', authorization: 'hidden' }] };
mustReject(withSecretTarget, 'secret in per-target status');
const oversizedPerTargetCode = { ...sample, externalResults: [{ accountId: 'vk1', state: 'FAILED', errorCode: 'A'.repeat(81) }] };
mustReject(oversizedPerTargetCode, 'unbounded per-target errorCode');

const [productSpec, integrationSpec, workflow] = await Promise.all([
  readFile('docs/AGENT_ACCESS_LEVELS_AND_ACTIVITY_LOGS.md', 'utf8'),
  readFile('docs/UNIVERSAL_AGENT_API_MCP_SPEC.md', 'utf8'),
  readFile('.github/workflows/publikator-ci.yml', 'utf8')
]);
for (const p of presets.presets) {
  assert.ok(productSpec.includes(p.label), 'product spec missing level ' + p.id);
}
for (const mode of presets.publishModes) {
  assert.ok(productSpec.includes(mode.id), 'product spec missing send mode ' + mode.id);
}
assert.ok(productSpec.includes('UI-15'), 'product acceptance must reach single activity source');
assert.ok(integrationSpec.includes('docs/contracts/agent-access-presets.v1.json'), 'master spec missing preset contract');
assert.ok(integrationSpec.includes('docs/contracts/agent-activity.v1.schema.json'), 'master spec missing activity contract');
assert.match(workflow, /node scripts\/agent-contract-a0a-e2e\.mjs/, 'focused check must run in canonical CI');

console.log(JSON.stringify({
  ok: true, checkpoint: 'AGENT-A0a', deployment: 'NOT_IMPLEMENTED',
  presetVersion: presets.presetVersion, presetIds: Object.keys(byId),
  sendModes: presets.publishModes.map(m => m.id),
  scopeCount: catalog.length, activityEventSchema: '2020-12',
  samplesValidated: eventSchema.examples.length,
  negativeCases: 10,
  canonicalAcceptanceWired: true
}, null, 2));
