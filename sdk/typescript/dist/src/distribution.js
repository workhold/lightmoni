// Internal, mergeable OTLP distribution. Business code only calls record().
export class Distribution {
    start;
    scale = 8;
    positive = new Map();
    negative = new Map();
    zeroCount = 0n;
    count = 0n;
    sum = 0;
    min = Infinity;
    max = -Infinity;
    bytes = 0;
    constructor(start) {
        this.start = start;
    }
    observe(value, available) {
        if (!Number.isFinite(value) ||
            !Number.isFinite(this.sum + value) ||
            this.count >= (1n << 64n) - 1n)
            return false;
        if (value !== 0) {
            let index = Math.ceil(Math.log2(Math.abs(value)) * 2 ** this.scale) - 1;
            const negative = value < 0;
            while (true) {
                const bins = negative ? this.negative : this.positive;
                const span = (side, extra) => { const keys = [...side.keys(), ...(extra === undefined ? [] : [extra])]; return keys.length ? Math.max(...keys) - Math.min(...keys) + 1 : 0; };
                if (span(this.positive, negative ? undefined : index) + span(this.negative, negative ? index : undefined) <= 1024)
                    break;
                for (const side of [this.positive, this.negative]) {
                    const next = new Map();
                    for (const [key, count] of side)
                        next.set(Math.floor(key / 2), (next.get(Math.floor(key / 2)) ?? 0n) + count);
                    side.clear();
                    for (const [key, count] of next)
                        side.set(key, count);
                }
                this.scale--;
                index = Math.floor(index / 2);
            }
            const bins = negative ? this.negative : this.positive;
            const nextBytes = (this.positive.size + this.negative.size + (bins.has(index) ? 0 : 1)) *
                32;
            if (nextBytes > this.bytes + available)
                return false;
            bins.set(index, (bins.get(index) ?? 0n) + 1n);
            this.bytes = nextBytes;
        }
        else
            this.zeroCount++;
        this.count++;
        this.sum += value;
        this.min = Math.min(this.min, value);
        this.max = Math.max(this.max, value);
        return true;
    }
    point(end, attributes) {
        const buckets = (bins) => {
            if (!bins.size)
                return { offset: 0, bucketCounts: [] };
            const offset = Math.min(...bins.keys()), last = Math.max(...bins.keys());
            return {
                offset,
                bucketCounts: Array.from({ length: last - offset + 1 }, (_, i) => String(bins.get(offset + i) ?? 0n)),
            };
        };
        return {
            attributes,
            startTimeUnixNano: String(this.start),
            timeUnixNano: String(end < this.start ? this.start : end),
            count: String(this.count),
            sum: this.sum,
            min: this.min,
            max: this.max,
            scale: this.scale,
            zeroCount: String(this.zeroCount),
            positive: buckets(this.positive),
            negative: buckets(this.negative),
        };
    }
}
