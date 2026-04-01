import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
// Service for managing a blocklist of revoked JWTs using Redis
export class TokenBlocklistService {
  private readonly redis: Redis;
  private readonly logger = new Logger(TokenBlocklistService.name);

  // ── Initialize Redis client with config from environment variables
  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis({
      host: this.configService.get<string>('auth.redis.host'),
      port: this.configService.get<number>('auth.redis.port'),
      password: this.configService.get<string>('auth.redis.password'),
      // ── Retry strategy — don't spam errors forever
      retryStrategy: (times) => {
        if (times > 3) {
          this.logger.error('Redis max retries reached. Blocklist unavailable.');
          return null; // Stop retrying
        }
        return Math.min(times * 1000, 3000); // Wait 1s, 2s, 3s between retries
      },
      lazyConnect: true, // ← Don't connect until first command
    });

    //─ Log Redis connection status
    this.redis.on('connect', () => this.logger.log('Redis connected — token blocklist ready'));

    this.redis.on('error', (err) => this.logger.error('Redis error:', err.message));
  }

  // ── Add token to blocklist with TTL matching token expiry
  async blockToken(token: string, expiresInSeconds: number): Promise<void> {
    try {
      const key = `blocklist:${token}`;
      await this.redis.set(key, '1', 'EX', expiresInSeconds);
      this.logger.log(`Token blacklisted for ${expiresInSeconds}s`);
    } catch (err) {
      // Don't crash the app if Redis is down — just log it
      this.logger.error('Failed to blocklist token:', (err as Error).message);
    }
  }

  // ── Check if token is blocked
  async isBlocked(token: string): Promise<boolean> {
    try {
      const key = `blocklist:${token}`;
      const result = await this.redis.get(key);
      return result !== null;
    } catch (err) {
      // If Redis is down, fail open (allow the request) — better than blocking everyone
      this.logger.error('Failed to check blocklist:', (err as Error).message);
      return false;
    }
  }
}
