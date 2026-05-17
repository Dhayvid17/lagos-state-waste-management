import { IsOptional, IsString, MaxLength } from 'class-validator';

export class DeletePostDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
