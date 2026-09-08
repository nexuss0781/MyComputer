export type ErrorCode =
  | 'not_found'
  | 'invalid_path'
  | 'already_exists'
  | 'not_empty'
  | 'unsupported'
  | 'parent_not_found'
  | 'session_not_found'
  | 'internal';

export class ComputerError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status = 400) {
    super(message);
    this.name = 'ComputerError';
    this.code = code;
    this.status = status;
  }
}

export class NotFoundError extends ComputerError {
  constructor(message = 'not found') {
    super('not_found', message, 404);
  }
}

export class PathError extends ComputerError {
  constructor(message = 'invalid path') {
    super('invalid_path', message, 400);
  }
}

export class ConflictError extends ComputerError {
  constructor(message = 'conflict') {
    super('already_exists', message, 409);
  }
}
