import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { BalanceService } from './balance.service';

/** Read-only balance views (TRD §8.1). */
@ApiTags('balances')
@Controller('v1/balances')
export class BalancesController {
  constructor(private readonly balances: BalanceService) {}

  @Get()
  @ApiOperation({ summary: 'Derived available balance for an employee at a location' })
  @ApiQuery({ name: 'employeeId', required: true })
  @ApiQuery({ name: 'locationId', required: true })
  @ApiOkResponse({ description: 'Balance view with hcmBalance, reserved, committedPending, available' })
  async getOne(@Query('employeeId') employeeId: string, @Query('locationId') locationId: string) {
    if (!employeeId || !locationId) {
      throw new BadRequestException('employeeId and locationId are required');
    }
    return this.balances.getView(employeeId, locationId);
  }

  @Get(':employeeId')
  @ApiOperation({ summary: 'All location balances for an employee' })
  async getForEmployee(@Param('employeeId') employeeId: string) {
    return { employeeId, balances: await this.balances.getViewsForEmployee(employeeId) };
  }
}
