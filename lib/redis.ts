import { createClient } from "redis";
import { recordOpsError } from "./ops-errors.js";

type RedisClient = ReturnType<typeof createClient>;

let redisClientPromise: Promise<RedisClient> | null = null;

export async function getRedisClient() {
  const url = process.env.REDIS_URL;

  if (!url) {
    return null;
  }

  if (!redisClientPromise) {
    const client = createClient({ url });

    client.on("error", (error) => {
      recordOpsError("redis client", error);
      console.error("Redis client error:", error);
    });

    redisClientPromise = client.connect().then(() => client).catch((error) => {
      redisClientPromise = null;
      recordOpsError("redis connect", error);
      throw error;
    });
  }

  return redisClientPromise;
}
