import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { DomainInvariantError } from '../domain/domain-error';
import { Telemetry } from '../observability/telemetry';
import { HttpResponse } from './http-response';
import { httpErrorResponse } from './http-error-response';
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly telemetry: Telemetry) {}
  catch(error: unknown, host: ArgumentsHost): void {
    const response = httpErrorResponse(error);
    if (response.status >= 500) {
      this.telemetry.log(
        'request_failed',
        {
          errorType: error instanceof Error ? error.name : 'Unknown',
          ...(error instanceof DomainInvariantError && {
            failureCode: error.code,
          }),
        },
        'error',
      );
    }
    host
      .switchToHttp()
      .getResponse<HttpResponse>()
      .status(response.status)
      .json(response.body);
  }
}
