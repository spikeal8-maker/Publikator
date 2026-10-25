import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const data = async path => readFile(path,'utf8').then(JSON.parse);
const [routing, fault, openapi, mcp, a0a, activity] = await Promise.all([
 data('docs/contracts/agent-route-boundaries.v1.json'),
 data('docs/contracts/agent-fault-matrix.v1.json'),
 data('docs/contracts/agent-api-v1.openapi.yaml'),
 data('docs/contracts/mcp-tools.v1.json'),
 data('docs/contracts/agent-access-presets.v1.json'),
 data('docs/contracts/agent-activity.v1.schema.json')
]);
const [auth, media, claim, clients, plan, workflow, normative] = await Promise.all([
 readFile('docs/ADR_AGENT_AUTH_AND_ROUTING.md','utf8'),
 readFile('docs/ADR_AGENT_MEDIA_PUBLICATION.md','utf8'),
 readFile('docs/ADR_AGENT_CLAIM_AND_QUOTA.md','utf8'),
 readFile('docs/contracts/client-compatibility-matrix.md','utf8'),
 readFile('docs/contracts/agent-fault-matrix.md','utf8'),
 readFile('.github/workflows/publikator-ci.yml','utf8'),
 readFile('docs/UNIVERSAL_AGENT_API_MCP_SPEC.md','utf8')
]);
const unique=(xs,description)=>assert.equal(new Set(xs).size,xs.length,description+' must be unique');
assert.equal(routing.schemaVersion,1);
assert.equal(routing.contractId,'publikator.agent-route-boundaries');
assert.equal(routing.status,'PLANNED_NOT_DEPLOYED');
assert.equal(routing.classify,'EXACT_THEN_LONGEST_PATH_SEGMENT_PREFIX');
assert.equal(routing.unmatched,'DENY');
assert.equal(routing.ambiguousCookieBearer,'REJECT');
assert.equal(routing.ownerCookieForMcp,false);
assert.equal(routing.agentBearerForOwner,false);
const classes=routing.classes;
assert.ok(classes.length>=9);
unique(classes.map(c=>c.id),'route class ids');
unique(classes.flatMap(c=>c.paths),'route paths');
const classById=Object.fromEntries(classes.map(c=>[c.id,c]));
for(const id of ['PUBLIC_EXISTING','OAUTH_METADATA','MCP','OAUTH_FLOW','LEGACY_INTEGRATION','AGENT','OWNER_AGENT','BROWSER_EXISTING','PUBLIC_MEDIA_LEGACY']) assert.ok(classById[id],id+' missing');
assert.equal(classById.AGENT.auth,'OAUTH_OR_SCOPED_MACHINE_BEARER');
assert.equal(classById.MCP.auth,'RESOURCE_BOUND_OAUTH');
assert.equal(classById.OWNER_AGENT.auth,'OWNER_COOKIE_ONLY');
assert.equal(classById.LEGACY_INTEGRATION.auth,'EXISTING_HASHED_PK');
assert.equal(classById.PUBLIC_MEDIA_LEGACY.policy,'MIGRATION_REQUIRED_BEFORE_NEW_AGENT_ASSETS');
assert.equal(classById.OAUTH_METADATA.policy,'GET_ONLY_NO_SECRETS');
assert.ok(!routing.neverTrust.includes('owner-signed policy'));
function routeClass(path, method='GET') {
  // This is the PLANNED router manifest, not a substitute for Fastify runtime tests.
  // Reject disguised/slash-encoded paths first; runtime must use canonical URL parsing.
  if (!path.startsWith('/') || /%(?:2f|5c|2e|00)/i.test(path) || path.includes('..') || path.includes('//') || path.includes('\\')) return 'DENY';
  const pathname=path.split('?')[0];
  const byMethod=c=>c.methods.includes('EXISTING')||c.methods.includes(method);
  const exact=classes.find(c=>c.mode==='exact' && c.paths.includes(pathname));
  if(exact)return byMethod(exact)?exact.id:'DENY';
  const prefixes=classes.flatMap(c=>c.mode==='prefix'?c.paths.filter(p=>pathname.startsWith(p)).map(p=>({c,p})):[]);
  prefixes.sort((a,b)=>b.p.length-a.p.length);
  if(prefixes.length)return byMethod(prefixes[0].c)?prefixes[0].c.id:'DENY';
  return 'DENY';
}
const matches=[
['GET','/api/health','PUBLIC_EXISTING'],
['POST','/api/auth/login','PUBLIC_EXISTING'],
['GET','/api/integration/v1/drafts','LEGACY_INTEGRATION'],
['GET','/api/agent/v1/posts','AGENT'],
['POST','/api/agent/v1/posts','AGENT'],
['POST','/api/owner/agents/agent_001/grant','OWNER_AGENT'],
['GET','/api/owner/agents?authKind=agent','OWNER_AGENT'],
['POST','/mcp','MCP'],
['GET','/mcp','DENY'],
['GET','/.well-known/oauth-protected-resource','OAUTH_METADATA'],
['POST','/.well-known/oauth-protected-resource','DENY'],
['GET','/oauth/authorize','OAUTH_FLOW'],
['GET','/public-media/existing.jpg','PUBLIC_MEDIA_LEGACY'],
['GET','/api/dashboard','BROWSER_EXISTING'],
['GET','/api/agent/v1/posts%2F..%2Fowner','DENY'],
['POST','/api/agent/v1/../../api/owner/agents','DENY'],
['GET','/api/owner/private//other','DENY'],
['GET','/unknown','DENY']
];
for(const [method,path,expected] of matches)assert.equal(routeClass(path,method),expected,method+' '+path);
assert.ok(routing.negativeCases.length>=10);
assert.equal(routing.modernMcp.version,'2026-07-28');
assert.equal(routing.modernMcp.transport,'POST_STREAMABLE_HTTP');
assert.equal(routing.modernMcp.versionNegotiation,'EXPLICIT_SDK_V2_OPT_IN');
assert.equal(routing.modernMcp.legacyInitializeRequired,false);
assert.equal(routing.modernMcp.sessionRequired,false);
for(const h of ['MCP-Protocol-Version','Mcp-Method'])assert.ok(routing.modernMcp.requiresHeaders.includes(h));
assert.equal(routing.modernMcp.requiresNameHeader,'Mcp-Name');
assert.deepEqual(routing.modernMcp.scopeCacheKey,['agentId','grantVersion','protocolVersion']);
assert.equal(routing.oauth.candidate,'oidc-provider');
assert.equal(routing.oauth.major,9);
assert.equal(routing.oauth.state,'NOT_VERIFIED');
assert.equal(routing.oauth.liveProbeRequired,true);
assert.equal(routing.oauth.pkceMethod,'S256');
assert.equal(routing.oauth.externalOrigin,'NOT_CONFIGURED');
assert.equal(routing.oauth.resourceParameterRequired,true);
assert.equal(routing.oauth.returnIssRequired,true);

// The API/MCP catalog must never expose Owner cookie operations as tools.
assert.equal(openapi['x-publikator-contract-status'],'PLANNED_NOT_IMPLEMENTED');
assert.equal(mcp.status,'PLANNED_NOT_DEPLOYED');
assert.equal(openapi.components.securitySchemes.ownerSession.in,'cookie');
const mcpIds=new Set(mcp.tools.map(t=>t.restOperationId));
assert.ok(mcp.tools.length>=22);
for(const tool of mcp.tools){
  assert.ok(tool.name.startsWith('publikator_'));
  assert.equal(tool.securitySchemes[0].type,'oauth2');
  assert.ok(Array.isArray(tool.securitySchemes[0].scopes));
  assert.ok(tool.annotations && typeof tool.annotations.readOnlyHint==='boolean');
  assert.equal(tool.restPath.startsWith('/api/owner/'),false,'owner route leaked as MCP tool');
}
const known=new Set(a0a.scopes.map(s=>s.id));
for(const t of mcp.tools)assert.ok(t.requiredScopes.every(s=>known.has(s)),t.name+' unexpected scopes');
assert.equal(activity.properties.agentId.type,'string');
assert.ok(normative.includes('P0 Safety Convergence Gate'));

// Deterministic failure-injection matrix completeness, not runtime exercise.
assert.equal(fault.contractId,'publikator.agent-fault-matrix');
assert.equal(fault.status,'DESIGN_NOT_IMPLEMENTED');
assert.ok(fault.scenarios.length>=14);
unique(fault.scenarios.map(f=>f.id),'failpoint IDs');
for(const f of fault.scenarios){
 assert.match(f.id,/^F\d\d_[A-Z_]+$/);
 assert.ok(f.cutPoint && f.injection && f.expectedProviderCalls && f.expectedState && f.recovery);
 assert.ok(f.gate && /^G-\d\d$/.test(f.gate));
 assert.equal(f.p0,true);
 assert.equal(f.assertNoBlindRetry,true);
 assert.deepEqual(f.proof,['sqlite_snapshot','activity_events','fake_provider_request_log','canonical_media_checksums','no_new_unapproved_send_after_restart']);
}
for(const id of ['F03_DURING_MEDIA_WRITE','F07_PROVIDER_ACCEPTED_RESPONSE_LOST','F08_PROVIDER_RETURNED_BEFORE_DB_COMMIT','F09_BETWEEN_TWO_TARGETS','F10_REVOKE_BEFORE_CLAIM','F11_REVOKE_AFTER_CLAIM','F12_QUOTA_AT_LOCAL_DAY_BOUNDARY','F14_BACKUP_RESTORE_AGENT_STATE']) assert.ok(fault.scenarios.find(x=>x.id===id),id+' missing');
for(const id of ['F07_PROVIDER_ACCEPTED_RESPONSE_LOST','F08_PROVIDER_RETURNED_BEFORE_DB_COMMIT']) {
  const f=fault.scenarios.find(x=>x.id===id);
  assert.equal(f.expectedProviderCalls,'1');
  assert.ok(/RECOVERY_NEEDED/.test(f.expectedState));
}
assert.equal(fault.failpointRules.unknownOutcomeNeverAutomaticallyResends,true);
assert.equal(fault.failpointRules.neverUseRealProviderCredentialsInCI,true);
assert.equal(fault.failpointRules.requiresBackupRestore,true);

// Product & threat document pointers.
for(const x of ['oidc-provider','PKCE','CIMD','resource','issuer','/api/agent/v1','/api/owner','/mcp','BLOCKED_BY_LIVE_PROOF']) assert.ok(auth.includes(x),'auth ADR missing '+x);
for(const x of ['/public-media/','ensureTargets()','private','MEDIA-06','TARGET-03']) assert.ok(media.includes(x),'media ADR missing '+x);
for(const x of ['PublicationIntent','grantVersion','RECOVERY_NEEDED','quota','CLAIM-12']) assert.ok(claim.includes(x),'claim ADR missing '+x);
assert.ok(clients.includes('NOT_VERIFIED') && clients.includes('ChatGPT') && clients.includes('MCP Inspector') && clients.includes('Codex'));
assert.ok(clients.includes('CLIENT_CONNECTED') && clients.includes('WRITE_VERIFIED'));
assert.ok(!clients.includes('ChatGPT MCP подключён успешно'));
// Matrix is not an unearned promise about running clients.
const clientRows=clients.split('\n').filter(line=>line.startsWith('| ') && /\bNOT_VERIFIED\b/.test(line));
assert.ok(clientRows.length>=10,'10 client modes must be explicitly unverified');
assert.ok(plan.includes('F07_PROVIDER_ACCEPTED_RESPONSE_LOST')===false || plan.includes('RECOVERY_NEEDED'));
assert.ok(plan.includes('deterministic') && plan.includes('backup') && plan.includes('SQLite'));
assert.match(workflow,/node scripts\/agent-contract-a0c-e2e\.mjs/);
assert.match(workflow,/node scripts\/agent-contract-a0b-e2e\.mjs/);
assert.ok(!openapi.paths['/mcp'],'MCP endpoint must not be mislabeled as implemented REST route');
console.log(JSON.stringify({
  ok:true,checkpoint:'AGENT-A0c',state:'DESIGN_ONLY_NOT_IMPLEMENTED',
  routeClasses:classes.length,routeMatrixCases:matches.length,
  negativeRoutes:routing.negativeCases.length,faultScenarios:fault.scenarios.length,
  clientRowsUnverified:clientRows.length,mcpToolCount:mcp.tools.length,
  oauthCandidate:routing.oauth.candidate,
  productionIngress:'NOT_CONFIGURED',
  acceptance:'STATIC_CONTRACT_PASS_NOT_RUNTIME_PROOF'
},null,2));
