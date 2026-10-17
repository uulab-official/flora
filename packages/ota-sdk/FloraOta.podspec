require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
Pod::Spec.new do |s|
  s.name = 'FloraOta'
  s.version = package['version']
  s.summary = 'Signed self-hosted OTA for React Native without EAS'
  s.homepage = 'https://github.com/uulab-official/flora'
  s.license = package['license']
  s.authors = { 'UULab' => 'uulab.official@gmail.com' }
  s.source = { :git => 'https://github.com/uulab-official/flora.git', :tag => s.version.to_s }
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.0'
  s.source_files = 'ios/*.{swift,h,m}'
  s.frameworks = 'Foundation', 'Security', 'CryptoKit'
  s.dependency 'React-Core'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
