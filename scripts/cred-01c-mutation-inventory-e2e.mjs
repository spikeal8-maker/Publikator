import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.join(process.cwd(), 'src');
const files = [];
async function walk(directory) {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) await walk(full);
    else if (item.isFile() && item.name.endsWith('.ts')) files.push(full);
  }
}
await walk(root);

const read = async name => fs.readFile(path.join(root, name), 'utf8');
const [routes, oauth, service, capability, inspector] = await Promise.all([
  read('http/routes.ts'),
  read('http/vk-oauth.ts'),
  read('social-account-credentials.ts'),
  read('social-credential-capability.ts'),
  read('platforms/credential-inspection.ts')
]);

const mutationModules = new Set([
  'social-account-credentials.ts',
  'social-credential-capability.ts',
  'db.ts',
  'schema.ts'
]);
const directInsert = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO)\s+social_accounts\b/i;
const directCredentialUpdate =
  /\bUPDATE\s+social_accounts\s+SET[^\x60\x27\x22;]{0,500}\bcredentials_encrypted\s*=/i;

let checked = 0;
for (const file of files) {
  const relative = path.relative(root, file).replaceAll(path.sep, '/');
  if (mutationModules.has(relative) || relative.startsWith('migrations/')) continue;
  const content = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(content, directInsert,
    `Unauthorized account creation SQL outside credential owner: ${relative}`);
  assert.doesNotMatch(content, directCredentialUpdate,
    `Unauthorized credential replacement SQL outside canonical owner: ${relative}`);
  checked += 1;
}
assert.match(routes, /saveAndCheckSocialAccount\(/);
assert.match(routes, /saveUncheckedVkAccount\(/);
assert.match(routes, /activatePendingVkAccount\(/);
assert.match(routes, /recheckSocialAccount\(/);
assert.match(routes, /isVerifiedAccountPublishReady\(/);
assert.match(routes, /replaceSocialAccountCredentials\(/);
assert.match(oauth, /saveAndCheckSocialAccount\(/);
assert.match(oauth, /replaceAndCheckSocialAccount\(/);
assert.doesNotMatch(routes, /persistVkCommunityProfile\(/,
  'Legacy alternate profile authority must not survive');
assert.match(service, /function verifiedPublisherCredentials\(/);
assert.match(service, /replaceSocialAccountCredentials\(/);
assert.match(capability, /export function replaceSocialAccountCredentials\(/);
assert.match(inspector, /export async function inspectSocialCredential\(/);
assert.doesNotMatch(inspector, /vkCall\s*\(\s*['"]wall\.post['"]/,
  'Credential inspection must not create a public VK artifact');

console.log(JSON.stringify({
  ok: true,
  checkpoint: 'CRED-01C-MUTATION-INVENTORY',
  inspectedRuntimeModules: checked,
  allHttpCredentialWritesUseOwner: true,
  legacyAlternateInspectorRemoved: true,
  noVkWallPostDuringInspection: true
}));
