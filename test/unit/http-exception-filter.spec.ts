import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from '../../src/common/http-exception.filter';
import { InsufficientBalanceError } from '../../src/common/errors';

function mockHost(): { host: ArgumentsHost; sent: { status?: number; body?: unknown } } {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({}) }),
  } as unknown as ArgumentsHost;
  return { host, sent };
}

describe('HttpExceptionFilter envelope', () => {
  const filter = new HttpExceptionFilter();

  it('normalizes a domain HttpException with details', () => {
    const { host, sent } = mockHost();
    filter.catch(new InsufficientBalanceError(5, 2), host);
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({
      statusCode: 409,
      error: 'INSUFFICIENT_BALANCE',
      details: { requested: 5, available: 2 },
    });
  });

  it('handles an HttpException with a string body', () => {
    const { host, sent } = mockHost();
    filter.catch(new HttpException('plain text', HttpStatus.FORBIDDEN), host);
    expect(sent.status).toBe(403);
    expect(sent.body).toMatchObject({ statusCode: 403, message: 'plain text' });
  });

  it('handles a class-validator BadRequest (array message)', () => {
    const { host, sent } = mockHost();
    filter.catch(new BadRequestException(['days must be positive']), host);
    expect(sent.status).toBe(400);
    expect((sent.body as { message: unknown }).message).toEqual(['days must be positive']);
  });

  it('maps an unknown Error to a 500 envelope', () => {
    const { host, sent } = mockHost();
    filter.catch(new Error('kaboom'), host);
    expect(sent.status).toBe(500);
    expect(sent.body).toMatchObject({ statusCode: 500, error: 'INTERNAL_ERROR', message: 'kaboom' });
  });
});
