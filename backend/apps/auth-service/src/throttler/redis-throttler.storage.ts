import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis-backed ThrottlerStorage implementation.
 * Replaces the default in-memory store so rate-limit counters
 * survive service restarts and are shared across all instances.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly redis: Redis;
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly config: ConfigService) {
    this.redis = new Redis({
      host: config.get<string>('auth.redis.host'),
      port: config.get<number>('auth.redis.port'),
      password: config.get<string>('auth.redis.password'),
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 1000, 3000);
      },
      lazyConnect: true,
    });

    this.redis.on('connect', () => this.logger.log('ThrottlerStorage: Redis connected'));
    this.redis.on('error', (err) => this.logger.error('ThrottlerStorage: Redis error', err.message));

    // Explicitly connect to resolve lazyConnect latency on the first incoming request
    this.redis.connect().catch((err) => 
      this.logger.error('ThrottlerStorage: Failed to connect to Redis', err.message)
    );
  }

  async increment(key: string, ttl: number): Promise<{ totalHits: number; timeToExpire: number; isBlocked: boolean; timeToBlockExpire: number }> {
    const redisKey = `throttle:${key}`;

    const pipeline = this.redis.pipeline();
    pipeline.incr(redisKey);
    pipeline.pttl(redisKey);

    const results = await pipeline.exec();
    const totalHits = (results?.[0]?.[1] as number) ?? 1;
    let pttlValue = (results?.[1]?.[1] as number) ?? -1;

    // Set TTL only on the first increment (when the key is brand new)
    // NX flag ensures atomic operation, preventing race conditions if concurrent requests see pttlValue === -1
    if (pttlValue === -1) {
      await this.redis.call('PEXPIRE', redisKey, ttl, 'NX');
      pttlValue = ttl;
    }

    return {
      totalHits,
      timeToExpire: Math.ceil(pttlValue / 1000),
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}
