import { randomUUID } from "node:crypto";

type SchedulerRedis = {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

// Keep in-flight work in its existing due set, scored at lease expiry. A dead
// worker therefore needs no separate recovery scan or record migration.
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 30_000;

const CLAIM = `-- scheduler-lease:claim
  local now = redis.call('TIME')
  local ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
  local due = redis.call('ZSCORE', KEYS[2], ARGV[1])
  if not due or tonumber(due) > ms then return false end
  local record = redis.call('GET', KEYS[1])
  if not record then
    redis.call('ZREM', KEYS[2], ARGV[1])
    return false
  end
  if not redis.call('SET', KEYS[3], ARGV[2], 'NX', 'PX', ARGV[3]) then return false end
  redis.call('ZADD', KEYS[2], ms + tonumber(ARGV[3]), ARGV[1])
  return record`;

const CHECK = `-- scheduler-lease:check
  if redis.call('GET', KEYS[3]) ~= ARGV[2] then return 0 end
  if redis.call('GET', KEYS[1]) ~= ARGV[3] then return 0 end
  if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
  return 1`;

const RENEW = `-- scheduler-lease:renew
  if redis.call('GET', KEYS[3]) ~= ARGV[2] then return 0 end
  if redis.call('GET', KEYS[1]) ~= ARGV[3] then return 0 end
  if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
  local now = redis.call('TIME')
  local ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
  redis.call('PEXPIRE', KEYS[3], ARGV[4])
  redis.call('ZADD', KEYS[2], ms + tonumber(ARGV[4]), ARGV[1])
  return 1`;

const FINISH = `-- scheduler-lease:finish
  if redis.call('GET', KEYS[3]) ~= ARGV[2] then return 0 end
  if redis.call('GET', KEYS[1]) ~= ARGV[3] then
    redis.call('DEL', KEYS[3])
    return 0
  end
  if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then
    redis.call('DEL', KEYS[3])
    return 0
  end
  if ARGV[4] == '' then
    redis.call('DEL', KEYS[1])
    redis.call('ZREM', KEYS[2], ARGV[1])
    for i = 4, #KEYS do redis.call('SREM', KEYS[i], ARGV[1]) end
  else
    redis.call('SET', KEYS[1], ARGV[4])
    redis.call('ZADD', KEYS[2], ARGV[5], ARGV[1])
  end
  redis.call('DEL', KEYS[3])
  return 1`;

export async function claimScheduledJob(
  redis: SchedulerRedis,
  job: { id: string; recordKey: string; dueKey: string },
  timing = { leaseMs: LEASE_MS, heartbeatMs: HEARTBEAT_MS }
) {
  const token = randomUUID();
  const keys = [job.recordKey, job.dueKey, `${job.recordKey}:lease`];
  const payload = await redis.eval(CLAIM, {
    keys,
    arguments: [job.id, token, String(timing.leaseMs)]
  });
  if (typeof payload !== "string") return null;

  let lost = false;
  let renewing = false;
  const args = [job.id, token, payload];
  const heartbeat = setInterval(() => {
    if (lost || renewing) return;
    renewing = true;
    void redis.eval(RENEW, { keys, arguments: [...args, String(timing.leaseMs)] })
      .then((result) => { if (result !== 1) lost = true; })
      // A failed renewal is uncertain ownership: fail closed before delivery.
      .catch(() => { lost = true; })
      .finally(() => { renewing = false; });
  }, timing.heartbeatMs);
  heartbeat.unref();

  return {
    payload,
    stop() { clearInterval(heartbeat); },
    async assertCurrent() {
      if (lost || await redis.eval(CHECK, { keys, arguments: args }) !== 1) {
        lost = true;
        throw new Error("Scheduled job lease lost or record changed.");
      }
    },
    // Compare the exact stored bytes, preserving legacy records and ensuring
    // cancellation/edits beat both successful completion and error retries.
    async finish(after: string | null, nextRunAt = 0, indexKeys: string[] = []) {
      clearInterval(heartbeat);
      if (lost) return false;
      return await redis.eval(FINISH, {
        keys: [...keys, ...indexKeys],
        arguments: [...args, after ?? "", String(nextRunAt)]
      }) === 1;
    }
  };
}
