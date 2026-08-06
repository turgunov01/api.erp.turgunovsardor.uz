// Typed application errors -> consistent HTTP responses.
export class AppError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const BadRequest = (msg: string, code = 'BAD_REQUEST') => new AppError(400, code, msg);
export const Unauthorized = (msg = 'Unauthorized', code = 'UNAUTHORIZED') => new AppError(401, code, msg);
export const Forbidden = (msg = 'Forbidden', code = 'FORBIDDEN') => new AppError(403, code, msg);
export const NotFound = (msg = 'Not found', code = 'NOT_FOUND') => new AppError(404, code, msg);
export const Conflict = (msg: string, code = 'CONFLICT') => new AppError(409, code, msg);
export const PaymentRequired = (msg: string, code = 'SUBSCRIPTION_INACTIVE') => new AppError(402, code, msg);
