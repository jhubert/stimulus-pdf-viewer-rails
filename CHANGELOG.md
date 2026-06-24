# Changelog

All notable changes to this project will be documented in this file.

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
