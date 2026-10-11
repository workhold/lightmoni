Gem::Specification.new do |s|
  s.name = 'lightmoni-sdk'
  s.version = '0.1.0'
  s.summary = 'Bounded OTLP/HTTP telemetry for LightMoni'
  s.authors = ['LightMoni']
  s.required_ruby_version = '>= 2.7'
  s.files = Dir['lib/**/*.rb'] + ['README.md']
  s.require_paths = ['lib']
end
