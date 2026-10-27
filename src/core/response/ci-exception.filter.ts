import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { Response } from "express";
import { CiFieldValidationError, CiValidationError, ciError } from "./ci-response";

/**
 * Turns every failure into CI3's format. Token problems keep HTTP 401 (the CI3 app handles them);
 * everything else is HTTP 200 with { Error: true, Message }, the way CI3 controllers answer AJAX calls.
 */
@Catch()
export class CiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(CiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof CiFieldValidationError) {
      res.status(HttpStatus.OK).json({ ...ciError(exception.message), FieldErrors: exception.fieldErrors });
      return;
    }

    if (exception instanceof CiValidationError) {
      res.status(HttpStatus.OK).json(ciError(exception.message));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const message = this.messageOf(exception);
      if (status === HttpStatus.UNAUTHORIZED) {
        res.status(status).json({ ...ciError(message), SessionExpired: true });
        return;
      }
      res.status(HttpStatus.OK).json(ciError(message));
      return;
    }

    // Unexpected failures are logged in full; the caller gets a safe message instead of SQL/stack details.
    this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    res.status(HttpStatus.OK).json(ciError("Something went wrong. Please try again."));
  }

  private messageOf(exception: HttpException): string {
    const body = exception.getResponse();
    if (typeof body === "string") return body;
    const message = (body as { message?: string | string[] }).message;
    return Array.isArray(message) ? message.join(", ") : message ?? exception.message;
  }
}
