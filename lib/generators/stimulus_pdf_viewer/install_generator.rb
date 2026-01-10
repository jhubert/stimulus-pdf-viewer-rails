require "rails/generators"

module StimulusPdfViewer
  module Generators
    class InstallGenerator < ::Rails::Generators::Base
      source_root File.expand_path("install/templates", __dir__)

      desc "Install stimulus-pdf-viewer into your Rails application"

      def register_stimulus_controller
        say "Registering Stimulus controller..."

        controller_registration = <<~JS

          // PDF Viewer
          import { PdfViewerController, PdfDownloadController } from "stimulus-pdf-viewer"
          application.register("pdf-viewer", PdfViewerController)
          application.register("pdf-download", PdfDownloadController)
        JS

        controllers_file = "app/javascript/controllers/index.js"

        if File.exist?(controllers_file)
          append_to_file controllers_file, controller_registration
          say "Added controller registration to #{controllers_file}", :green
        else
          say "Could not find #{controllers_file}. Please manually register the controllers:", :yellow
          say controller_registration
        end
      end

      def add_stylesheet_import
        say "Adding stylesheet import..."

        stylesheet_import = '@import "stimulus-pdf-viewer";'

        # Try common stylesheet locations
        stylesheet_files = [
          "app/assets/stylesheets/application.scss",
          "app/assets/stylesheets/application.css.scss",
          "app/assets/stylesheets/application.sass.scss"
        ]

        stylesheet_file = stylesheet_files.find { |f| File.exist?(f) }

        if stylesheet_file
          append_to_file stylesheet_file, "\n#{stylesheet_import}\n"
          say "Added stylesheet import to #{stylesheet_file}", :green
        else
          say "Could not find a SCSS stylesheet. Please manually add:", :yellow
          say stylesheet_import
        end
      end

      def add_pdf_worker_meta_tag
        say "Adding PDF.js worker meta tag..."

        meta_tag = '<meta name="pdf-worker-src" content="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js">'

        layout_file = "app/views/layouts/application.html.erb"

        if File.exist?(layout_file)
          inject_into_file layout_file, "    #{meta_tag}\n", after: "<head>\n"
          say "Added PDF worker meta tag to #{layout_file}", :green
        else
          say "Could not find #{layout_file}. Please manually add to your <head>:", :yellow
          say meta_tag
        end
      end

      def copy_example_partials
        if yes?("Would you like to copy example view partials? (y/n)")
          directory "views", "app/views/pdf_viewer"
          say "Copied example partials to app/views/pdf_viewer/", :green
        end
      end

      def show_next_steps
        say ""
        say "=" * 60, :green
        say "stimulus-pdf-viewer installed successfully!", :green
        say "=" * 60, :green
        say ""
        say "Next steps:"
        say "1. Create an Annotation model and controller for your app"
        say "2. Set up routes for annotations REST API"
        say "3. Add the PDF viewer partial to your views"
        say ""
        say "See the README for detailed integration instructions:"
        say "https://github.com/jhubert/stimulus-pdf-viewer-rails"
        say ""
      end
    end
  end
end
