export type RequestErrorCode =
  | 'invalid_shape'
  | 'unknown_field'
  | 'missing_field'
  | 'invalid_literal'
  | 'invalid_integer'
  | 'integer_out_of_range'
  | 'invalid_address'
  | 'invalid_identifier'
  | 'invalid_time'
  | 'expired_request';

/** Validation errors identify a field without including its supplied value. */
export class RequestValidationError extends Error {
  readonly code: RequestErrorCode;
  readonly field: string;

  constructor(code: RequestErrorCode, field: string, message: string) {
    super(message);
    this.name = 'RequestValidationError';
    this.code = code;
    this.field = field;
  }
}
