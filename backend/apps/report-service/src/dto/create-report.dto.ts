import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsArray,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LagosLGA, ReportSeverity, WasteType } from '@app/shared';
import { Type } from 'class-transformer';

export class CreateReportDto {
  @ApiProperty({ example: 'Large illegal dump near market' })
  @IsString()
  @IsNotEmpty()
  @MinLength(10, { message: 'Title must be at least 10 characters' })
  @MaxLength(200)
  title!: string;

  @ApiProperty({
    example:
      'There is a massive pile of construction waste blocking the drainage canal near Balogun market',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(20, { message: 'Description must be at least 20 characters' })
  @MaxLength(2000)
  description!: string;

  @ApiProperty({ enum: WasteType })
  @IsEnum(WasteType)
  @IsNotEmpty()
  wasteType!: WasteType;

  @ApiPropertyOptional({ enum: ReportSeverity, default: ReportSeverity.LOW })
  @IsOptional()
  @IsEnum(ReportSeverity)
  severity?: ReportSeverity;

  @ApiProperty({ example: 6.5244 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  @Type(() => Number)
  latitude!: number;

  @ApiProperty({ example: 3.3792 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  @Type(() => Number)
  longitude!: number;

  @ApiPropertyOptional({ example: '14 Balogun Street, Lagos Island' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({ example: 'Near Shoprite Ikeja' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  landmark?: string;

  @ApiProperty({ enum: LagosLGA })
  @IsEnum(LagosLGA)
  @IsNotEmpty()
  lgaId!: LagosLGA;

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
