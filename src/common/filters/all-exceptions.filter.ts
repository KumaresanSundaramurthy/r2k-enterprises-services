import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { Response } from "express";
import { notifyRequestError } from "../../libraries/telegram/notify-request-error";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      // Server-side failures are alerted on Telegram (CI3 notifyError); client errors (4xx) are not
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) notifyRequestError(host, exception);
      response.status(status).json(typeof body === "string" ? { message: body } : body);
      return;
    }

    console.error(exception);
    notifyRequestError(host, exception);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      message: exception instanceof Error ? exception.message : "Internal server error",
    });
  }
}
