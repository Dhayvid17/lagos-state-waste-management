import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { LagosLGA, ReportSeverity, WasteType } from '@app/shared';
import { Type } from 'class-transformer';

// ── Only PENDING reports can be updated by citizens
// ── Only these fields are editable — status is NOT here
export class UpdateReportDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: WasteType })
  @IsOptional()
  @IsEnum(WasteType)
  wasteType?: WasteType;

  @ApiPropertyOptional({ enum: ReportSeverity })
  @IsOptional()
  @IsEnum(ReportSeverity)
  severity?: ReportSeverity;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  @Type(() => Number)
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  @Type(() => Number)
  longitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  landmark?: string;

  @ApiPropertyOptional({ enum: LagosLGA })
  @IsOptional()
  @IsEnum(LagosLGA)
  lgaId?: LagosLGA;

  @ApiPropertyOptional({ type: [String], example: ['reports/userId/2026/01/uuid.webp'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-]+\/\d{4}\/\d{2}\/[a-zA-Z0-9_\-\.]+$/, {
    each: true,
    message: 'Each mediaUrl must be a valid MinIO object key (e.g. reports/userId/2026/01/uuid.webp)',
  })
  mediaUrls?: string[];

  @ApiPropertyOptional({ example: 'reports/userId/2026/01/uuid-thumb.webp' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-]+\/\d{4}\/\d{2}\/[a-zA-Z0-9_\-\.]+$/, {
    message: 'thumbnailUrl must be a valid MinIO object key',
  })
  thumbnailUrl?: string;
}

// ── Admin status update DTO — separate from citizen update
export class UpdateReportStatusDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

// ── Cancellation request from citizen
export class CancelReportDto {
  @ApiPropertyOptional({ example: 'I submitted this report by mistake' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// ── Assignment DTO — admin assigns collector
export class AssignCollectorDto {
  @ApiPropertyOptional({ example: 'collector-auth-id-here' })
  @IsString()
  collectorAuthId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ── Completion DTO — collector marks as done
export class CompleteReportDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  collectorNote?: string;

  @ApiPropertyOptional({ type: [String], example: ['reports/userId/2026/01/before.webp'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-]+\/\d{4}\/\d{2}\/[a-zA-Z0-9_\-\.]+$/, {
    each: true,
    message: 'Each completionMediaUrl must be a valid MinIO object key',
  })
  completionMediaUrls?: string[]; // Before/after photos
}
