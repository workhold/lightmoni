require 'minitest/autorun'
require 'tmpdir'
require 'socket'
require_relative '../lib/lightmoni'

class ReportingTest < Minitest::Test
  class Receiver
    attr_reader :endpoint

    def initialize(status = 200)
      @socket = TCPServer.new('127.0.0.1', 0)
      @endpoint = "http://127.0.0.1:#{@socket.addr[1]}/telemetry"
      @requests = Queue.new
      @thread = Thread.new do
        loop do
          client = @socket.accept
          begin
            method, path = client.gets.split
            headers = {}
            while (line = client.gets) && line != "\r\n"
              key, value = line.split(':', 2)
              headers[key.downcase] = value.strip
            end
            body = client.read(headers.fetch('content-length', '0').to_i)
            @requests << { method: method, path: path, headers: headers, body: JSON.parse(body) }
            client.write("HTTP/1.1 #{status} Test\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
          ensure
            client.close
          end
        end
      rescue IOError, Errno::EBADF
        # Closing the listening socket terminates the test receiver.
      end
    end

    def requests
      result = []
      result << @requests.pop(true) until @requests.empty?
      result
    end

    def close
      @socket.close
      @thread.join(1) || @thread.kill
    end
  end

  def setup
    @previous = ENV.to_h.select { |key, _| key.start_with?('LIGHTMONI_') }
    @previous.each_key { |key| ENV.delete(key) }
    @directory = Dir.mktmpdir('lightmoni-reporting')
    @receivers = []
  end

  def teardown
    @receivers.each(&:close)
    ENV.keys.grep(/\ALIGHTMONI_/).each { |key| ENV.delete(key) }
    @previous.each { |key, value| ENV[key] = value }
    FileUtils.remove_entry(@directory)
  end

  def from_env(**options)
    LightMoni.from_env(service: 'reporting-test', table: 'orders', self_telemetry: false, **options)
  end

  def receiver(status = 200)
    value = Receiver.new(status)
    @receivers << value
    value
  end

  def missing_file
    File.join(@directory, 'missing-secret')
  end

  def test_direct_ignores_agent_secret_files_and_conflicts
    ENV['LIGHTMONI_MODE'] = 'direct'
    ENV['LIGHTMONI_ENDPOINT'] = 'http://127.0.0.1:8080'
    ENV['LIGHTMONI_DATA_KEY'] = 'platform-key'
    ENV['LIGHTMONI_AGENT_ENDPOINT'] = 'invalid unused address'
    ENV['LIGHTMONI_LOCAL_TOKEN'] = 'unused-env'
    ENV['LIGHTMONI_LOCAL_TOKEN_FILE'] = missing_file
    client = from_env(local_token: 'unused-explicit', local_token_file: missing_file)
    assert_equal 'http://127.0.0.1:8080', client.state.endpoint.to_s
    assert_equal 'platform-key', client.state.key
    assert_equal 'direct', client.stats['selected_route']
    assert_equal 'not_probed', client.stats['agent_probe']
  end

  def test_agent_ignores_platform_secret_files_and_legacy_conflicts
    ENV['LIGHTMONI_MODE'] = 'agent'
    ENV['LIGHTMONI_AGENT_ENDPOINT'] = 'http://127.0.0.1:4318'
    ENV['LIGHTMONI_LOCAL_TOKEN'] = 'local-token'
    ENV['LIGHTMONI_ENDPOINT'] = 'invalid unused address'
    ENV['LIGHTMONI_DATA_KEY'] = 'unused-env'
    ENV['LIGHTMONI_KEY'] = 'unused-legacy'
    ENV['LIGHTMONI_DATA_KEY_FILE'] = missing_file
    client = from_env(data_key: 'unused-explicit', key: 'unused-key', data_key_file: missing_file)
    assert_equal 'http://127.0.0.1:4318', client.state.endpoint.to_s
    assert_equal 'local-token', client.state.key
    assert_equal 'agent', client.stats['selected_route']
  end

  def test_selected_credentials_still_reject_conflicting_sources
    ENV['LIGHTMONI_DATA_KEY'] = 'env-data'
    error = assert_raises(ArgumentError) { from_env(mode: 'direct', endpoint: 'http://localhost:8080', data_key: 'explicit-data') }
    assert_match(/credential_source_conflict: LIGHTMONI_DATA_KEY/, error.message)
    ENV['LIGHTMONI_LOCAL_TOKEN'] = 'env-local'
    error = assert_raises(ArgumentError) { from_env(mode: 'agent', local_token: 'explicit-local') }
    assert_match(/credential_source_conflict: LIGHTMONI_LOCAL_TOKEN/, error.message)
  end

  def test_direct_preserves_legacy_alias_and_legacy_conflict_detection
    ENV['LIGHTMONI_KEY'] = 'legacy-data'
    client = from_env(mode: 'direct', endpoint: 'http://localhost:8080')
    assert_equal 'legacy-data', client.state.key
    assert_equal 'legacy-env', client.stats['credential_source']
    ENV['LIGHTMONI_DATA_KEY'] = 'new-data'
    error = assert_raises(ArgumentError) { from_env(mode: 'direct', endpoint: 'http://localhost:8080') }
    assert_match(/credential_source_conflict: LIGHTMONI_KEY/, error.message)
  end

  def test_selected_secret_file_is_used_and_validated
    path = File.join(@directory, 'secret')
    File.write(path, "file-secret\n")
    direct = from_env(mode: 'direct', endpoint: 'http://localhost:8080', data_key_file: path)
    agent = from_env(mode: 'agent', local_token_file: path)
    assert_equal 'file-secret', direct.state.key
    assert_equal 'file-secret', agent.state.key
    assert_equal 'file', direct.stats['credential_source']
    assert_equal 'file', agent.stats['credential_source']
    link = File.join(@directory, 'link')
    File.symlink(path, link)
    assert_raises(ArgumentError) { from_env(mode: 'direct', endpoint: 'http://localhost:8080', data_key_file: link) }
    assert_raises(ArgumentError) { from_env(mode: 'agent', local_token_file: link) }
  end

  def test_unknown_mode_rejected_before_reading_secrets
    ENV['LIGHTMONI_DATA_KEY_FILE'] = ENV['LIGHTMONI_LOCAL_TOKEN_FILE'] = missing_file
    error = assert_raises(ArgumentError) { from_env(mode: 'unknown') }
    assert_equal 'mode must be agent, direct, or auto', error.message
  end

  def test_auto_still_validates_both_secret_paths
    ENV['LIGHTMONI_LOCAL_TOKEN_FILE'] = missing_file
    assert_raises(Errno::ENOENT) { from_env(mode: 'auto', endpoint: 'http://localhost:8080', data_key: 'data') }
    ENV.delete('LIGHTMONI_LOCAL_TOKEN_FILE')
    ENV['LIGHTMONI_DATA_KEY_FILE'] = missing_file
    assert_raises(Errno::ENOENT) { from_env(mode: 'auto', local_token: 'local') }
  end

  %w[direct agent].each do |mode|
    define_method("test_#{mode}_sends_all_signals_only_to_selected_receiver") do
      platform, node = receiver, receiver
      ENV['LIGHTMONI_MODE'] = mode
      ENV['LIGHTMONI_ENDPOINT'] = platform.endpoint
      ENV['LIGHTMONI_AGENT_ENDPOINT'] = node.endpoint
      ENV['LIGHTMONI_DATA_KEY'] = 'platform-key'
      ENV['LIGHTMONI_LOCAL_TOKEN'] = 'local-token'
      client = from_env
      client.counter('orders.created').add(2)
      client.log('info', 'order created')
      client.start_span('create order').finish
      client.shutdown(timeout: 2)
      selected, unused = mode == 'direct' ? [platform, node] : [node, platform]
      requests = selected.requests
      assert_empty unused.requests
      assert_equal %w[/telemetry/v1/logs /telemetry/v1/metrics /telemetry/v1/traces], requests.map { |request| request[:path] }.sort
      requests.each do |request|
        assert_equal 'POST', request[:method]
        assert_equal 'Bearer ' + (mode == 'direct' ? 'platform-key' : 'local-token'), request[:headers]['authorization']
        assert_equal 'orders', request[:headers]['x-lightmoni-table']
        assert_match(/\A[0-9a-f-]{36}\z/, request[:headers]['x-lightmoni-batch-id'])
      end
    end

    define_method("test_#{mode}_does_not_switch_receiver_after_failure") do
      selected, unused = receiver(503), receiver
      platform, node = mode == 'direct' ? [selected, unused] : [unused, selected]
      client = from_env(mode: mode, endpoint: platform.endpoint, agent_endpoint: node.endpoint, data_key: 'platform-key', local_token: 'local-token')
      client.log('info', 'retained')
      assert_raises(Timeout::Error) { client.flush(timeout: 0.1) }
      assert_empty unused.requests
      assert_operator selected.requests.length, :>=, 1
      assert_equal 1, client.stats['pending_batches']
      assert_equal mode, client.stats['selected_route']
      assert_equal 0, client.stats['fallback_count']
    end
  end
end
