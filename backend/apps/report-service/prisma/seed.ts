import 'dotenv/config';
import { resolve } from 'path';
import { config } from 'dotenv';
config({ path: resolve(process.cwd(), '../.env.dev') });
config({ path: resolve(process.cwd(), '.env.dev') });

import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const dbUrl = process.env.DATABASE_URL_REPORTS || process.env.DATABASE_URL;
if (!dbUrl) {
  throw new Error('DATABASE_URL_REPORTS or DATABASE_URL environment variable is not set');
}

const pool = new Pool({
  connectionString: dbUrl,
});
// Set search_path so pg interacts with the correct schema
pool.on('connect', (client) => {
  client.query('SET search_path TO reports, public;');
});

const adapter = new PrismaPg(pool, { schema: 'reports' });
const prisma = new PrismaClient({ adapter });

const pointsMatrix = [
  { wasteType: 'GENERAL', basePoints: 10 },
  { wasteType: 'RECYCLABLE', basePoints: 15 },
  { wasteType: 'ORGANIC', basePoints: 12 },
  { wasteType: 'ELECTRONIC', basePoints: 25 },
  { wasteType: 'HAZARDOUS', basePoints: 50 },
  { wasteType: 'CONSTRUCTION', basePoints: 20 },
];

async function seed() {
  console.log('🌱 Seeding reward points config...');

  for (const config of pointsMatrix) {
    await prisma.rewardPointsConfig.upsert({
      where: { wasteType: config.wasteType as any },
      update: { basePoints: config.basePoints },
      create: {
        wasteType: config.wasteType as any,
        basePoints: config.basePoints,
        firstReportOfDayMultiplier: 1.0,
        underservedLgaMultiplier: 1.0,
        verifiedReporterMultiplier: 1.0,
        isActive: true,
      },
    });
    console.log(`  ✅ ${config.wasteType}: ${config.basePoints} points`);
  }

  console.log('✅ Seed complete');
  await prisma.$disconnect();
}

seed().catch((e) => {
  console.error('❌ Seed failed:', e);
  process.exit(1);
});
