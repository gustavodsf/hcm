import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateTimeOffRequestDto {
  @ApiProperty()
  @IsString()
  @MaxLength(128)
  employeeId!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(128)
  locationId!: string;

  @ApiProperty({ example: '2026-07-01', description: 'ISO date (YYYY-MM-DD)' })
  @IsISO8601()
  startDate!: string;

  @ApiProperty({ example: '2026-07-02' })
  @IsISO8601()
  endDate!: string;

  @ApiProperty({ example: 2, description: 'Number of leave days (positive integer)' })
  @IsInt()
  @IsPositive()
  days!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    description: 'If true, immediately submit for approval (places a reservation).',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  submit?: boolean;
}
