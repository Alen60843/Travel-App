import { AppError } from '../common/errors/app-error';

export class ExplorerQueryInvalidError extends AppError {
  constructor(message: string, field?: string) {
    super('EXPLORER_QUERY_INVALID', message, 422, field ? { field } : undefined);
  }
}

export class ExplorerQueryTooBroadError extends AppError {
  constructor() {
    super(
      'EXPLORER_QUERY_TOO_BROAD',
      'This area contains too many events. Narrow the area, time window, or category filter.',
      422,
    );
  }
}
