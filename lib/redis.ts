import { createClient } from "redis";
import { recordOpsError } from "./ops-errors.js";

// Instantiate the generic so node-redis 6 keeps its concrete RESP3 reply types.
const createNoboRedisClient = (url: string) => createClient({ url });
type RedisClient = ReturnType<typeof createNoboRedisClient>;

let redisClientPromise: Promise<RedisClient> | null = null;

export async function getRedisClient() {
  const url = process.env.REDIS_URL;

  if (!url) {
    return null;
  }

  if (!redisClientPromise) {
    const client = createNoboRedisClient(url);

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
