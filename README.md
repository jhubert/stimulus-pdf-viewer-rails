# stimulus-pdf-viewer-rails

A Rails gem that packages [stimulus-pdf-viewer](https://github.com/jhubert/stimulus-pdf-viewer) for easy integration into Rails applications. No Node.js or npm required.

## Features

- Full-featured PDF viewer powered by PDF.js
- Annotations: highlights, underlines, sticky notes, freehand drawing
- Text search with keyboard shortcuts
- Thumbnail navigation sidebar
- Zoom controls (fit to page, fit to width, custom levels)
- User-specific watermarks
- PDF download with embedded annotations
- Mobile support with touch gestures
- Works with Rails importmap (no Node.js required)

## Installation

Add the gem to your Gemfile:

```ruby
gem "stimulus-pdf-viewer-rails"
```

Then run the installer:

```bash
bundle install
rails generate stimulus_pdf_viewer:install
```

The installer will:
1. Register the Stimulus controllers in your application
2. Add the stylesheet import
3. Add the PDF.js worker meta tag
4. Optionally copy example view partials

## Manual Setup

If you prefer manual setup or the generator doesn't work for your setup:

### 1. Register the Stimulus Controllers

In `app/javascript/controllers/index.js`:

```javascript
import { PdfViewerController, PdfDownloadController } from "stimulus-pdf-viewer"
application.register("pdf-viewer", PdfViewerController)
application.register("pdf-download", PdfDownloadController)
```

### 2. Import the Stylesheet

In your `application.scss`:

```scss
@import "stimulus-pdf-viewer";
```

### 3. Add PDF.js Worker Meta Tag

In your layout `<head>`:

```erb
<meta name="pdf-worker-src" content="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js">
```

Or if you prefer to vendor the worker locally, copy it to your assets and reference it there.

## Usage

### Basic Viewer

```erb
<div class="pdf-viewer-container"
     data-controller="pdf-viewer"
     data-pdf-viewer-document-url-value="<%= url_for(@document.file) %>"
     data-pdf-viewer-document-name-value="<%= @document.name %>"
     data-pdf-viewer-annotations-url-value="<%= document_annotations_path(@document) %>"
     data-pdf-viewer-user-name-value="<%= current_user.name %>">

  <div class="pdf-viewer-toolbar">
    <%= render "pdf_viewer/toolbar" %>
  </div>

  <div class="pdf-viewer-body">
    <div class="pdf-loading-overlay" data-pdf-viewer-target="loadingOverlay">
      <div class="pdf-loading-spinner"></div>
      <div class="pdf-loading-text">Loading document...</div>
    </div>
    <div class="pdf-pages-container"></div>
  </div>
</div>
```

### Configuration Options

| Data Attribute | Description |
|----------------|-------------|
| `document-url-value` | URL to the PDF file (required) |
| `document-name-value` | Display name for downloads (required) |
| `annotations-url-value` | REST API endpoint for annotations |
| `user-name-value` | User name for watermarks |
| `organization-name-value` | Organization name for watermarks |
| `initial-page-value` | Page to open on load |
| `initial-annotation-value` | Annotation ID to highlight on load |
| `tracking-url-value` | Endpoint for time tracking |

### Annotations API

The viewer expects a REST API at `annotations-url-value`:

| Method | Path | Description |
|--------|------|-------------|
| GET | `{url}.json` | List all annotations |
| POST | `{url}` | Create annotation |
| PATCH | `{url}/{id}` | Update annotation |
| DELETE | `{url}/{id}` | Delete annotation |
| PATCH | `{url}/{id}/restore` | Restore deleted annotation |

Example controller:

```ruby
class AnnotationsController < ApplicationController
  before_action :set_document
  before_action :set_annotation, only: [:update, :destroy, :restore]

  def index
    @annotations = @document.annotations
    render json: @annotations
  end

  def create
    @annotation = @document.annotations.build(annotation_params)
    @annotation.user = current_user

    if @annotation.save
      render json: @annotation, status: :created
    else
      render json: @annotation.errors, status: :unprocessable_entity
    end
  end

  def update
    if @annotation.update(annotation_params)
      render json: @annotation
    else
      render json: @annotation.errors, status: :unprocessable_entity
    end
  end

  def destroy
    @annotation.destroy
    head :no_content
  end

  def restore
    @annotation.restore
    render json: @annotation
  end

  private

  def set_document
    @document = Document.find(params[:document_id])
  end

  def set_annotation
    @annotation = @document.annotations.find(params[:id])
  end

  def annotation_params
    params.require(:annotation).permit(
      :page, :annotation_type, :color, :opacity, :contents,
      :thickness, :subject, :rect, quads: {}, ink_strokes: {}
    )
  end
end
```

### Peer Dependencies

The PDF viewer requires these JavaScript libraries. When using importmap, pin them from a CDN:

```ruby
# config/importmap.rb
pin "pdfjs-dist", to: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs"
pin "pdf-lib", to: "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js"
pin "@rails/request.js", to: "@rails--request.js.js" # Usually already pinned
```

## Updating the Vendored Assets

When a new version of stimulus-pdf-viewer is released:

1. Update `STIMULUS_PDF_VIEWER_VERSION` in `lib/stimulus_pdf_viewer/rails/version.rb`
2. Download the new dist files from npm or build from source
3. Replace the files in `app/assets/javascripts/` and `app/assets/stylesheets/`

## License

This gem is dual-licensed:

- **MIT License** - for original code
- **Apache License 2.0** - for code derived from PDF.js

See the [stimulus-pdf-viewer](https://github.com/jhubert/stimulus-pdf-viewer) repository for full license details.
