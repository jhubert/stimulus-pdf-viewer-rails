require_relative "lib/stimulus_pdf_viewer/rails/version"

Gem::Specification.new do |spec|
  spec.name = "stimulus-pdf-viewer-rails"
  spec.version = StimulusPdfViewer::Rails::VERSION
  spec.authors = ["Jeremy Baker"]
  spec.email = ["jeremy@jeremybaker.me"]

  spec.summary = "PDF viewer with annotations for Rails, powered by Stimulus"
  spec.description = "A full-featured PDF viewer with annotation support (highlights, underlines, notes, drawing) for Rails applications. Uses Stimulus controllers and requires no Node.js or npm."
  spec.homepage = "https://github.com/jhubert/stimulus-pdf-viewer-rails"
  spec.licenses = ["MIT", "Apache-2.0"]
  spec.required_ruby_version = ">= 3.1.0"

  spec.metadata["source_code_uri"] = spec.homepage
  spec.metadata["changelog_uri"] = "#{spec.homepage}/blob/main/CHANGELOG.md"

  spec.files = Dir[
    "lib/**/*",
    "app/**/*",
    "config/**/*",
    "LICENSE*",
    "NOTICE",
    "README.md",
    "CHANGELOG.md"
  ]
  spec.require_paths = ["lib"]

  spec.add_dependency "railties", ">= 7.0", '< 9'
end
