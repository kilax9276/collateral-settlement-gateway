export type ErrorResponse = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function formatErrorResponse(
  code: string,
  message: string,
  details?: unknown,
): ErrorResponse {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const notFound = (code: string, message: string, details?: unknown) =>
  new AppError(404, code, message, details);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
export const unauthorized = (
  code: string,
  message: string,
  details?: unknown,
) => new AppError(401, code, message, details);
export const forbidden = (code: string, message: string, details?: unknown) =>
  new AppError(403, code, message, details);
