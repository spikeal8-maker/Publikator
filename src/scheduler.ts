import { config } from './config.js';
import { db, event, nowIso } from './db.js';
import { publishPost, publishTarget, refreshPostStatus } from './publisher.js';
import { runRetentionIfDue } from './retention.js';
import { maintenanceState } from './runtime-gate.js';

type ZonedParts = {
  weekday: number;
  hhmm: string;
  date: string;
  minuteOfDay: number;
};

type QueueOccurrence = {
  kind: 'before' | 'window' | 'expired' | 'outside';
  occurrenceDate: string | null;
  delayMinutes: number | null;
};

function zonedParts(timeZone: string, at: Date): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(at).map((part) => [part.type, part.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    weekday: weekdays[parts.weekday!]!,
    hhmm: `${parts.hour}:${parts.minute}`,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: hour * 60 + minute
  };
}

function hhmmMinutes(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`Некорректное время schedule slot: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function previousDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function queueOccurrence(parts: ZonedParts, slotWeekday: number, slotTime: string): QueueOccurrence {
  const slotMinute = hhmmMinutes(slotTime);
  const grace = config.queueSlotGraceMinutes;

  if (parts.weekday === slotWeekday) {
    if (parts.minuteOfDay < slotMinute) return { kind: 'before', occurrenceDate: parts.date, delayMinutes: null };
    const delayMinutes = parts.minuteOfDay - slotMinute;
    return {
      kind: delayMinutes <= grace ? 'window' : 'expired',
      occurrenceDate: parts.date,
      delayMinutes
    };
  }

  const nextWeekday = (slotWeekday + 1) % 7;
  const overflowMinutes = slotMinute + grace - 1440;
  if (overflowMinutes >= 0 && parts.weekday === nextWeekday) {
    const occurrenceDate = previousDate(parts.date);
    const delayMinutes = 1440 - slotMinute + parts.minuteOfDay;
    return {
      kind: delayMinutes <= grace ? 'window' : 'expired',
      occurrenceDate,
      delayMinutes
    };
  }

  return { kind: 'outside', occurrenceDate: null, delayMinutes: null };
}

let running = false;
let lastStartedAt: string | null = null;
let lastCompletedAt: string | null = null;
let lastDurationMs: number | null = null;
let lastError: string | null = null;
let lastSkippedAt: string | null = null;
let lastSkippedReason: 'already-running' | 'maintenance' | null = null;
let lastWork = { duePosts: 0, queuePosts: 0, retries: 0 };

export function schedulerStatus(): {
  running: boolean;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastSkippedAt: string | null;
  lastSkippedReason: 'already-running' | 'maintenance' | null;
  lastWork: { duePosts: number; queuePosts: number; retries: number };
} {
  return {
    running,
    lastStartedAt,
    lastCompletedAt,
    lastDurationMs,
    lastError,
    lastSkippedAt,
    lastSkippedReason,
    lastWork: { ...lastWork }
  };
}

async function safePublishPost(postId: string, source: string): Promise<boolean> {
  try {
    await publishPost(postId);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = db.prepare("UPDATE posts SET status='FAILED', updated_at=? WHERE id=? AND status='READY'")
      .run(nowIso(), postId);
    event({
      postId,
      level: 'error',
      type: 'scheduler_publish_blocked',
      message,
      data: { source, movedToFailed: failed.changes > 0 }
    });
    return false;
  }
}

export async function schedulerTick(at: Date = new Date()): Promise<void> {
  if (running) {
    lastSkippedAt = nowIso();
    lastSkippedReason = 'already-running';
    return;
  }
  if (maintenanceState().active) {
    lastSkippedAt = nowIso();
    lastSkippedReason = 'maintenance';
    return;
  }

  running = true;
  lastStartedAt = nowIso();
  lastError = null;
  lastSkippedReason = null;
  const started = Date.now();
  const work = { duePosts: 0, queuePosts: 0, retries: 0 };
  const schedulerNow = at.toISOString();

  try {
    await runRetentionIfDue();
    if (maintenanceState().active) return;
    const due = db.prepare("SELECT id FROM posts WHERE status='READY' AND schedule_mode='AT' AND scheduled_at IS NOT NULL AND scheduled_at<=? ORDER BY scheduled_at LIMIT 10")
      .all(schedulerNow) as Array<{ id: string }>;
    for (const post of due) {
      if (maintenanceState().active) break;
      work.duePosts += 1;
      await safePublishPost(post.id, 'AT');
    }

    if (maintenanceState().active) return;
    const slots = db.prepare('SELECT * FROM schedule_slots WHERE enabled=1 ORDER BY time_hhmm').all() as any[];
    for (const slot of slots) {
      if (maintenanceState().active) break;
      let parts: ZonedParts;
      let occurrence: QueueOccurrence;
      try {
        parts = zonedParts(slot.timezone, at);
        occurrence = queueOccurrence(parts, Number(slot.weekday), String(slot.time_hhmm));
      } catch (error) {
        event({
          level: 'error',
          type: 'queue_slot_invalid',
          message: error instanceof Error ? error.message : String(error),
          data: { slotId: slot.id, timezone: slot.timezone, time: slot.time_hhmm }
        });
        continue;
      }

      if (!occurrence.occurrenceDate || slot.last_fired_on === occurrence.occurrenceDate) continue;
      if (occurrence.kind === 'before' || occurrence.kind === 'outside') continue;

      if (occurrence.kind === 'expired') {
        db.prepare('UPDATE schedule_slots SET last_fired_on=? WHERE id=?').run(occurrence.occurrenceDate, slot.id);
        event({
          level: 'warning',
          type: 'queue_slot_missed',
          message: `Слот ${slot.time_hhmm} ${slot.timezone} пропущен: окно ${config.queueSlotGraceMinutes} мин завершилось без публикации`,
          data: {
            slotId: slot.id,
            projectId: slot.project_id,
            occurrenceDate: occurrence.occurrenceDate,
            delayMinutes: occurrence.delayMinutes,
            graceMinutes: config.queueSlotGraceMinutes
          }
        });
        continue;
      }

      const post = db.prepare("SELECT id FROM posts WHERE project_id=? AND status='READY' AND schedule_mode='QUEUE' ORDER BY created_at LIMIT 1")
        .get(slot.project_id) as { id: string } | undefined;
      if (!post) continue;

      db.prepare('UPDATE schedule_slots SET last_fired_on=? WHERE id=?').run(occurrence.occurrenceDate, slot.id);
      work.queuePosts += 1;
      event({
        postId: post.id,
        type: 'queue_slot_fired',
        message: `Сработал слот ${slot.time_hhmm} ${slot.timezone}${occurrence.delayMinutes ? ` с задержкой ${occurrence.delayMinutes} мин` : ''}`,
        data: {
          slotId: slot.id,
          occurrenceDate: occurrence.occurrenceDate,
          delayMinutes: occurrence.delayMinutes,
          graceMinutes: config.queueSlotGraceMinutes
        }
      });
      await safePublishPost(post.id, 'QUEUE');
    }

    if (maintenanceState().active) return;
    const retries = db.prepare("SELECT pt.id, pt.post_id FROM post_targets pt JOIN social_accounts a ON a.id=pt.account_id WHERE pt.state='RETRY' AND pt.enabled=1 AND a.enabled=1 AND pt.next_attempt_at IS NOT NULL AND pt.next_attempt_at<=? ORDER BY pt.next_attempt_at LIMIT 20")
      .all(schedulerNow) as Array<{ id: string; post_id: string }>;
    for (const target of retries) {
      if (maintenanceState().active) break;
      try {
        work.retries += 1;
        await publishTarget(target.id);
        refreshPostStatus(target.post_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        event({ postId: target.post_id, level: 'error', type: 'scheduler_retry_blocked', message, data: { targetId: target.id } });
      }
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    lastWork = work;
    lastCompletedAt = nowIso();
    lastDurationMs = Date.now() - started;
    running = false;
  }
}
