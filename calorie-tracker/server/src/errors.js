/**
 * An error that maps straight onto an HTTP response:
 * `res.status(err.status).json({ error: err.code, message: err.message })`.
 */
export class HttpError extends Error {
  constructor(status, code, message, options) {
    super(message, options);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
