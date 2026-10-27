/** A domain has positively rejected an operation before changing the live target,
 * or has verified its compensation. Never use this class to mask an OS/transport
 * error after a mutation may have begun: that outcome needs an unknown receipt.
 */
export class OperationRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationRejectedError";
  }
}
