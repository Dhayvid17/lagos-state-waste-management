/**
 * THIS SCRIPT RUNS ONCE IN PRODUCTION. 
 * DELETE OR RESTRICT ACCESS AFTER USE.
 * 
 * Usage: cross-env BOOTSTRAP_SECRET=your_secret npx ts-node apps/auth-service/src/scripts/bootstrap-admin.ts <email> <password>
 */

import { NestFactory } from '@nestjs/core';
import { AuthModule } from '../auth.module';
import { AuthService } from '../auth.service';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../schemas/user.schema';
import { UserRole, ROLE_PERMISSIONS } from '@app/shared';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

async function bootstrap() {
  const email = process.argv[2];
  const password = process.argv[3];
  
  if (!email || !password) {
    console.error('Usage: npx ts-node bootstrap-admin.ts <email> <password>');
    process.exit(1);
  }

  const providedSecret = process.env.BOOTSTRAP_SECRET;
  if (!providedSecret) {
    console.error('BOOTSTRAP_SECRET environment variable is missing.');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AuthModule);
  const userModel = app.get<Model<UserDocument>>(getModelToken(User.name));
  const configService = app.get(ConfigService);
  const authService = app.get(AuthService);

  // Prevent accidental running if a SYS_ADMIN already exists
  const anyAdmin = await userModel.findOne({ role: UserRole.SYS_ADMIN });
  if (anyAdmin) {
    console.log('SYS_ADMIN already exists. Use the invite system to add more admins.');
    await app.close();
    process.exit(0);
  }

  const rounds = configService.get<number>('auth.security.bcryptRounds') || 10;
  const passwordHash = await bcrypt.hash(password, rounds);

  // Hash a dummy email token (AuthService requires this structure)
  // @ts-ignore - accessing private method for bootstrapping
  const emailVerificationToken = authService.hashToken(crypto.randomBytes(32).toString('hex'));
  const emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const newUser = await userModel.create({
    email: email.toLowerCase().trim(),
    passwordHash,
    role: UserRole.SYS_ADMIN,
    permissions: [...ROLE_PERMISSIONS[UserRole.SYS_ADMIN]],
    isEmailVerified: true, // admin doesn't need email verification
    emailVerificationToken,
    emailVerificationExpires,
    ndpaConsentGiven: true,
    ndpaConsentTimestamp: new Date(),
    ndpaConsentIp: '127.0.0.1',
  });

  console.log(`SYS_ADMIN created: ${newUser.email}. This script cannot be run again.`);
  
  await app.close();
  process.exit(0);
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
