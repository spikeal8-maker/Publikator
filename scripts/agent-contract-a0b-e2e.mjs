import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The OpenAPI .yaml artifact intentionally uses YAML 1.2's JSON-compatible flow syntax.
// This keeps A0b verification dependency-free and prevents a second package-lock writer.
const [openapi, mcp, examples, grants, activity] = await Promise.all([
  readFile('docs/contracts/agent-api-v1.openapi.yaml', 'utf8').then(JSON.parse),
  readFile('docs/contracts/mcp-tools.v1.json', 'utf8').then(JSON.parse),
  readFile('docs/contracts/agent-contract-examples.json', 'utf8').then(JSON.parse),
  readFile('docs/contracts/agent-access-presets.v1.json', 'utf8').then(JSON.parse),
  readFile('docs/contracts/agent-activity.v1.schema.json', 'utf8').then(JSON.parse)
]);

const schemaDefs = openapi.components.schemas;
function schemaByRef(ref) {
  assert.match(ref, /^#\/components\/schemas\/[A-Za-z]+$/);
  const name = ref.split('/').at(-1);
  assert.ok(schemaDefs[name], 'unresolved schema reference ' + ref);
  return schemaDefs[name];
}
function walkRefs(node, where, depth = 0) {
  assert.ok(depth < 40, 'schema ref depth at ' + where);
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((v, i) => walkRefs(v, where + '[' + i + ']', depth + 1));
  if (node.$ref) schemaByRef(node.$ref);
  for (const [k, v] of Object.entries(node)) walkRefs(v, where + '/' + k, depth + 1);
}
function expanded(schema, depth = 0) {
  assert.ok(depth < 40, 'schema ref cycle');
  if (schema?.$ref) return expanded(schemaByRef(schema.$ref), depth + 1);
  return schema;
}
function valid(schema, value, path = '$', depth = 0) {
  assert.ok(depth < 40, path + ' schema recursion');
  schema = expanded(schema, depth);
  assert.ok(schema && typeof schema === 'object');
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, path + ' const');
  if (schema.enum) assert.ok(schema.enum.includes(value), path + ' enum');
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert.ok(types.some(t => t === 'null' ? value === null
      : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : t === 'array' ? Array.isArray(value)
      : t === 'integer' ? Number.isInteger(value)
      : typeof value === t), path + ' type');
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, path + ' minLength');
    if (schema.maxLength !== undefined) assert.ok(value.length <= schema.maxLength, path + ' maxLength');
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), path + ' pattern');
    if (schema.format === 'date-time') assert.ok(!Number.isNaN(Date.parse(value)) && /[Z+-]\d\d:?(\d\d)?$/.test(value), path + ' date-time');
    if (schema.format === 'uri') assert.ok(/^https?:\/\//.test(value), path + ' URI');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, path + ' minimum');
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, path + ' maximum');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, path + ' minItems');
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, path + ' maxItems');
    if (schema.uniqueItems) assert.equal(new Set(value.map(JSON.stringify)).size, value.length, path + ' uniqueItems');
    if (schema.items) value.forEach((x, i) => valid(schema.items, x, path + '[' + i + ']', depth + 1));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) assert.ok(Object.hasOwn(value, k), path + '.' + k + ' required');
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) valid(schema.properties[k], v, path + '.' + k, depth + 1);
      else if (schema.additionalProperties === false) assert.fail(path + '.' + k + ' extra field');
    }
    if (schema.if) {
      let matched = true;
      try { valid(schema.if, value, path, depth + 1); } catch { matched = false; }
      if (matched && schema.then) valid(schema.then, value, path, depth + 1);
      if (!matched && schema.else) valid(schema.else, value, path, depth + 1);
    }
    for (const s of schema.allOf || []) valid(s, value, path, depth + 1);
    if (schema.oneOf) {
      const matches = schema.oneOf.filter(s => {
        try { valid(s, value, path, depth + 1); return true; } catch { return false; }
      }).length;
      assert.equal(matches, 1, path + ' oneOf');
    }
  }
}
assert.equal(openapi.openapi, '3.1.0');
assert.equal(openapi['x-publikator-contract-status'], 'PLANNED_NOT_IMPLEMENTED');
assert.equal(mcp.status, 'PLANNED_NOT_DEPLOYED');
assert.equal(examples.status, 'PLANNED_NOT_DEPLOYED');
assert.equal(mcp.protocolVersion, '2026-07-28');
assert.equal(openapi.components.securitySchemes.ownerSession.in, 'cookie');
assert.equal(openapi.components.securitySchemes.agentOAuth.type, 'oauth2');
assert.equal(openapi.components.securitySchemes.agentApiKey.scheme, 'bearer');
assert.deepEqual(schemaDefs.AgentActivity.properties, activity.properties, 'audit contract drift');
walkRefs(openapi.paths, 'paths');
walkRefs(schemaDefs, 'schemas');
assert.ok(Object.keys(schemaDefs).length >= 28);

const catalog = new Map();
let agentRoutes = 0;
let ownerRoutes = 0;
for (const [path, methods] of Object.entries(openapi.paths)) {
  assert.ok(path.startsWith('/api/agent/v1/') || path.startsWith('/api/owner/'));
  for (const [method, op] of Object.entries(methods)) {
    assert.ok(['get', 'post', 'patch', 'put'].includes(method), 'unsupported method ' + method);
    assert.match(op.operationId, /^[a-z][A-Za-z0-9]+$/);
    assert.ok(!catalog.has(op.operationId), 'duplicate operationId ' + op.operationId);
    catalog.set(op.operationId, { path, method, op });
    assert.ok(Array.isArray(op.security) && op.security.length === 1);
    assert.ok(Array.isArray(op['x-publikator-required-scopes']));
    const isOwner = path.startsWith('/api/owner/');
    if (isOwner) {
      ownerRoutes++;
      assert.deepEqual(op.tags, ['Owner']);
      assert.deepEqual(op.security, [{ownerSession:[]}]);
      assert.equal(op['x-publikator-auth-kind'], 'OWNER_COOKIE');
      assert.deepEqual(op['x-publikator-required-scopes'], []);
    } else {
      agentRoutes++;
      assert.deepEqual(op.tags, ['Agent']);
      assert.equal(op['x-publikator-auth-kind'], 'AGENT_GRANT');
      assert.deepEqual(op.security, [{agentOAuth:op['x-publikator-required-scopes']},{agentApiKey:[]}]);
      for (const scope of op['x-publikator-required-scopes']) {
        assert.ok(grants.scopes.some(g => g.id === scope), op.operationId + ' unknown scope ' + scope);
      }
    }
    for (const code of ['200','201','202','400','401','403','404','409','429']) {
      if (op.responses[code] === undefined) continue;
      assert.ok(op.responses[code].content?.['application/json']?.schema, op.operationId + ' response missing schema');
    }
    for (const code of ['400','401','403','409','429']) assert.ok(op.responses[code], op.operationId + ' missing error '+code);
    assert.ok(op.responses['200'] || op.responses['201'] || op.responses['202'], op.operationId + ' no success');
    for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map(x=>x[1])) {
      assert.ok(op.parameters.some(p => p.in === 'path' && p.name === name && p.required), op.operationId + ' pathId unbound');
    }
    if (method !== 'get') {
      assert.ok(op.parameters.some(p => p.in === 'header' && p.name === 'Idempotency-Key' && p.required), op.operationId + ' lacks mutation idempotency key');
      assert.ok(op.requestBody?.content?.['application/json']?.schema, op.operationId + ' request body missing');
    }
  }
}
assert.equal(agentRoutes, 21);
assert.equal(ownerRoutes, 11);
assert.equal(catalog.size, 32);
assert.equal(mcp.tools.length, agentRoutes);
assert.equal(new Set(mcp.tools.map(t => t.name)).size, mcp.tools.length, 'duplicate MCP tools');
const names = new Set();
for (const tool of mcp.tools) {
  assert.ok(tool.name.startsWith('publikator_'));
  assert.ok(!names.has(tool.restOperationId));
  names.add(tool.restOperationId);
  const r = catalog.get(tool.restOperationId);
  assert.ok(r, 'MCP tool not found in REST ' + tool.restOperationId);
  assert.equal(r.op.tags[0], 'Agent', 'owner operation must never become agent tool');
  assert.equal(tool.restMethod, r.method.toUpperCase());
  assert.equal(tool.restPath, r.path);
  assert.deepEqual(tool.requiredScopes, r.op['x-publikator-required-scopes']);
  assert.deepEqual(tool.securitySchemes, [{type:'oauth2',scopes:tool.requiredScopes}]);
  assert.ok(tool.inputSchema.type === 'object' && tool.inputSchema.additionalProperties === false);
  assert.ok(tool.outputSchema.type === 'object');
  assert.ok(tool.annotations && typeof tool.annotations.readOnlyHint === 'boolean');
  assert.ok(tool.annotations && typeof tool.annotations.destructiveHint === 'boolean');
  assert.ok(tool.annotations && typeof tool.annotations.openWorldHint === 'boolean');
  if (r.method === 'get') assert.equal(tool.annotations.readOnlyHint,true);
  if (['previewAgentPost','preflightAgentPost'].includes(tool.restOperationId)) {
    assert.equal(tool.annotations.readOnlyHint, true, 'preview and preflight must be pure reads');
  }
  if (r.method !== 'get') assert.ok(tool.inputSchema.required.includes('idempotencyKey'));
  walkRefs(tool.inputSchema, tool.name + ' input');
  walkRefs(tool.outputSchema, tool.name + ' output');
}
for (const [id,{op}] of catalog) if (op.tags[0]==='Agent') assert.ok(names.has(id), 'REST agent method missing MCP tool '+id);
assert.equal(mcp.notes.ownerOnlyOperationsNeverExposed, true);
assert.equal(mcp.notes.recheckEveryToolCall, true);

const cases = examples.cases || [];
assert.ok(cases.length >= 10);
const caseIds = cases.map(c=>c.id);
assert.equal(new Set(caseIds).size, cases.length);
let invalidBodyCases=0;
for (const c of cases) {
  const r = catalog.get(c.operationId);
  assert.ok(r, 'example has unrecognized operationId '+c.operationId);
  const op = r.op;
  assert.ok(op.responses[String(c.http)], c.id+' status is not declared');
  valid(op.responses[String(c.http)].content['application/json'].schema, c.response, c.id+' response');
  if (r.method !== 'get') assert.ok(c.request.idempotencyKey, c.id+' missing idempotency key');
  if (op.requestBody) {
    const body=op.requestBody.content['application/json'].schema;
    if (c.http === 400) {
      assert.throws(() => valid(body,c.request.body,c.id+' intentionally invalid request'), undefined, c.id+' should be truly invalid');
      invalidBodyCases++;
    } else {
      valid(body,c.request.body,c.id+' request');
    }
  }
  for (const p of (op.parameters||[]).filter(x=>x.in==='path')) {
    assert.ok(c.request.path?.[p.name],c.id+' missing required path field');
  }
}
assert.equal(invalidBodyCases, 1);
assert.ok(cases.some(c=>c.id==='create-image-draft'&&!c.request.body.bodyPlain), 'captionless image draft contract required');
assert.ok(cases.some(c=>c.id==='unknown-provider-outcome'), 'RECOVERY_NEEDED fixture absent');
assert.ok(cases.some(c=>c.id==='reject-unapproved-send'), 'consent denied fixture absent');
assert.ok(cases.some(c=>c.id==='reject-stale-grant'), 'grant version conflict fixture absent');

const workflow=await readFile('.github/workflows/publikator-ci.yml','utf8');
assert.match(workflow,/node scripts\/agent-contract-a0b-e2e\.mjs/);
const spec=await readFile('docs/UNIVERSAL_AGENT_API_MCP_SPEC.md','utf8');
assert.ok(spec.includes('agent-api-v1.openapi.yaml') && spec.includes('mcp-tools.v1.json'), 'normative A0 manifest missing');

console.log(JSON.stringify({
ok:true,checkpoint:'AGENT-A0b',runtime:'NOT_IMPLEMENTED',
openApiVersion:openapi.openapi,restOperations:catalog.size,agentRestOperations:agentRoutes,ownerRestOperations:ownerRoutes,
mcpTools:mcp.tools.length,syntheticExamples:cases.length,negativeExampleBodies:invalidBodyCases,
schemas:Object.keys(schemaDefs).length,contractParity:true
},null,2));
