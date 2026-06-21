import { Body, Controller, Get, HttpCode, HttpException, Param, Post } from '@nestjs/common';
import { HcmCore, HcmRejection, HcmUnavailable } from '../hcm/hcm-core';

/**
 * HTTP surface of the standalone mock HCM (TRD §10.3). Translates HcmCore
 * outcomes to HTTP: rejections → 422 {code}, transient → 503, success → 200.
 * The /control/* endpoints let tests and live demos inject faults and simulate
 * independent HCM changes (anniversary bonus, HR edits, annual refresh).
 */
@Controller()
export class MockHcmController {
  constructor(private readonly core: HcmCore) {}

  // ---- Realtime API --------------------------------------------------------

  @Get('balances/:employeeId/:locationId')
  async getBalance(@Param('employeeId') employeeId: string, @Param('locationId') locationId: string) {
    return this.guard(() => this.core.getBalance(employeeId, locationId));
  }

  @Post('apply')
  @HttpCode(200)
  async apply(
    @Body()
    body: {
      employeeId: string;
      locationId: string;
      amount: number;
      type: 'DEBIT' | 'CREDIT';
      idempotencyKey: string;
    },
  ) {
    return this.guard(() => this.core.applyDelta(body));
  }

  @Get('corpus')
  corpus() {
    return { balances: this.core.dumpCorpus() };
  }

  // ---- Control surface (test/ops) -----------------------------------------

  @Post('control/reset')
  @HttpCode(200)
  reset() {
    this.core.reset();
    return { ok: true };
  }

  @Post('control/faults')
  @HttpCode(200)
  faults(@Body() body: Record<string, unknown>) {
    this.core.configureFaults(body);
    return { ok: true };
  }

  @Post('control/seed')
  @HttpCode(200)
  seed(@Body() body: { employeeId: string; locationId: string; balance: number }) {
    return this.core.seed(body.employeeId, body.locationId, body.balance);
  }

  @Post('control/adjust')
  @HttpCode(200)
  adjust(@Body() body: { employeeId: string; locationId: string; delta: number }) {
    return this.guard(() => this.core.adjust(body.employeeId, body.locationId, body.delta));
  }

  /** Push the whole corpus to an ExampleHR instance's batch endpoint (live demo). */
  @Post('control/emit-batch')
  @HttpCode(200)
  async emitBatch(@Body() body: { targetUrl: string }) {
    const res = await fetch(body.targetUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ balances: this.core.dumpCorpus() }),
    });
    return { ok: res.ok, status: res.status };
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof HcmRejection) {
        throw new HttpException({ code: err.code, message: err.message }, 422);
      }
      if (err instanceof HcmUnavailable) {
        throw new HttpException({ code: 'UNAVAILABLE', message: err.message }, 503);
      }
      throw err;
    }
  }
}
