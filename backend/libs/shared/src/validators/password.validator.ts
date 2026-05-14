import { IsString, MaxLength, MinLength, Matches } from 'class-validator';
import { applyDecorators } from '@nestjs/common';

/**
 * Shared password strength validator for all password-setting flows.
 *
 * Apply to any DTO field that accepts a password (register, reset, change).
 * Enforces NIST 800-63B minimum requirements for government platforms.
 *
 * Rules:
 *  - Minimum 8 characters
 *  - Maximum 128 characters
 *  - Must contain uppercase, lowercase, digit, and special character
 */
export const StrongPassword = () =>
  applyDecorators(
    IsString(),
    MinLength(8, { message: 'Password must be at least 8 characters' }),
    MaxLength(128, { message: 'Password must not exceed 128 characters' }),
    Matches(/(?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?=.*\W)/, {
      message: 'Password must contain uppercase, lowercase, number, and special character',
    }),
  );
