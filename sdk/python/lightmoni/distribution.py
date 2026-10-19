"""Private bounded exponential distribution used by Client.record."""
import math


class Distribution:
    def __init__(self, start):
        self.start, self.scale = start, 8
        self.positive, self.negative = {}, {}
        self.zero_count = self.count = self.bytes = 0
        self.sum, self.min, self.max = 0., float('inf'), -float('inf')

    def observe(self, value, available):
        if not math.isfinite(self.sum + value) or self.count == (1 << 64) - 1:
            return False
        if value:
            index = math.ceil(math.log2(abs(value)) * 2 ** self.scale) - 1
            while True:
                span=lambda side, extra: (max(list(side)+extra)-min(list(side)+extra)+1) if side or extra else 0
                if span(self.positive,[index] if value>0 else [])+span(self.negative,[index] if value<0 else []) <= 1024:
                    break
                for side in (self.negative, self.positive):
                    next_bins = {}
                    for key, count in side.items():
                        next_bins[key // 2] = next_bins.get(key // 2, 0) + count
                    side.clear()
                    side.update(next_bins)
                self.scale -= 1
                index //= 2
            side = self.negative if value < 0 else self.positive
            size = (len(self.negative) + len(self.positive) + (index not in side)) * 32
            if size > self.bytes + available:
                return False
            side[index] = side.get(index, 0) + 1
            self.bytes = size
        else:
            self.zero_count += 1
        self.count += 1
        self.sum += value
        self.min, self.max = min(self.min, value), max(self.max, value)
        return True

    def point(self, end, attributes):
        def buckets(side):
            if not side:
                return dict(offset=0, bucketCounts=[])
            offset, last = min(side), max(side)
            return dict(offset=offset, bucketCounts=[str(side.get(i, 0)) for i in range(offset, last + 1)])
        return dict(attributes=attributes, startTimeUnixNano=str(self.start), timeUnixNano=str(max(self.start, end)),
                    count=str(self.count), sum=self.sum, min=self.min, max=self.max, scale=self.scale,
                    zeroCount=str(self.zero_count), positive=buckets(self.positive), negative=buckets(self.negative))
