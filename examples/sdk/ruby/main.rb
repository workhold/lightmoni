require_relative '../../../sdk/ruby/lib/lightmoni'
mode = ENV.fetch('LIGHTMONI_TEST_MODE', 'demo')
limits = mode == 'overflow' ? { cardinality_limit: 2 } : mode == 'capacity' ? { queue_bytes: 1024, max_batch_bytes: 1024, buffer_bytes: 64 } : {}
mon = LightMoni::Client.new(service: ENV.fetch('LIGHTMONI_SERVICE', 'example-ruby-api'), table: 'http', endpoint: ENV.fetch('LIGHTMONI_ENDPOINT', 'http://127.0.0.1:4318'), key: ENV.fetch('LIGHTMONI_KEY', ''), **limits)
counter = mon.counter('http.requests')
case mode
when 'fixture'
  dims = { 'route' => '/payments', 'method' => 'POST', 'status' => 200 }
  counter.add(1, dims); dims['status'] = 999
  counter.add(2, 'status' => 200, 'method' => 'POST', 'route' => '/payments')
  counter.add(1, 'status' => 500, 'method' => 'POST', 'route' => '/payments')
  counter.add(1, 'typed' => 1); counter.add(1, 'typed' => '1'); counter.add(-1)
  mon.counter('exact').add(9007199254740993)
  gauge = mon.gauge('active'); gauge.record(5); gauge.record(7)
  histogram = mon.histogram('duration', boundaries: [5, 10]); [-1, 5, 6, 10, 11].each { |n| histogram.record(n) }
  parent = LightMoni::TraceContext.extract('traceparent' => '00-' + 'a' * 32 + '-' + 'b' * 16 + '-01', 'tracestate' => 'foo=bar')
  raise 'invalid parent accepted' if LightMoni::TraceContext.extract('traceparent' => '00-' + '0' * 32 + '-' + 'b' * 16 + '-01')
  raise 'context roundtrip' unless LightMoni::TraceContext.extract(parent.inject).inject == parent.inject
  app = mon.with_table('app'); span = app.start_span('fixture', parent: parent)
  app.log('info', '中文 fixture', { 'exact' => 9007199254740993, 'ok' => true, 'fraction' => 0.125 }, context: span.context); span.finish
  mon.flush; counter.add(2, 'window' => 'next'); mon.flush
when 'overflow'
  4.times { |i| counter.add(1, 'dimension' => i) }; mon.flush
when 'retry', 'auth'
  counter.add(1, 'window' => 'first')
  begin
    mon.flush(timeout: 0.45); raise 'expected deadline'
  rescue Timeout::Error
  end
  raise 'batch lost' unless mon.stats['pending_batches'] == 1
  counter.add(2, 'window' => 'next'); mon.update_key('rotated'); mon.flush
when 'permanent', 'partial', 'capacity'
  counter.add(1)
  2.times do
    failed = false
    begin; mon.flush; rescue RuntimeError; failed = true; end
    raise 'expected delivery loss' unless failed
  end
  raise 'batch retained' unless mon.stats['pending_batches'] == 0
else
  app = mon.with_table('app'); duration = mon.histogram('http.duration', boundaries: [5, 10, 25, 50, 100, 250]); active = mon.gauge('http.active')
  ENV.fetch('LIGHTMONI_COUNT', '20').to_i.times do |i|
    status = i % 5 == 0 ? 500 : 200
    span = app.start_span('POST /payments')
    dims = { 'route' => '/payments', 'method' => 'POST', 'status' => status }
    counter.add(1, dims); duration.record(5 + i * 2, dims); active.record(i % 4)
    app.log(status == 500 ? 'error' : 'info', 'sample payment completed', { 'sample_id' => i, 'status' => status }, context: span.context)
    span.set_error('sample payment failed') if status == 500
    span.finish
  end
  mon.shutdown(timeout: 15)
end
puts JSON.generate(mon.stats)
