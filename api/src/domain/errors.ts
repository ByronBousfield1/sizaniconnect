/**
 * The single error type that crosses layer boundaries. Services throw it; the HTTP error
 * handler translates it into a status code and a JSON body. Messages are written for the
 * person at the screen: they say what happened and what to do next.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Sign in to continue.') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Your role does not allow this action.') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} was not found.`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
