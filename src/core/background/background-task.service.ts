import { Injectable, Logger } from "@nestjs/common";
import { waitUntil } from "@vercel/functions";

/**
 * Work that runs after the response is sent (CI3 register_shutdown_function), e.g. Tamil translation.
 * On Vercel the function would otherwise be frozen once it answers, so the task is handed to
 * waitUntil; elsewhere it simply runs unawaited. Failures are logged, never returned to the caller.
 */
@Injectable()
export class BackgroundTaskService {
  private readonly logger = new Logger(BackgroundTaskService.name);

  run(name: string, task: () => Promise<void>): void {
    const promise = task().catch((err) => this.logger.error(`${name} failed: ${(err as Error).message}`));
    try {
      waitUntil(promise);
    } catch {
      // Not on Vercel: the promise keeps running on the long-lived server
    }
  }
}
