import { Global, Module } from '@nestjs/common';
import { HcmCore } from './hcm-core';
import { HCM_CLIENT } from './hcm-client.interface';
import { HttpHcmClient } from './http-hcm.client';
import { InProcessHcmClient } from './in-process-hcm.client';

/**
 * Wires the HCM client. If HCM_BASE_URL is set we talk HTTP to a real HCM or
 * the standalone mock server; otherwise we run against an in-process HcmCore so
 * the service is fully runnable/demoable on its own (TRD §5.4).
 *
 * Global so any module can inject HCM_CLIENT without re-importing.
 */
@Global()
@Module({
  providers: [
    HcmCore,
    {
      provide: HCM_CLIENT,
      inject: [HcmCore],
      useFactory: (core: HcmCore) => {
        const baseUrl = process.env.HCM_BASE_URL;
        if (baseUrl) {
          return new HttpHcmClient({ baseUrl });
        }
        return new InProcessHcmClient(core);
      },
    },
  ],
  exports: [HCM_CLIENT, HcmCore],
})
export class HcmModule {}
