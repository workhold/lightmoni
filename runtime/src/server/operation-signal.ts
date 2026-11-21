/**
 * Confirmed host operations continue after the approving HTTP request or page
 * disappears. Durable rows remain the authority; this bounded signal only
 * prevents a center process from holding a dead remote session forever.
 */
export const operationSignal = (): AbortSignal => AbortSignal.timeout(15 * 60_000);
