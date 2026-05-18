import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AddCommentDto {
  @ApiProperty({ example: 'Still there as of Tuesday morning, blocking the road.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000, { message: 'Comment must not exceed 1000 characters' })
  content!: string;
}

export class DeleteCommentDto {
  @ApiPropertyOptional({ example: 'Abusive content' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RepostDto {
  @ApiPropertyOptional({ example: 'This dump has been here for weeks!' })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}

export class FlagReportDto {
  @ApiProperty({ enum: ['SPAM', 'FAKE_REPORT', 'OFFENSIVE_CONTENT', 'DUPLICATE', 'OTHER'] })
  @IsEnum(['SPAM', 'FAKE_REPORT', 'OFFENSIVE_CONTENT', 'DUPLICATE', 'OTHER'])
  reason!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  details?: string;
}

export class ResolveFlagDto {
  @ApiProperty({ example: 'Content reviewed and found to be legitimate' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  resolution!: string;
}
