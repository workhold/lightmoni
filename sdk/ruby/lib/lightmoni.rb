require 'json'
require 'net/http'
require 'securerandom'
require 'time'
require 'monitor'
require 'timeout'

module LightMoni
  MAX_INT = (1 << 63) - 1
  def self.nano; Process.clock_gettime(Process::CLOCK_REALTIME, :nanosecond); end
  def self.json(value); JSON.generate(value); end
  def self.table(value)
    raise ArgumentError, 'invalid logical table' unless value.is_a?(String) && /\A[a-z][a-z0-9_]{0,47}\z/.match?(value) && !/\A(log|metric|trace)_/.match?(value)
    value
  end
  def self.attrs(values)
    raise ArgumentError, 'attribute count exceeded' if values.size > 32
    result = values.sort_by { |k, _| k.to_s }.map do |key, value|
      raise ArgumentError, 'invalid attribute key' unless key.is_a?(String) && !key.empty? && key.bytesize <= 128
      encoded = case value
                when String then { 'stringValue' => value.dup.freeze }
                when true, false then { 'boolValue' => value }
                when Integer
                  raise ArgumentError, 'integer outside Int64' unless value.between?(-(1 << 63), MAX_INT)
                  { 'intValue' => value.to_s }
                when Float
                  raise ArgumentError, 'nonfinite attribute' unless value.finite?
                  { 'doubleValue' => value }
                else raise ArgumentError, 'attributes require string/bool/Int64/finite float'
                end
      { 'key' => key.dup.freeze, 'value' => encoded }
    end
    raise ArgumentError, 'attribute bytes exceeded' if json(result).bytesize > 4096
    result
  end
  class TraceContext
    attr_reader :trace_id, :span_id, :flags, :trace_state
    def initialize(trace_id, span_id, flags = 1, trace_state = '')
      raise ArgumentError, 'invalid trace context' unless /\A[0-9a-f]{32}\z/.match?(trace_id) && trace_id.to_i(16) != 0 && /\A[0-9a-f]{16}\z/.match?(span_id) && span_id.to_i(16) != 0 && flags.between?(0, 255) && trace_state.bytesize <= 512
      @trace_id, @span_id, @flags, @trace_state = trace_id.dup.freeze, span_id.dup.freeze, flags, trace_state.dup.freeze
      freeze
    end
    def inject
      h = { 'traceparent' => format('00-%s-%s-%02x', trace_id, span_id, flags) }
      h['tracestate'] = trace_state unless trace_state.empty?
      h
    end
    def self.extract(headers)
      h = headers.transform_keys(&:downcase); m = /\A00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})\z/.match(h['traceparent'].to_s)
      return nil unless m
      new(m[1], m[2], m[3].to_i(16), h.fetch('tracestate', ''))
    rescue ArgumentError
      nil
    end
  end
  class State
    attr_accessor :key, :closed, :failure, :sequence, :self_enabled, :self_table, :heartbeat_stop
    attr_reader :gate, :delivery, :limits, :metrics, :records, :queue, :stats, :endpoint
    def initialize(service, endpoint, key, limits)
      @endpoint = URI(endpoint)
      raise ArgumentError, 'valid service and HTTP(S) endpoint required' if service.empty? || service.bytesize > 128 || !%w[http https].include?(@endpoint.scheme) || !@endpoint.host || @endpoint.userinfo || @endpoint.query || @endpoint.fragment
      @limits = { queue_bytes: 8 << 20, queue_batches: 256, buffer_bytes: 8 << 20, max_batch_bytes: 1 << 20, cardinality_limit: 2000, max_instruments: 256 }
      raise ArgumentError, 'unknown SDK limit' unless (limits.keys - @limits.keys).empty?
      @limits.merge!(limits)
      raise ArgumentError, 'invalid SDK limits' unless @limits.values.all? { |n| n.is_a?(Integer) && n > 0 } && @limits[:max_batch_bytes] <= @limits[:queue_bytes]
      @key, @closed, @failure, @sequence = key, false, nil, 0
      @gate, @delivery = Monitor.new, Mutex.new
      @metrics, @records, @queue = {}, {}, []
      @stats = %w[pending_batches pending_bytes buffer_bytes delivered_batches retried_batches invalid_records overflow_records dropped_records rejected_records].to_h { |n| [n, 0] }
      @stats['last_error'] = ''
      @self_enabled, @self_table, @self_last, @self_started, @self_previous = true, '', -Float::INFINITY, false, {}
      @resource = { 'attributes' => LightMoni.attrs('service.name' => service, 'service.instance.id' => SecureRandom.uuid) }
    end
    def invalid(message); @stats['invalid_records'] += 1; @stats['last_error'] = message; end
    def lost(count, message); @stats['dropped_records'] += count; @failure = @stats['last_error'] = message; end
    def reserve(n)
      if @stats['buffer_bytes'] + n > @limits[:buffer_bytes]; lost(1, 'SDK active buffer exceeded'); return false; end
      @stats['buffer_bytes'] += n; true
    end
    def store(table, signal, record)
      @gate.synchronize do
        if @closed; invalid('record after shutdown')
        elsif reserve(LightMoni.json(record).bytesize + 64); (@records[[table, signal]] ||= []) << record
        end
      end
    end
    def payload(signal, rows)
      if signal == 'metrics'
        merged = {}
        rows.each do |row|
          kind = %w[sum gauge histogram].find { |k| row.key?(k) }
          if merged.key?(row['name'])
            merged[row['name']][kind]['dataPoints'].concat(row[kind]['dataPoints'])
          else
            merged[row['name']] = row.merge(kind => row[kind].merge('dataPoints' => row[kind]['dataPoints'].dup))
          end
        end
        rows = merged.values
      end
      resource, scope, field = { 'metrics' => %w[resourceMetrics scopeMetrics metrics], 'logs' => %w[resourceLogs scopeLogs logRecords], 'traces' => %w[resourceSpans scopeSpans spans] }.fetch(signal)
      LightMoni.json(resource => [{ 'resource' => @resource, scope => [{ 'scope' => { 'name' => 'lightmoni/sdk/ruby', 'version' => '0.1.0' }, field => rows }] }])
    end
    def collect
      now = LightMoni.nano
      @metrics.each_value do |m|
        finish = [now, m.start].max
        m.series.each_value do |p|
          point = { 'attributes' => p[:attrs], 'timeUnixNano' => (m.kind == 'gauge' ? p[:at] : finish).to_s }
          row = { 'name' => m.name, 'unit' => m.unit }
          case m.kind
          when 'counter'
            point.merge!('startTimeUnixNano' => m.start.to_s, 'asInt' => p[:value].to_s)
            row['sum'] = { 'dataPoints' => [point], 'aggregationTemporality' => 1, 'isMonotonic' => true }
          when 'gauge'
            point['asDouble'] = p[:value]; row['gauge'] = { 'dataPoints' => [point] }
          else
            point.merge!('startTimeUnixNano' => m.start.to_s, 'count' => p[:count].to_s, 'sum' => p[:value], 'explicitBounds' => m.bounds, 'bucketCounts' => p[:buckets].map(&:to_s), 'min' => p[:min], 'max' => p[:max])
            row['histogram'] = { 'dataPoints' => [point], 'aggregationTemporality' => 1 }
          end
          (@records[[m.table, 'metrics']] ||= []) << row
        end
        m.series.clear; m.start = finish
      end
      at = Time.now.utc.iso8601(9)
      @records.sort.each do |(table, signal), rows|
        group = []; base = payload(signal, []).bytesize; size = base
        rows.each do |row|
          cost = LightMoni.json(row).bytesize + 1
          if !group.empty? && size + cost > @limits[:max_batch_bytes]; enqueue(table, signal, group, at); group = []; size = base; end
          group << row; size += cost
        end
        enqueue(table, signal, group, at) unless group.empty?
      end
      @records.clear; @stats['buffer_bytes'] = 0
      collect_self
    end
    def enqueue_self(signal, rows, at)
      size = payload(signal, rows).bytesize
      return false if size > @limits[:max_batch_bytes] || @queue.size >= @limits[:queue_batches] || @stats['pending_bytes'] + size > @limits[:queue_bytes]
      enqueue(@self_table, signal, rows, at); true
    end
    def collect_self
      now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      return if !@self_enabled || now - @self_last < 30
      @self_last = now
      at, time = Time.now.utc.iso8601(9), LightMoni.nano.to_s
      attributes = LightMoni.attrs('lightmoni.component' => 'sdk', 'sdk.language' => 'ruby', 'sdk.version' => '0.1.0')
      values = { 'heartbeat' => 1 }.merge(@stats.select { |name,_| %w[pending_batches pending_bytes retried_batches dropped_records rejected_records invalid_records overflow_records].include?(name) })
      rows = values.map { |name,value| { 'name' => 'lightmoni.sdk.' + name, 'gauge' => { 'dataPoints' => [{ 'timeUnixNano' => time, 'asDouble' => value, 'attributes' => attributes }] } } }
      enqueue_self('metrics', rows, at)
      changed = %w[retried_batches dropped_records rejected_records invalid_records overflow_records].any? { |name| @stats[name] > @self_previous.fetch(name,0) }
      if !@self_started || changed
        event = @self_started ? 'diagnostics_changed' : 'started'
        row = { 'timeUnixNano' => time, 'severityText' => changed ? 'WARN' : 'INFO', 'severityNumber' => changed ? 13 : 9, 'body' => { 'stringValue' => changed ? 'LightMoni SDK delivery, buffer or input diagnostics changed' : 'LightMoni SDK started' }, 'attributes' => attributes + LightMoni.attrs('event' => event) }
        if enqueue_self('logs', [row], at); @self_started = true; @self_previous = @stats.dup; end
      end
    end
    def enqueue(table, signal, rows, at)
      raw = payload(signal, rows).freeze; @sequence += 1
      if raw.bytesize > @limits[:max_batch_bytes] || @queue.size >= @limits[:queue_batches] || @stats['pending_bytes'] + raw.bytesize > @limits[:queue_bytes]; lost(rows.size, 'SDK queue or batch capacity exceeded'); return; end
      @queue << [@sequence, SecureRandom.uuid, at, table, signal, raw, rows.size].freeze
      @stats['pending_batches'] += 1; @stats['pending_bytes'] += raw.bytesize
    end
  end
  class Metric
    attr_reader :table, :name, :kind, :unit, :bounds, :series
    attr_accessor :start
    def initialize(s, table, name, kind, unit, bounds)
      @s, @table, @name, @kind, @unit, @bounds, @series, @start = s, table, name, kind, unit, bounds, {}, LightMoni.nano
    end
    def add(value = 1, attributes = {})
      raise ArgumentError, 'add requires counter' unless @kind == 'counter'
      record(value, attributes)
    end
    def record(value, attributes = {})
      @s.gate.synchronize do
        begin
          raise ArgumentError, 'metric after shutdown' if @s.closed
          valid = @kind == 'counter' ? value.is_a?(Integer) && value.between?(0, MAX_INT) : (value.is_a?(Integer) || value.is_a?(Float)) && value.finite?
          raise ArgumentError, 'invalid metric value' unless valid
          attrs = LightMoni.attrs(attributes); key = LightMoni.json(attrs)
          if !@series.key?(key) && @series.size >= @s.limits[:cardinality_limit]
            key = 'overflow'; attrs = LightMoni.attrs('otel.metric.overflow' => true); @s.stats['overflow_records'] += 1
          end
          p = @series[key]
          unless p
            return unless @s.reserve(key.bytesize + 160 + 8 * (@bounds.size + 1))
            p = @series[key] = { attrs: attrs, value: 0, count: 0, buckets: [0] * (@bounds.size + 1), min: value, max: value, at: 0 }
          end
          case @kind
          when 'counter'
            raise ArgumentError, 'counter overflow' if p[:value] + value > MAX_INT
            p[:value] += value
          when 'gauge' then p[:value] = value.to_f
          else
            raise ArgumentError, 'histogram overflow' unless (p[:value] + value).finite? && p[:count] < MAX_INT
            p[:value] += value.to_f; p[:count] += 1; p[:buckets][@bounds.index { |b| value <= b } || @bounds.size] += 1
            p[:min], p[:max] = [p[:min], value].min, [p[:max], value].max
          end
          p[:at] = LightMoni.nano
        rescue ArgumentError, TypeError => e
          @s.invalid(e.message)
        end
      end
    end
  end
  class Span
    attr_reader :context
    def initialize(client, name, attrs, parent)
      raise ArgumentError, 'invalid span name' if name.empty? || name.bytesize > 255
      @client, @ended = client, false
      @context = TraceContext.new(parent ? parent.trace_id : SecureRandom.hex(16), SecureRandom.hex(8), parent ? parent.flags : 1, parent ? parent.trace_state : '')
      @data = { 'name' => name.dup, 'kind' => 1, 'traceId' => @context.trace_id, 'spanId' => @context.span_id, 'flags' => @context.flags, 'startTimeUnixNano' => LightMoni.nano.to_s, 'attributes' => LightMoni.attrs(attrs) }
      if parent
        @data['parentSpanId'] = parent.span_id; @data['traceState'] = parent.trace_state unless parent.trace_state.empty?
      end
    end
    def set_error(message); @client.state.gate.synchronize { @data['status'] = { 'code' => 2, 'message' => message.to_s[0, 4096] } unless @ended }; end
    def finish
      @client.state.gate.synchronize do
        return if @ended
        @ended = true; @data['endTimeUnixNano'] = [LightMoni.nano, @data['startTimeUnixNano'].to_i].max.to_s
        @client.state.store(@client.table, 'traces', @data)
      end
    end
  end
  class Client
    attr_reader :state, :table
    def initialize(service:, table:, endpoint: 'http://127.0.0.1:4318', key: '', self_telemetry: true, **limits)
      @table, @state = LightMoni.table(table).dup.freeze, State.new(service, endpoint, key, limits)
      @state.self_enabled, @state.self_table = self_telemetry, @table
      @state.heartbeat_stop = Queue.new
      if self_telemetry
        root, stop = self, @state.heartbeat_stop
        Thread.new do
          loop do
            begin
              Timeout.timeout(30) { stop.pop }; break
            rescue Timeout::Error
              begin; root.flush(timeout: 5); rescue StandardError; end
            end
          end
        end
      end
    end
    def with_table(table)
      child = self.class.allocate
      child.instance_variable_set(:@table, LightMoni.table(table).dup.freeze); child.instance_variable_set(:@state, @state); child
    end
    def counter(name, unit: ''); instrument(name, 'counter', unit, []); end
    def gauge(name, unit: ''); instrument(name, 'gauge', unit, []); end
    def histogram(name, unit: '', boundaries: [5, 10, 25, 50, 100, 250, 500, 1000]); instrument(name, 'histogram', unit, boundaries); end
    def instrument(name, kind, unit, bounds)
      raise ArgumentError, 'invalid histogram boundaries' unless bounds.all? { |n| n.is_a?(Integer) || n.is_a?(Float) }
      bounds = bounds.map(&:to_f).freeze
      raise ArgumentError, 'invalid metric identity/boundaries' if name.empty? || name.bytesize > 255 || unit.bytesize > 64 || bounds.size > 128 || bounds.any? { |n| !n.finite? } || bounds.each_cons(2).any? { |a, b| a >= b }
      @state.gate.synchronize do
        raise 'SDK is closed' if @state.closed
        id = [@table, name.dup.freeze]; m = @state.metrics[id]
        if m; raise ArgumentError, 'conflicting metric registration' unless [m.kind, m.unit, m.bounds] == [kind, unit, bounds]; return m; end
        raise ArgumentError, 'instrument limit exceeded' if @state.metrics.size >= @state.limits[:max_instruments]
        @state.metrics[id] = Metric.new(@state, @table, name.dup.freeze, kind, unit.dup.freeze, bounds)
      end
    end
    def log(severity, body, attributes = {}, context: nil)
      @state.gate.synchronize do
        begin
          level = severity.downcase; i = %w[trace debug info warn error fatal].index(level)
          raise ArgumentError, 'invalid log severity/body' unless i && body.is_a?(String) && body.bytesize <= 65536
          now = LightMoni.nano.to_s
          row = { 'timeUnixNano' => now, 'observedTimeUnixNano' => now, 'severityText' => level, 'severityNumber' => 1 + 4 * i, 'body' => { 'stringValue' => body.dup }, 'attributes' => LightMoni.attrs(attributes) }
          row.merge!('traceId' => context.trace_id, 'spanId' => context.span_id, 'flags' => context.flags) if context
          @state.store(@table, 'logs', row)
        rescue ArgumentError, TypeError => e
          @state.invalid(e.message)
        end
      end
    end
    def start_span(name, attributes = {}, parent: nil)
      @state.gate.synchronize { raise 'SDK is closed' if @state.closed; Span.new(self, name, attributes, parent) }
    end
    def stats; @state.gate.synchronize { @state.stats.dup }; end
    def update_key(key); @state.gate.synchronize { @state.key = key.dup }; end
    def flush(timeout: 10)
      raise ArgumentError, 'timeout must be positive' unless timeout.is_a?(Numeric) && timeout.finite? && timeout > 0
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
      until @state.delivery.try_lock
        raise Timeout::Error, 'flush deadline exceeded' if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
        sleep 0.001
      end
      begin
          target = @state.gate.synchronize { raise 'SDK is closed' if @state.closed; @state.collect; @state.sequence }
          backoff = 0.2
          loop do
            item, key = @state.gate.synchronize { [@state.queue.first, @state.key] }
            if !item || item[0] > target; raise @state.failure if @state.failure; return; end
            remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
            raise Timeout::Error, 'flush deadline exceeded; batches retained' if remaining <= 0
            _, id, created, table, signal, raw, count = item
            status, delay, rejected, ack = 0, 0, 0, false
            begin
              uri = @state.endpoint.dup; uri.path = uri.path.sub(%r{/+$}, '') + '/v1/' + signal
              request = Net::HTTP::Post.new(uri)
              request['Content-Type'] = 'application/json'; request['X-Lightmoni-Table'] = table; request['X-Lightmoni-Batch-ID'] = id; request['X-Lightmoni-Batch-Created-At'] = created
              request['Authorization'] = 'Bearer ' + key unless key.empty?
              request.body = raw
              http = Net::HTTP.new(uri.host, uri.port, nil); http.use_ssl = uri.scheme == 'https'
              http.open_timeout = http.read_timeout = [remaining, 10].min; http.max_retries = 0
              Timeout.timeout([remaining, 10].min) do
                http.start do |session|
                session.request(request) do |response|
                  status = response.code.to_i; retry_after = response['Retry-After'].to_s
                  begin; delay = /\A\d+\z/.match?(retry_after) ? retry_after.to_i : [Time.httpdate(retry_after) - Time.now, 0].max; rescue ArgumentError; end
                  body = ''; response.read_body { |part| raise IOError, 'ACK too large' if body.bytesize + part.bytesize > 65536; body << part }
                  if status == 200
                    result = JSON.parse(body.empty? ? '{}' : body); raise IOError, 'invalid acknowledgment' unless result.is_a?(Hash)
                    field = { 'logs' => 'rejectedLogRecords', 'metrics' => 'rejectedDataPoints', 'traces' => 'rejectedSpans' }[signal]
                    partial = result['partialSuccess'] || {}
                    raise IOError, 'invalid partial success' unless partial.is_a?(Hash)
                    rejected = Integer(partial.fetch(field, 0)); raise IOError, 'invalid partial success' if rejected < 0
                    ack = true
                  end
                end
              end
              end
            rescue IOError, SystemCallError, SocketError, OpenSSL::SSL::SSLError, Timeout::Error, Net::HTTPError, JSON::ParserError, ArgumentError, TypeError
              status = 0
            end
            @state.gate.synchronize do
              if ack || ![0, 401, 403, 429, 502, 503, 504].include?(status)
                @state.queue.shift; @state.stats['pending_batches'] -= 1; @state.stats['pending_bytes'] -= raw.bytesize
                if ack && rejected == 0; @state.stats['delivered_batches'] += 1
                else
                  @state.stats['rejected_records'] += rejected > 0 ? rejected : count
                  @state.failure = @state.stats['last_error'] = ack ? 'OTLP partial success; not retried' : "telemetry rejected with HTTP #{status}"
                end
              else
                @state.stats['retried_batches'] += 1; @state.stats['last_error'] = "telemetry delivery failed (HTTP #{status})"
              end
            end
            if ack || ![0, 401, 403, 429, 502, 503, 504].include?(status); backoff = 0.2; next; end
            delay = [delay, [401, 403].include?(status) ? 30 : backoff * (0.8 + rand * 0.4)].max
            sleep [delay, [0, deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)].max].min
            backoff = [30, backoff * 2].min
          end
      ensure
        @state.delivery.unlock
      end
    end
    def shutdown(timeout: 10)
      @state.heartbeat_stop << true if @state.heartbeat_stop
      flush(timeout: timeout)
    ensure
      @state.gate.synchronize { @state.closed = true }
    end
  end
end
