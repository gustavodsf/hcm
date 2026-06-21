import { Module } from '@nestjs/common';
import { HcmCore } from '../hcm/hcm-core';
import { MockHcmController } from './mock-hcm.controller';

/** Standalone mock HCM app module. Owns its OWN HcmCore (separate process). */
@Module({
  providers: [HcmCore],
  controllers: [MockHcmController],
})
export class MockHcmModule {}
