module StimulusPdfViewer
  module Rails
    class Engine < ::Rails::Engine
      isolate_namespace StimulusPdfViewer

      initializer "stimulus-pdf-viewer.assets" do |app|
        # Add our assets to the asset paths
        app.config.assets.paths << root.join("app/assets/javascripts")
        app.config.assets.paths << root.join("app/assets/stylesheets")

        # Precompile the main JS file
        app.config.assets.precompile += %w[
          stimulus-pdf-viewer.esm.js
          stimulus-pdf-viewer.js
        ]
      end

      initializer "stimulus-pdf-viewer.importmap", before: "importmap" do |app|
        if app.config.respond_to?(:importmap)
          app.config.importmap.paths << root.join("config/importmap.rb")
        end
      end
    end
  end
end
