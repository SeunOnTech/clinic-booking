export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}
