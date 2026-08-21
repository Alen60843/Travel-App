/** Error raised when an asynchronous operation exceeds an explicit deadline. */
export class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationTimeoutError';
  }
}

/**
 * Bounds how long a caller waits for an operation.
 *
 * This cannot cancel arbitrary promises, but it prevents health checks and
 * lifecycle hooks from waiting forever on a dependency client whose own retry
 * policy is intentionally persistent. The original promise remains observed
 * by Promise.race, so a later rejection cannot become unhandled.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new OperationTimeoutError(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
