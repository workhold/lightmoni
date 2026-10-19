export declare const metricPeriods: number[];
export type MetricWindows = Record<string, {
    seconds: number;
    effective_at: number;
}[]>;
export declare function copyMetricWindows(input: unknown): MetricWindows;
export declare function metricWindow(policies: MetricWindows, table: string, now: bigint): {
    seconds: number;
    start: bigint;
};
