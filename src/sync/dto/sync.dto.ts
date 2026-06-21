import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/** A single authoritative balance from HCM (realtime or one batch row). */
export class HcmBalanceUpdateDto {
  @ApiProperty()
  @IsString()
  employeeId!: string;

  @ApiProperty()
  @IsString()
  locationId!: string;

  @ApiProperty({ description: 'Authoritative balance (may be negative)' })
  @IsInt()
  balance!: number;

  @ApiProperty({ description: 'Monotonic version/watermark from HCM' })
  @IsInt()
  @Min(0)
  version!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  asOf?: string;
}

/** Full-corpus batch payload from HCM. */
export class HcmBatchDto {
  @ApiProperty({ type: [HcmBalanceUpdateDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HcmBalanceUpdateDto)
  balances!: HcmBalanceUpdateDto[];
}
