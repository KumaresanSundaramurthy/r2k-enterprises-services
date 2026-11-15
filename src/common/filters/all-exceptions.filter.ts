import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { Response } from "express";
import { notifyRequestError, notifyRequestValidation } from "../../libraries/telegram/notify-request-error";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      // Server-side failures are always alerted on Telegram (CI3 notifyError); 4xx only when
      // TELEGRAM_NOTIFY_LEVEL=all, and never 401 (expired / missing tokens are routine)
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) notifyRequestError(host, exception);
      else if (status !== HttpStatus.UNAUTHORIZED) {
        const message = typeof body === "string" ? body : (body as { message?: string | string[] }).message;
        notifyRequestValidation(host, Array.isArray(message) ? message.join(", ") : String(message ?? exception.message));
      }
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
