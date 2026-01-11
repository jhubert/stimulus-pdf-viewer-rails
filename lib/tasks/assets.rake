require "fileutils"
require "json"
require "open-uri"
require "tmpdir"

namespace :stimulus_pdf_viewer do
  desc "Update vendored assets from stimulus-pdf-viewer npm package"
  task :update, [:version] do |_t, args|
    version = args[:version] || "latest"
    updater = StimulusPdfViewerAssetUpdater.new(version)
    updater.run
  end

  desc "Check for newer versions of stimulus-pdf-viewer"
  task :check do
    checker = StimulusPdfViewerVersionChecker.new
    checker.run
  end
end

class StimulusPdfViewerAssetUpdater
  NPM_REGISTRY_URL = "https://registry.npmjs.org/stimulus-pdf-viewer"
  GEM_ROOT = File.expand_path("../..", __dir__)

  ASSET_MAPPINGS = {
    "dist/stimulus-pdf-viewer.esm.js" => "app/assets/javascripts/stimulus-pdf-viewer.esm.js",
    "dist/stimulus-pdf-viewer.js" => "app/assets/javascripts/stimulus-pdf-viewer.js",
    "styles/pdf-viewer.scss" => "app/assets/stylesheets/stimulus-pdf-viewer.scss"
  }.freeze

  CURSOR_SOURCE_DIR = "assets/cursors"
  CURSOR_DEST_DIR = "app/assets/images/stimulus-pdf-viewer"

  def initialize(version)
    @requested_version = version
  end

  def run
    puts "Fetching package info from npm registry..."
    package_info = fetch_package_info

    @version = resolve_version(package_info)
    puts "Target version: #{@version}"

    current_version = read_current_version
    if current_version == @version && @requested_version == "latest"
      puts "Already at version #{@version}. Use rake stimulus_pdf_viewer:update[#{@version}] to force reinstall."
      return
    end

    if current_version == @version
      puts "Reinstalling version #{@version}..."
    else
      puts "Updating from #{current_version} to #{@version}..."
    end

    Dir.mktmpdir do |tmpdir|
      tarball_path = download_package(package_info, tmpdir)
      extract_package(tarball_path, tmpdir)

      package_dir = File.join(tmpdir, "package")
      copy_assets(package_dir)
      update_version_file
    end

    puts "Successfully updated to version #{@version}"
  end

  private

  def fetch_package_info
    JSON.parse(URI.open(NPM_REGISTRY_URL).read)
  rescue OpenURI::HTTPError => e
    abort "Failed to fetch package info: #{e.message}"
  end

  def resolve_version(package_info)
    if @requested_version == "latest"
      package_info["dist-tags"]["latest"]
    else
      unless package_info["versions"].key?(@requested_version)
        available = package_info["versions"].keys.last(10).join(", ")
        abort "Version #{@requested_version} not found. Recent versions: #{available}"
      end
      @requested_version
    end
  end

  def read_current_version
    version_file = File.join(GEM_ROOT, "lib/stimulus_pdf_viewer/rails/version.rb")
    content = File.read(version_file)
    match = content.match(/STIMULUS_PDF_VIEWER_VERSION\s*=\s*["']([^"']+)["']/)
    match ? match[1] : "unknown"
  end

  def download_package(package_info, tmpdir)
    tarball_url = package_info["versions"][@version]["dist"]["tarball"]
    tarball_path = File.join(tmpdir, "package.tgz")

    puts "Downloading #{tarball_url}..."
    File.open(tarball_path, "wb") do |file|
      URI.open(tarball_url) { |remote| file.write(remote.read) }
    end

    tarball_path
  end

  def extract_package(tarball_path, tmpdir)
    puts "Extracting package..."
    system("tar", "-xzf", tarball_path, "-C", tmpdir, exception: true)
  end

  def copy_assets(package_dir)
    puts "Copying assets..."

    ASSET_MAPPINGS.each do |src, dest|
      src_path = File.join(package_dir, src)
      dest_path = File.join(GEM_ROOT, dest)

      unless File.exist?(src_path)
        warn "  Warning: #{src} not found in package"
        next
      end

      FileUtils.cp(src_path, dest_path)
      puts "  #{src} -> #{dest}"
    end

    copy_cursors(package_dir)
  end

  def copy_cursors(package_dir)
    cursor_src = File.join(package_dir, CURSOR_SOURCE_DIR)
    cursor_dest = File.join(GEM_ROOT, CURSOR_DEST_DIR)

    unless Dir.exist?(cursor_src)
      warn "  Warning: #{CURSOR_SOURCE_DIR} not found in package"
      return
    end

    FileUtils.mkdir_p(cursor_dest)

    Dir.glob(File.join(cursor_src, "*.svg")).each do |svg|
      FileUtils.cp(svg, cursor_dest)
      puts "  #{CURSOR_SOURCE_DIR}/#{File.basename(svg)} -> #{CURSOR_DEST_DIR}/"
    end
  end

  def update_version_file
    version_file = File.join(GEM_ROOT, "lib/stimulus_pdf_viewer/rails/version.rb")
    content = File.read(version_file)

    updated = content.gsub(
      /STIMULUS_PDF_VIEWER_VERSION\s*=\s*["'][^"']+["']/,
      "STIMULUS_PDF_VIEWER_VERSION = \"#{@version}\""
    )

    File.write(version_file, updated)
    puts "Updated STIMULUS_PDF_VIEWER_VERSION to #{@version}"
  end
end

class StimulusPdfViewerVersionChecker
  NPM_REGISTRY_URL = "https://registry.npmjs.org/stimulus-pdf-viewer"
  GEM_ROOT = File.expand_path("../..", __dir__)

  def run
    current = read_current_version
    latest = fetch_latest_version

    puts "Current vendored version: #{current}"
    puts "Latest npm version: #{latest}"

    if current == latest
      puts "You are up to date!"
    else
      puts "Update available! Run: rake stimulus_pdf_viewer:update"
    end
  end

  private

  def read_current_version
    version_file = File.join(GEM_ROOT, "lib/stimulus_pdf_viewer/rails/version.rb")
    content = File.read(version_file)
    match = content.match(/STIMULUS_PDF_VIEWER_VERSION\s*=\s*["']([^"']+)["']/)
    match ? match[1] : "unknown"
  end

  def fetch_latest_version
    response = JSON.parse(URI.open(NPM_REGISTRY_URL).read)
    response["dist-tags"]["latest"]
  rescue OpenURI::HTTPError => e
    abort "Failed to fetch package info: #{e.message}"
  end
end
