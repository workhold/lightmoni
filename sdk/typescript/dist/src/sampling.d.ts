export interface LogCondition {
    field: string;
    operator: 'in' | 'exists';
    values?: (string | boolean | number | bigint)[];
}
export interface LogExcludeRule {
    name: string;
    conditions: LogCondition[];
}
export interface LogRule extends LogExcludeRule {
    rate: number;
}
export interface LogSamplingPolicy {
    key?: string;
    rules: LogRule[];
    exclude?: LogExcludeRule[];
}
export interface SDKConfig {
    revision: string;
    log_sampling: Record<string, LogSamplingPolicy>;
    disable_rules?: LogExcludeRule[];
}
export interface SamplingRecord {
    record: Record<string, unknown>;
    attributes: Record<string, unknown>;
    resource: Record<string, unknown>;
}
export declare function copyExclusions(rules: LogExcludeRule[], sdk?: boolean): LogExcludeRule[];
export declare function copyLogSampling(p: LogSamplingPolicy): LogSamplingPolicy;
export declare function matches(conditions: LogCondition[], log: SamplingRecord): boolean;
export declare function sampleLog(p: LogSamplingPolicy, table: string, log: SamplingRecord): {
    keep: boolean;
    rate: number;
    reason: string;
};
