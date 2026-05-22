import { createClient } from "redis";

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
      console.error("Redis client error:", error);
    });

    redisClientPromise = client.connect().then(() => client);
  }

  return redisClientPromise;
}
