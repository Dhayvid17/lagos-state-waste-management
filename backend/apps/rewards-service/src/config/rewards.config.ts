import { registerAs } from '@nestjs/config';

export default registerAs('rewards', () => ({
  postgres: {
    url: process.env.DATABASE_URL_REWARDS ?? process.env.DATABASE_URL,
  },
  nats: {
    url: process.env.NATS_URL ?? 'nats://localhost:4222',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
  cache: {
    leaderboardTtlSeconds: 300, // 5 minutes
    badgesTtlSeconds: 600, // 10 minutes
    streakTtlSeconds: 3600, // 1 hour
  },
  streaks: {
    dailyReportStreakBonusPoints: 5, // Bonus per day in streak
    maxStreakBonusPoints: 50, // Cap daily streak bonus
    streakResetHours: 36, // Miss 36 hours = streak broken
  },
  badges: {
    // Report count thresholds
    firstReportThreshold: 1,
    activeReporterThreshold: 10,
    wasteWarriorThreshold: 50,
    lagosChampionThreshold: 100,
    eliteReporterThreshold: 500,

    // Points thresholds
    pointsCollectorThreshold: 100,
    pointsHunterThreshold: 500,
    pointsMasterThreshold: 2000,
  },
}));
