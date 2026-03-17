import { Logger } from "./logger";

export interface RetryOptions {
  attempts: number;
  delayMs: number;
  backoffMultiplier?: number;
  onRetry?: (error: unknown, attempt: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  log?: Logger
): Promise<T> {
  const { attempts, delayMs, backoffMultiplier = 2, onRetry } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === attempts;

      if (isLastAttempt) {
        log?.error({ err, attempt }, "All retry attempts exhausted");
        break;
      }

      const delay = delayMs * Math.pow(backoffMultiplier, attempt - 1);
      log?.warn(
        { err, attempt, nextDelayMs: delay },
        `Attempt ${attempt}/${attempts} failed, retrying in ${delay}ms`
      );
      onRetry?.(err, attempt);
      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
