import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class RedeemPointsDto {
  @ApiProperty({ example: 100 })
  @IsInt()
  @IsPositive()
  @Min(10, { message: 'Minimum redemption is 10 points' })
  pointsAmount!: number;

  @ApiProperty({
    example: 'redeem_idem_abc123',
    description: 'Client-generated unique key to prevent duplicate redemptions',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9_\-]+$/, { message: 'Invalid idempotency key format' })
  idempotencyKey!: string;
}

export class WithdrawalRequestDto {
  @ApiProperty({ example: 1000 })
  @IsNumber()
  @IsPositive()
  @Min(500, { message: 'Minimum withdrawal is ₦500' })
  @Max(500000, { message: 'Maximum withdrawal is ₦500,000' })
  @Type(() => Number)
  amountNgn!: number;

  @ApiProperty({ example: '044' })
  @IsString()
  @IsNotEmpty()
  bankCode!: string;

  @ApiProperty({ example: '0123456789' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9]{10}$/, {
    message: 'Account number must be exactly 10 digits',
  })
  accountNumber!: string;

  @ApiPropertyOptional({ enum: ['FLUTTERWAVE', 'PAYSTACK'], default: 'FLUTTERWAVE' })
  @IsOptional()
  @IsEnum(['FLUTTERWAVE', 'PAYSTACK'])
  provider?: 'FLUTTERWAVE' | 'PAYSTACK';

  @ApiProperty({
    example: 'withdrawal_idem_123',
    description: 'Unique key to prevent duplicate withdrawals',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100, { message: 'Idempotency key must not exceed 100 characters' })
  @Matches(/^[a-zA-Z0-9_\-]+$/, {
    message: 'Idempotency key may only contain letters, numbers, hyphens and underscores',
  })
  idempotencyKey!: string;
}

export class VerifyBankAccountDto {
  @ApiProperty({ example: '0123456789' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[0-9]{10}$/, {
    message: 'Account number must be exactly 10 digits',
  })
  accountNumber!: string;

  @ApiProperty({ example: '044' })
  @IsString()
  @IsNotEmpty()
  bankCode!: string;

  @ApiPropertyOptional({ enum: ['FLUTTERWAVE', 'PAYSTACK'], default: 'FLUTTERWAVE' })
  @IsOptional()
  @IsEnum(['FLUTTERWAVE', 'PAYSTACK'])
  provider?: 'FLUTTERWAVE' | 'PAYSTACK';
}
