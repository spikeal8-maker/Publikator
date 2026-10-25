// Same-tab-only recovery for unfinished composer text and choices.
// No credentials or image bytes are persisted here. Confirmed server drafts
// are tracked by ID to prevent silent duplicate creation after interruption.
const PREFIX = 'publikator.quick-composer.recovery.v1';
const TTL_MS = 24 * 60 * 60 * 1000;

export function createComposerRecovery(identity) {
  const mode = typeof identity?.mode === 'string' ? identity.mode : 'legacy';
  const username = typeof identity?.username === 'string' && identity.username
    ? identity.username : 'legacy';
  const key = PREFIX + ':' + mode + ':' + username;

  function clear() {
    try { sessionStorage.removeItem(key); } catch { /* private browser or quota */ }
  }

  function write(value) {
    try {
      sessionStorage.setItem(key, JSON.stringify({ version: 1, updatedAt: Date.now(), ...value }));
      return true;
    } catch {
      return false;
    }
  }

  function read() {
    let saved;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      saved = JSON.parse(raw);
    } catch {
      clear();
      return null;
    }
    if (!saved || saved.version !== 1 || !Number.isFinite(saved.updatedAt) ||
        !['local', 'server-draft', 'uncertain'].includes(saved.kind)) {
      clear();
      return null;
    }
    // An old local text buffer may expire, but the absence of a response from
    // a server operation NEVER becomes safe simply because 24 hours passed.
    // Retain reconciliation guards until an explicit operator decision.
    if (saved.kind === 'local' &&
        (Date.now() < saved.updatedAt || Date.now() - saved.updatedAt > TTL_MS)) {
      clear();
      return null;
    }
    return saved;
  }

  function saveLocalDraft(draft) {
    const safeAccountIds = Array.isArray(draft.accountIds)
      ? draft.accountIds.filter((value) => typeof value === 'string').slice(0, 100) : [];
    const safeAccountSet = new Set(safeAccountIds);
    const safeVariants = Array.isArray(draft.variants)
      ? draft.variants.filter((variant) =>
        variant && safeAccountSet.has(variant.accountId) &&
        (variant.text === null || typeof variant.text === 'string'))
        .slice(0, 100).map((variant) => ({
          accountId: variant.accountId,
          text: variant.text === null ? null : variant.text.slice(0, 20000)
        }))
      : [];
    return write({
      kind: 'local',
      body: String(draft.body || '').slice(0, 200000),
      projectId: String(draft.projectId || '').slice(0, 200),
      scheduledAtLocal: String(draft.scheduledAtLocal || '').slice(0, 32),
      scheduleTimezone: String(draft.scheduleTimezone || '').slice(0, 90),
      ambiguousOffset: ['earlier', 'later'].includes(draft.ambiguousOffset) ? draft.ambiguousOffset : '',
      accountIds: safeAccountIds,
      variants: safeVariants,
      photoCount: Math.max(0, Math.min(100, Number(draft.photoCount) || 0)),
      // The MP4 File/Blob itself never enters storage; after refresh the
      // operator must attach it again or explicitly waive it.
      videoRequired: Boolean(draft.videoRequired)
    });
  }

  function saveServerDraft(id) {
    return write({ kind: 'server-draft', savedId: String(id || '').slice(0, 256) });
  }

  function saveUncertain() {
    return write({ kind: 'uncertain' });
  }

  return { read, clear, saveLocalDraft, saveServerDraft, saveUncertain };
}
