/** A business or validation failure that Route Handlers may expose with its HTTP status. */
export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
