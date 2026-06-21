import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateTimeOffRequestDto } from './dto/create-time-off-request.dto';
import { ListTimeOffRequestDto } from './dto/list-time-off-request.dto';
import { TimeOffService } from './time-off.service';

/** Time-off request lifecycle endpoints (TRD §8.2). */
@ApiTags('time-off-requests')
@Controller('v1/time-off-requests')
export class TimeOffController {
  constructor(private readonly service: TimeOffService) {}

  @Post()
  @ApiOperation({ summary: 'Create a request (optionally submit immediately)' })
  create(
    @Body() dto: CreateTimeOffRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.create(dto, idempotencyKey);
  }

  @Get()
  @ApiOperation({ summary: 'List/filter requests' })
  list(@Query() query: ListTimeOffRequestDto) {
    return this.service.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch a single request' })
  get(@Param('id') id: string) {
    return this.service.getOrThrow(id);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit a DRAFT for approval (places a reservation)' })
  submit(@Param('id') id: string) {
    return this.service.submit(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve; enqueues the HCM debit' })
  approve(@Param('id') id: string) {
    return this.service.approve(id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject; releases the reservation' })
  reject(@Param('id') id: string) {
    return this.service.reject(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel (pre- or post-commit, with compensation)' })
  cancel(@Param('id') id: string) {
    return this.service.cancel(id);
  }
}
