# Changelog

All notable changes to this project will be documented in this file.

## [0.7.1] - 2026-11-22

### Fixed
- Updated stimulus-pdf-viewer to 0.7.1

A bugfix release with no new attributes or stylesheet changes.

- Drawing: a quick pen stroke on another page no longer throws from
  `setPointerCapture` (Apple Pencil), ink drawn just before leaving a document
  is saved, and a palm or second finger no longer corrupts a stroke in progress.
- Annotated downloads no longer fail for readers whose name is outside Latin-1
  ("Łukasz", "山田"), and annotations land where they were drawn on rotated and
  cropped pages. A download whose fetch fails now reports an error instead of
  saving the error response.
- Time tracking no longer counts time while the tab is hidden.
- Leaving a page while the viewer is still loading no longer leaves it running
  or shows "Failed to load PDF document".
- Ctrl/Cmd+Z undoes a deletion while the undo bar is showing, and undo works
  when no `annotations-url-value` is set.
- A note that fails to save keeps its dialog open, so the text isn't lost.
- The colour picker's dropdown stays inside the viewer, so its last colours can
  be clicked when the picker sits near the right of the toolbar.

See the upstream
[0.7.1 release notes](https://github.com/jhubert/stimulus-pdf-viewer/releases/tag/v0.7.1)
for details.

### Upgrade notes
- A failure to load annotations no longer covers the document with "Failed to
  load PDF document". The document stays readable and the failure is reported
  through the `pdf-viewer:error` event, as before. An app calling
  `PdfViewer#load` itself and relying on it rejecting should listen for that
  event.

## [0.7.0] - 2026-11-07

### Fixed
- Updated stimulus-pdf-viewer to 0.7.0

Hyperlinks inside PDFs are now clickable in the viewer. A link written by
PowerPoint, Keynote, Word or InDesign (a YouTube URL on a slide, a table of
contents, a "see page 12" reference) used to be drawn on the page but couldn't
be clicked. Web and email links open in a new tab, and links to other pages
scroll to the exact spot they target. The PDF file was never altered, which is
why links always worked in a downloaded copy. See the upstream
[0.7.0 release notes](https://github.com/jhubert/stimulus-pdf-viewer/releases/tag/v0.7.0)
for details.

### Added
- The `initial-destination-value` data attribute, and an `initial_destination`
  local in the generated viewer partial, open the document at a named
  destination: an anchor stored in the PDF. If the document doesn't define it,
  the viewer falls back to `initial-page-value`. Named destinations survive the
  document being regenerated, so they make better deep links than page numbers.
- A cancelable `pdf-viewer:link-clicked` event fires before a link in the PDF is
  followed, so an app can open links itself.

### Upgrade notes
- The bundled stylesheet gains the `.link-layer` and `.pdf-link` rules that
  links need. If your app copied the stylesheet instead of importing
  `stimulus-pdf-viewer` from the gem, copy it again, or links won't be clickable.

## [0.6.0] - 2026-09-22

### Fixed
- Updated stimulus-pdf-viewer to 0.6.0

Annotated downloads now include everything shown on screen. Underlines were
never exported, because the download code expected an `annotation_type` of
`underline` while the underline tool created `line`. Comments on highlights,
underlines, and drawings are now exported too. Curly quotes, em dashes, and
non-Latin text in comments and notes no longer come out garbled. See the
upstream
[0.6.0 release notes](https://github.com/jhubert/stimulus-pdf-viewer/releases/tag/v0.6.0)
for details.

### Upgrade notes
- New underlines are saved with `annotation_type: "underline"` instead of
  `"line"`. Make sure your `Annotation` model accepts `underline`; with an
  integer enum, rename the `line` key in place. Stored `"line"` records keep
  working, but they are deprecated. The upstream release notes give the SQL to
  migrate them.

## [0.5.0] - 2026-08-11

### Added
- Updated stimulus-pdf-viewer to 0.5.0

Adds support for password-protected PDFs: the viewer prompts for the password
(with retry on incorrect entry) and opens encrypted documents in read-only
mode — annotation tools are disabled and the download button delivers the
original file. The vendored stylesheet includes new rules for the password
prompt and read-only mode, so recompile your assets after upgrading. See the
upstream
[0.5.0 changelog](https://github.com/jhubert/stimulus-pdf-viewer/blob/main/CHANGELOG.md)
for full details.

## [0.4.1] - 2026-08-10

### Fixed
- Updated stimulus-pdf-viewer to 0.4.1

This fixes `initialAnnotation` deep-links, which never scrolled to or selected
the annotation (a string/number id mismatch in the annotation map lookup), and
gives deep-linked annotations the same flash/highlight treatment as sidebar
clicks. See the upstream
[0.4.1 changelog](https://github.com/jhubert/stimulus-pdf-viewer/blob/main/CHANGELOG.md)
for full details.

## [0.4.0] - 2026-06-24

### Added
- Updated stimulus-pdf-viewer to 0.4.0

This pulls in page rotation support (pages with a `/Rotate` value now render
upright, with text selection and annotation overlays aligned), a stored-XSS fix
for untrusted annotation data, a crash fix when loading a new PDF, per-page
sizing for mixed documents, canvas-size clamping for large/zoomed pages, and a
broad memory-leak cleanup. No breaking changes. See the upstream
[0.4.0 changelog](https://github.com/jhubert/stimulus-pdf-viewer/blob/main/CHANGELOG.md)
for full details.

## [0.3.2] - 2026-05-13

### Added
- Updated stimulus-pdf-viewer to 0.3.2

## [0.3.0] - 2026-04-01

### Added
- Updated stimulus-pdf-viewer to 0.3.0

## [0.2.0] - 2026-01-11

### Added
- Updated stimulus-pdf-viewer to 0.2.0

## [0.1.0] - 2026-01-10

### Added
- Initial release
- Vendored stimulus-pdf-viewer 0.1.0
- Rails engine with asset pipeline integration
- Importmap support (automatic pin for stimulus-pdf-viewer)
- Install generator (`rails g stimulus_pdf_viewer:install`)
- Example view partials
