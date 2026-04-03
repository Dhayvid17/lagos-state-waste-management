import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@app/shared';

// ── This DTO is used INTERNALLY by the NATS event handler
// ── Never exposed as a public API endpoint
export class CreateProfileDto {
  @ApiProperty({ example: '677f1a2b3c4d5e6f7a8b9c0d' })
  @IsString()
  @IsNotEmpty()
  authId!: string;

  @ApiProperty({ example: 'john.doe@gmail.com' })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiPropertyOptional({ enum: UserRole, default: UserRole.CITIZEN })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ example: '+2348012345678' })
  @IsOptional()
  @IsString()
  @Matches(/^\+234[0-9]{10}$/, {
    message: 'Phone must be a valid Nigerian number: +234XXXXXXXXXX',
  })
  phoneNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  timestamp?: string;
}
