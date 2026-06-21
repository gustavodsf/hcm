import { NestFactory } from '@nestjs/core';
import { MockHcmModule } from './mock-hcm.module';

/** Boots the standalone mock HCM server (TRD §10.3). Port via MOCK_HCM_PORT. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(MockHcmModule);
  const port = Number(process.env.MOCK_HCM_PORT ?? 4000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Mock HCM listening on :${port}`);
}

void bootstrap();
