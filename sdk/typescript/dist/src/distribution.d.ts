export declare class Distribution {
    readonly start: bigint;
    scale: number;
    positive: Map<number, bigint>;
    negative: Map<number, bigint>;
    zeroCount: bigint;
    count: bigint;
    sum: number;
    min: number;
    max: number;
    bytes: number;
    constructor(start: bigint);
    observe(value: number, available: number): boolean;
    point(end: bigint, attributes: unknown[]): {
        attributes: unknown[];
        startTimeUnixNano: string;
        timeUnixNano: string;
        count: string;
        sum: number;
        min: number;
        max: number;
        scale: number;
        zeroCount: string;
        positive: {
            offset: number;
            bucketCounts: string[];
        };
        negative: {
            offset: number;
            bucketCounts: string[];
        };
    };
}
