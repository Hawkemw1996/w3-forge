export type ApiSuccess<T> = { success: true; data: T };
export type ApiList<T> = { success: true; data: T[]; meta: { count: number } };
export type ApiError = { success: false; error: { code: string; message: string; details?: string[] } };

export class AppError extends Error {
  status: number;
  code: string;
  details?: string[];
  constructor(status: number, code: string, message: string, details?: string[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 422 with the list of validation messages (shown to the user as-is). */
export class ValidationError extends AppError {
  constructor(details: string[]) {
    super(422, 'VALIDATION_FAILED', details.join(' '), details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
  }
}

/** 409: the record changed since the client loaded it (optimistic concurrency). */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
  }
}
