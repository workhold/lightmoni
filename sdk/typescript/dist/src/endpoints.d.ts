export interface CenterEndpoint {
    url: string;
    scope: "internal" | "public";
}
export interface EndpointSnapshot {
    version: number;
    center_id: string;
    revision: string;
    endpoints: CenterEndpoint[];
    refresh_after_seconds: number;
}
export declare function centerURL(value: string): string;
/** Select before sending; never replay a request body across entrances. */
export declare class CenterEndpoints {
    private headers;
    private fetcher;
    readonly bootstrap: string;
    private snapshot?;
    private expires;
    private selected;
    private selectedUntil;
    private failed;
    private loading?;
    private controller;
    lastError: string;
    constructor(bootstrap: string, headers?: () => HeadersInit, fetcher?: typeof fetch);
    status(): {
        endpoint: string;
        scope: "internal" | "public";
        revision: string;
        error: string;
    };
    close(): void;
    private json;
    refresh(parent?: AbortSignal): Promise<string>;
    resolve(parent?: AbortSignal): Promise<string>;
    private select;
    failedRequest(endpoint: string): void;
    request(path: string, init?: RequestInit): Promise<Response>;
    /** Use for existing Agent clients that construct URLs from their bootstrap. */
    fetch: typeof fetch;
}
