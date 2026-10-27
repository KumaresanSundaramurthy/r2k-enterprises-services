// CI3's response envelope ($this->EndReturnData): { Error, Message?, ...payload }.
export type CiResponse<T extends object = object> = { Error: boolean; Message?: string } & T;

export function ciSuccess<T extends object>(payload: T, message?: string): CiResponse<T> {
  return { Error: false, ...(message ? { Message: message } : {}), ...payload };
}

export function ciError(message: string): CiResponse {
  return { Error: true, Message: message };
}

// CI3's ValidationException: a business-rule failure whose message is shown to the user as-is.
export class CiValidationError extends Error {}

// Form validation failure: CI3 answers { Error, Message: 'Please correct the highlighted errors.', FieldErrors }.
export class CiFieldValidationError extends Error {
  constructor(readonly fieldErrors: Record<string, string>) {
    super("Please correct the highlighted errors.");
  }
}
