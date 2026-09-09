import { db, event, nowIso } from './db.js';
import { publishPost, publishTarget, refreshPostStatus } from './publisher.js';
import { maintenanceState } from './runtime-gate.js';

function zonedParts(timeZone: string): { weekday: number; hhmm: string; date: string } {
  const date = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: weekdays[parts.weekday!]!,
    hhmm: `${parts.hour}:${parts.minute}`,
    date: `${parts.year}-${parts.month}-${parts.day}`
  };
}

let running = false;

async function safePublishPost(postId: string, source: string): Promise<void> {
  try {
    await publishPost(postId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    event({ postId, level: 'error', type: 'scheduler_publish_blocked', message, data: { source } });
  }
}

export async function schedulerTick(): Promise<void> {
  if (running || maintenanceState().active) return;
  running = true;
  try {
    if (maintenanceState().active) return;
    const due = db.prepare("SELECT id FROM posts WHERE status='READY' AND schedule_mode='AT' AND scheduled_at IS NOT NULL AND scheduled_at<=? ORDER BY scheduled_at LIMIT 10")
      .all(nowIso()) as Array<{ id: string }>;
    for (const post of due) {
      if (maintenanceState().active) break;
      await safePublishPost(post.id, 'AT');
    }

    if (maintenanceState().active) return;
    const slots = db.prepare('SELECT * FROM schedule_slots WHERE enabled=1 ORDER BY time_hhmm').all() as any[];
    for (const slot of slots) {
      if (maintenanceState().active) break;
      let parts: ReturnType<typeof zonedParts>;
      try { parts = zonedParts(slot.timezone); } catch { continue; }
      if (parts.weekday !== slot.weekday || parts.hhmm !== slot.time_hhmm || slot.last_fired_on === parts.date) continue;
      db.prepare('UPDATE schedule_slots SET last_fired_on=? WHERE id=?').run(parts.date, slot.id);
      const post = db.prepare("SELECT id FROM posts WHERE project_id=? AND status='READY' AND schedule_mode='QUEUE' ORDER BY created_at LIMIT 1")
        .get(slot.project_id) as { id: string } | undefined;
      if (post) {
        event({ postId: post.id, type: 'queue_slot_fired', message: `Сработал слот ${slot.time_hhmm} ${slot.timezone}` });
        await safePublishPost(post.id, 'QUEUE');
      }
    }

    if (maintenanceState().active) return;
    const retries = db.prepare("SELECT pt.id, pt.post_id FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id WHERE pt.state='RETRY' AND pt.enabled=1 AND a.enabled=1 AND pt.next_attempt_at IS NOT NULL AND pt.next_attempt_at<=? ORDER BY pt.next_attempt_at LIMIT 20")
      .all(nowIso()) as Array<{ id: string; post_id: string }>;
    for (const target of retries) {
      if (maintenanceState().active) break;
      try {
        await publishTarget(target.id);
        refreshPostStatus(target.post_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        event({ postId: target.post_id, level: 'error', type: 'scheduler_retry_blocked', message, data: { targetId: target.id } });
      }
    }
  } finally {
    running = false;
  }
}
