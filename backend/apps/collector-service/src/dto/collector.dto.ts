import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class UpdateLocationDto {
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

  @ApiPropertyOptional({ example: 5.2 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracyMeters?: number;

  @ApiPropertyOptional({ example: 25.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  speedKmh?: number;

  @ApiPropertyOptional({ example: 180.0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(360)
  headingDegrees?: number;
}

export class UpdateAssignmentStatusDto {
  @ApiProperty({ enum: ['ON_ROUTE', 'COLLECTING', 'COMPLETED', 'CANCELLED'] })
  @IsEnum(['ON_ROUTE', 'COLLECTING', 'COMPLETED', 'CANCELLED'])
  status!: 'ON_ROUTE' | 'COLLECTING' | 'COMPLETED' | 'CANCELLED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class RateCollectorDto {
  @ApiProperty({ example: 4 })
  @IsNumber()
  @Min(1)
  @Max(5)
  @Type(() => Number)
  rating!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  comment?: string;
}
