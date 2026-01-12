import { Controller } from '@hotwired/stimulus';
import * as pdfjsLib from 'pdfjs-dist';
import { FetchRequest } from '@rails/request.js';
import { PDFDocument, StandardFonts, degrees, rgb, PDFName, PDFString, PDFArray } from 'pdf-lib';

/**
 * EventBus - Internal event system for the PDF viewer.
 * Based on PDF.js event_utils.js pattern.
 *
 * Provides a simple pub/sub mechanism for internal communication
 * between viewer components without tight coupling.
 */
class EventBus {
  constructor() {
    this._listeners = Object.create(null);
  }

  /**
   * Register an event listener.
   * @param {string} eventName - The event name
   * @param {Function} listener - The callback function
   * @param {Object} options - Optional settings
   * @param {boolean} options.once - If true, listener auto-removes after first call
   * @param {AbortSignal} options.signal - AbortSignal for cleanup
   */
  on(eventName, listener, options = null) {
    let rmAbort = null;

    if (options?.signal) {
      const { signal } = options;
      if (signal.aborted) {
        console.error("EventBus.on: signal is already aborted");
        return
      }
      rmAbort = () => this.off(eventName, listener);
      signal.addEventListener("abort", rmAbort);
    }

    const eventListeners = (this._listeners[eventName] ||= []);
    eventListeners.push({
      listener,
      once: options?.once === true,
      rmAbort
    });
  }

  /**
   * Remove an event listener.
   * @param {string} eventName - The event name
   * @param {Function} listener - The callback function to remove
   */
  off(eventName, listener) {
    const eventListeners = this._listeners[eventName];
    if (!eventListeners) {
      return
    }

    for (let i = 0; i < eventListeners.length; i++) {
      const evt = eventListeners[i];
      if (evt.listener === listener) {
        evt.rmAbort?.(); // Clean up AbortSignal listener
        eventListeners.splice(i, 1);
        return
      }
    }
  }

  /**
   * Dispatch an event to all registered listeners.
   * @param {string} eventName - The event name
   * @param {Object} data - Event data passed to listeners
   */
  dispatch(eventName, data = null) {
    const eventListeners = this._listeners[eventName];
    if (!eventListeners || eventListeners.length === 0) {
      return
    }

    // Clone array to avoid issues if listeners modify the list
    const listeners = eventListeners.slice();
    for (const { listener, once } of listeners) {
      if (once) {
        this.off(eventName, listener);
      }

      // Call with event data merged with source info
      listener({
        source: this,
        ...data
      });
    }
  }

  /**
   * Remove all listeners for cleanup.
   */
  destroy() {
    for (const eventName in this._listeners) {
      const eventListeners = this._listeners[eventName];
      for (const evt of eventListeners) {
        evt.rmAbort?.();
      }
    }
    this._listeners = Object.create(null);
  }
}

/**
 * Standard events dispatched by the core viewer.
 * Tools and UI components can listen for these.
 */
const ViewerEvents = {
  // Document lifecycle
  DOCUMENT_LOADED: "documentloaded",
  DOCUMENT_LOAD_ERROR: "documentloaderror",

  // Page events
  PAGE_RENDERED: "pagerendered",
  PAGE_CHANGING: "pagechanging",
  PAGES_LOADED: "pagesloaded",

  // Text layer events
  TEXT_LAYER_RENDERED: "textlayerrendered",

  // Scale/zoom events
  SCALE_CHANGED: "scalechanged",

  // Scroll events
  SCROLL: "scroll",

  // Annotation layer events (for PDF-embedded annotations)
  ANNOTATION_LAYER_RENDERED: "annotationlayerrendered"
};

/**
 * RenderingQueue - Manages prioritized lazy rendering of PDF pages.
 * Based on PDF.js pdf_rendering_queue.js pattern.
 *
 * Only renders visible pages and pre-renders adjacent pages for
 * smooth scrolling performance.
 */

const RenderingStates = {
  INITIAL: 0,
  RUNNING: 1,
  PAUSED: 2,
  FINISHED: 3
};

class RenderingQueue {
  constructor() {
    this.pdfViewer = null;
    this.printing = false;
    this._highestPriorityPage = null;
    this._idleTimeout = null;
    this._onIdle = null;
  }

  /**
   * Set the viewer to use for rendering.
   * @param {Object} pdfViewer - The viewer instance
   */
  setViewer(pdfViewer) {
    this.pdfViewer = pdfViewer;
  }

  /**
   * Check if rendering is currently in progress.
   * @returns {boolean}
   */
  isHighestPriorityPage(pageNumber) {
    return this._highestPriorityPage === pageNumber
  }

  /**
   * Check if there are any pages being rendered.
   * @returns {boolean}
   */
  hasViewer() {
    return !!this.pdfViewer
  }

  /**
   * Trigger rendering of visible pages.
   * Called when the viewer scrolls or changes.
   */
  async renderHighestPriority(visiblePages = null) {
    if (!this.pdfViewer) {
      return
    }

    // Clear any pending idle callback
    if (this._idleTimeout) {
      clearTimeout(this._idleTimeout);
      this._idleTimeout = null;
    }

    const pageToRender = this._getHighestPriorityPage(visiblePages);

    if (pageToRender !== null) {
      this._highestPriorityPage = pageToRender;
      try {
        await this.pdfViewer.renderPage(pageToRender);
        this._highestPriorityPage = null;
        // Check if there are more pages to render
        this.renderHighestPriority();
      } catch (err) {
        this._highestPriorityPage = null;
        console.error("RenderingQueue: Error rendering page", err);
      }
    } else {
      // No more pages to render, trigger idle callback
      this._idleTimeout = setTimeout(() => {
        this._onIdle?.();
      }, 100);
    }
  }

  /**
   * Determine which page should be rendered next.
   * Priority: visible pages first, then adjacent pages for pre-rendering.
   * @param {Object} visiblePages - Object with first/last visible page info
   * @returns {number|null} - Page number to render, or null if none
   */
  _getHighestPriorityPage(visiblePages) {
    if (!this.pdfViewer) {
      return null
    }

    const { first, last, scrollDirection } = visiblePages || this.pdfViewer.getVisiblePages();

    if (first === null || last === null) {
      return null
    }

    // First, render any unrendered visible pages
    // Prioritize based on scroll direction
    if (scrollDirection === "down") {
      for (let page = first; page <= last; page++) {
        if (!this._isPageRendered(page)) {
          return page
        }
      }
    } else {
      for (let page = last; page >= first; page--) {
        if (!this._isPageRendered(page)) {
          return page
        }
      }
    }

    // All visible pages rendered, pre-render adjacent pages
    const preRenderCount = 2;

    // Pre-render pages after visible area
    for (let i = 1; i <= preRenderCount; i++) {
      const nextPage = last + i;
      if (nextPage <= this.pdfViewer.pageCount && !this._isPageRendered(nextPage)) {
        return nextPage
      }
    }

    // Pre-render pages before visible area
    for (let i = 1; i <= preRenderCount; i++) {
      const prevPage = first - i;
      if (prevPage >= 1 && !this._isPageRendered(prevPage)) {
        return prevPage
      }
    }

    return null
  }

  /**
   * Check if a page has been rendered at the current scale or is currently rendering.
   * @param {number} pageNumber
   * @returns {boolean}
   */
  _isPageRendered(pageNumber) {
    const pageData = this.pdfViewer.pages.get(pageNumber);
    if (!pageData) return false

    // Currently rendering - don't re-trigger
    if (pageData.renderingState === RenderingStates.RUNNING) return true

    // Check if finished AND at current scale
    if (pageData.renderingState === RenderingStates.FINISHED) {
      return pageData.renderedScale === this.pdfViewer.displayScale
    }

    return false
  }

  /**
   * Reset all rendering states (e.g., on zoom change).
   */
  reset() {
    this._highestPriorityPage = null;
    if (this._idleTimeout) {
      clearTimeout(this._idleTimeout);
      this._idleTimeout = null;
    }
  }

  /**
   * Register a callback for when rendering is idle.
   * @param {Function} callback
   */
  onIdle(callback) {
    this._onIdle = callback;
  }

  /**
   * Clean up.
   */
  destroy() {
    this.reset();
    this.pdfViewer = null;
    this._onIdle = null;
  }
}

// Configure PDF.js worker from meta tag (set by Rails asset pipeline for cache busting)
const workerSrcMeta = document.querySelector('meta[name="pdf-worker-src"]');
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrcMeta?.content || "/assets/pdfjs-dist--pdf.worker.js";

/**
 * Scale values that can be used with setScale()
 */
const ScaleValue = {
  AUTO: "auto",
  PAGE_FIT: "page-fit",
  PAGE_WIDTH: "page-width"
};

/**
 * CoreViewer - The foundational PDF rendering component.
 *
 * This class provides:
 * - PDF document loading and page rendering
 * - Text layer for text selection
 * - Re-rendering based zoom (crisp at all zoom levels)
 * - Lazy rendering of pages for performance
 * - Event-driven architecture for tool integration
 *
 * Usage:
 *   const viewer = new CoreViewer(container, { eventBus })
 *   await viewer.load(pdfUrl)
 *   viewer.setScale(1.5)
 */
class CoreViewer {
  constructor(container, options = {}) {
    this.container = container;
    this.eventBus = options.eventBus || new EventBus();

    // PDF.js document reference
    this.pdfDocument = null;
    this.pageCount = 0;

    // Page data storage: pageNumber -> PageData
    this.pages = new Map();

    // Device pixel ratio for high-DPI displays
    this.devicePixelRatio = window.devicePixelRatio || 1;

    // Display scale (zoom level) - pages are re-rendered at this scale
    this.displayScale = options.initialScale || 1.0;

    // Rotation in degrees (0, 90, 180, 270)
    this.rotation = 0;

    // Scroll tracking for rendering priority
    this._lastScrollTop = 0;
    this._scrollDirection = "down";

    // Rendering queue for lazy loading
    this._renderingQueue = new RenderingQueue();
    this._renderingQueue.setViewer(this);

    // Scroll handling
    this._scrollHandler = this._onScroll.bind(this);
    this.container.addEventListener("scroll", this._scrollHandler);

    // Resize handling
    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(this.container);

    // Pinch-to-zoom for mobile devices
    this._setupPinchToZoom();

    // Text layer selection tracking (for multi-page selection)
    this._textLayers = new Map();
    this._setupGlobalSelectionListener();
  }

  /**
   * Load a PDF document from a URL.
   * @param {string} url - The PDF URL
   * @returns {Promise<PDFDocumentProxy>}
   */
  async load(url) {
    try {
      const loadingTask = pdfjsLib.getDocument(url);
      this.pdfDocument = await loadingTask.promise;
      this.pageCount = this.pdfDocument.numPages;

      // Clear any existing content
      this.container.innerHTML = "";
      this.pages.clear();

      // Set initial display scale on container
      this.container.style.setProperty("--display-scale", String(this.displayScale));

      // Create page placeholders for all pages
      await this._createPagePlaceholders();

      // Dispatch loaded event
      this.eventBus.dispatch(ViewerEvents.DOCUMENT_LOADED, {
        pageCount: this.pageCount,
        pdfDocument: this.pdfDocument
      });

      // Trigger initial render of visible pages
      this._renderingQueue.renderHighestPriority(this.getVisiblePages());

      return this.pdfDocument
    } catch (error) {
      console.error("Error loading PDF:", error);
      this.eventBus.dispatch(ViewerEvents.DOCUMENT_LOAD_ERROR, { error });
      throw error
    }
  }

  /**
   * Create placeholder containers for all pages with correct dimensions.
   * Pages are rendered lazily when they become visible.
   */
  async _createPagePlaceholders() {
    // Get first page to determine default dimensions
    const firstPage = await this.pdfDocument.getPage(1);
    const defaultViewport = firstPage.getViewport({ scale: 1.0, rotation: this.rotation });

    // Create all placeholders immediately with default dimensions
    // Actual dimensions will be set when each page is rendered
    for (let pageNum = 1; pageNum <= this.pageCount; pageNum++) {
      const pageContainer = document.createElement("div");
      pageContainer.className = "pdf-page";
      pageContainer.dataset.pageNumber = pageNum;

      // Use default dimensions (will be corrected when page renders)
      pageContainer.style.setProperty("--page-width", `${defaultViewport.width}px`);
      pageContainer.style.setProperty("--page-height", `${defaultViewport.height}px`);
      pageContainer.style.setProperty("--display-scale", String(this.displayScale));

      this.container.appendChild(pageContainer);

      // Store page data with INITIAL rendering state
      // page and unitViewport will be set when rendering
      this.pages.set(pageNum, {
        page: pageNum === 1 ? firstPage : null,
        container: pageContainer,
        unitViewport: pageNum === 1 ? defaultViewport : null,
        canvas: null,
        textLayer: null,
        renderingState: RenderingStates.INITIAL
      });
    }

    this.eventBus.dispatch(ViewerEvents.PAGES_LOADED, {
      pageCount: this.pageCount
    });
  }

  /**
   * Render a specific page.
   * Called by the rendering queue when a page needs to be rendered.
   * @param {number} pageNumber
   * @returns {Promise<void>}
   */
  async renderPage(pageNumber) {
    const pageData = this.pages.get(pageNumber);
    if (!pageData) return

    // Skip if already rendering
    if (pageData.renderingState === RenderingStates.RUNNING) {
      return
    }

    // If already rendered at current scale, skip
    if (pageData.renderingState === RenderingStates.FINISHED &&
        pageData.renderedScale === this.displayScale) {
      return
    }

    pageData.renderingState = RenderingStates.RUNNING;

    try {
      const { container } = pageData;

      // Load page if not already loaded
      let page = pageData.page;
      let unitViewport = pageData.unitViewport;

      if (!page) {
        page = await this.pdfDocument.getPage(pageNumber);
        unitViewport = page.getViewport({ scale: 1.0, rotation: this.rotation });
        pageData.page = page;
        pageData.unitViewport = unitViewport;

        // Update container dimensions if different from default
        container.style.setProperty("--page-width", `${unitViewport.width}px`);
        container.style.setProperty("--page-height", `${unitViewport.height}px`);
      }

      // Clear existing canvas if re-rendering at new scale
      if (pageData.canvas) {
        pageData.canvas.remove();
      }

      const dpr = this.devicePixelRatio;
      const displayScale = this.displayScale;

      // Get viewport at display scale (what we want to show on screen)
      const displayViewport = page.getViewport({ scale: displayScale, rotation: this.rotation });

      // Create canvas for PDF rendering
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-canvas";
      const context = canvas.getContext("2d");

      // Canvas CSS size fills the container (which is sized by CSS variables)
      canvas.style.width = "100%";
      canvas.style.height = "100%";

      // Canvas backing store = displayed size × devicePixelRatio (for retina crispness)
      const cssWidth = Math.round(displayViewport.width);
      const cssHeight = Math.round(displayViewport.height);
      canvas.width = Math.floor(cssWidth * dpr);
      canvas.height = Math.floor(cssHeight * dpr);

      container.appendChild(canvas);

      // Render PDF page at displayScale, with DPR transform for retina
      await page.render({
        canvasContext: context,
        viewport: displayViewport,
        transform: [dpr, 0, 0, dpr, 0, 0] // Scale drawing for retina
      }).promise;

      // Create or update text layer
      if (pageData.textLayer) {
        pageData.textLayer.remove();
      }

      const textLayerDiv = document.createElement("div");
      textLayerDiv.className = "textLayer";
      container.appendChild(textLayerDiv);

      // Render text layer at display scale
      const textContent = await page.getTextContent();
      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: textLayerDiv,
        viewport: displayViewport
      });
      await textLayer.render();

      // Add endOfContent element for selection handling
      const endOfContent = document.createElement("div");
      endOfContent.className = "endOfContent";
      textLayerDiv.appendChild(endOfContent);

      // Bind selection handling
      this._bindTextLayerSelection(textLayerDiv, endOfContent);

      // Update page data
      pageData.canvas = canvas;
      pageData.textLayer = textLayerDiv;
      pageData.displayViewport = displayViewport;
      pageData.renderedScale = displayScale;
      pageData.renderingState = RenderingStates.FINISHED;

      // Dispatch events
      this.eventBus.dispatch(ViewerEvents.PAGE_RENDERED, {
        pageNumber,
        canvas,
        container
      });

      this.eventBus.dispatch(ViewerEvents.TEXT_LAYER_RENDERED, {
        pageNumber,
        textLayer: textLayerDiv
      });

    } catch (error) {
      console.error(`Error rendering page ${pageNumber}:`, error);
      pageData.renderingState = RenderingStates.INITIAL;
      throw error
    }
  }

  /**
   * Get the currently visible pages in the scroll container.
   * Used by the rendering queue to prioritize rendering.
   * @returns {Object} - { first, last, scrollDirection }
   */
  getVisiblePages() {
    const containerRect = this.container.getBoundingClientRect();
    const scrollTop = this.container.scrollTop;
    const scrollBottom = scrollTop + containerRect.height;

    // If container has no height yet, return first page
    if (containerRect.height === 0) {
      return {
        first: 1,
        last: 1,
        scrollDirection: this._scrollDirection
      }
    }

    let first = null;
    let last = null;

    for (let pageNum = 1; pageNum <= this.pageCount; pageNum++) {
      const pageData = this.pages.get(pageNum);
      if (!pageData) continue

      const pageTop = pageData.container.offsetTop;
      // offsetHeight already includes CSS scaling, don't multiply again
      const pageHeight = pageData.container.offsetHeight;
      const pageBottom = pageTop + pageHeight;

      // Check if page intersects with visible area
      if (pageBottom > scrollTop && pageTop < scrollBottom) {
        if (first === null) first = pageNum;
        last = pageNum;
      } else if (first !== null) {
        // We've passed the visible area
        break
      }
    }

    return {
      first: first || 1,
      last: last || first || 1,
      scrollDirection: this._scrollDirection
    }
  }

  /**
   * Handle scroll events.
   */
  _onScroll() {
    // Only trigger rendering if document is loaded
    if (!this.pdfDocument) return

    const scrollTop = this.container.scrollTop;
    this._scrollDirection = scrollTop > this._lastScrollTop ? "down" : "up";
    this._lastScrollTop = scrollTop;

    this.eventBus.dispatch(ViewerEvents.SCROLL, {
      scrollTop,
      direction: this._scrollDirection
    });

    // Trigger rendering of visible pages
    this._renderingQueue.renderHighestPriority(this.getVisiblePages());
  }

  /**
   * Handle container resize.
   */
  _onResize() {
    // Only trigger rendering if document is loaded
    if (!this.pdfDocument) return

    // CSS handles most resize behavior, but we may need to re-evaluate visible pages
    this._renderingQueue.renderHighestPriority(this.getVisiblePages());
  }

  // ===== Scale / Zoom Methods =====

  /**
   * Get current display scale.
   * @returns {number}
   */
  getScale() {
    return this.displayScale
  }

  /**
   * Set zoom level by re-rendering pages at the new scale.
   * @param {number|string} scale - Numeric scale (e.g., 1.5) or ScaleValue constant
   */
  setScale(scale) {
    let newScale;

    if (typeof scale === "string") {
      newScale = this._calculateScale(scale);
    } else {
      newScale = scale;
    }

    if (newScale === this.displayScale) return

    // Capture scroll anchor point (center of viewport) before zoom
    // Only do this if user has scrolled - skip on initial load to keep top of document visible
    const scrollTop = this.container.scrollTop;
    const scrollLeft = this.container.scrollLeft;
    const shouldAnchor = scrollTop > 10; // Small threshold to avoid float imprecision

    let ratioY = 0, ratioX = 0;
    if (shouldAnchor) {
      const viewportCenterY = scrollTop + this.container.clientHeight / 2;
      const viewportCenterX = scrollLeft + this.container.clientWidth / 2;

      // Calculate position as ratio of total scrollable content
      const scrollHeight = this.container.scrollHeight;
      const scrollWidth = this.container.scrollWidth;
      ratioY = scrollHeight > 0 ? viewportCenterY / scrollHeight : 0;
      ratioX = scrollWidth > 0 ? viewportCenterX / scrollWidth : 0;
    }

    const previousScale = this.displayScale;
    this.displayScale = newScale;

    // Update CSS variable on container (still used for annotation layer scaling)
    this.container.style.setProperty("--display-scale", String(newScale));

    // Update page container dimensions and mark for re-render
    for (const pageData of this.pages.values()) {
      pageData.container.style.setProperty("--display-scale", String(newScale));

      // Mark pages for re-render at new scale (but keep FINISHED state for
      // dimension calculations - renderPage will check renderedScale)
    }

    this.eventBus.dispatch(ViewerEvents.SCALE_CHANGED, {
      scale: newScale,
      previousScale
    });

    // Restore scroll anchor position after CSS applies (only if user had scrolled)
    if (shouldAnchor) {
      requestAnimationFrame(() => {
        const newScrollHeight = this.container.scrollHeight;
        const newScrollWidth = this.container.scrollWidth;
        const newCenterY = ratioY * newScrollHeight;
        const newCenterX = ratioX * newScrollWidth;

        this.container.scrollTop = newCenterY - this.container.clientHeight / 2;
        this.container.scrollLeft = newCenterX - this.container.clientWidth / 2;
      });
    }

    // Re-render visible pages at the new scale
    this._renderingQueue.renderHighestPriority(this.getVisiblePages());
  }

  /**
   * Calculate scale value from string presets.
   * @param {string} preset - ScaleValue constant
   * @returns {number}
   */
  _calculateScale(preset) {
    const firstPage = this.pages.get(1);
    if (!firstPage) return 1.0

    // Get computed padding from the container
    const computedStyle = window.getComputedStyle(this.container);
    const paddingLeft = parseFloat(computedStyle.paddingLeft) || 0;
    const paddingRight = parseFloat(computedStyle.paddingRight) || 0;
    const paddingTop = parseFloat(computedStyle.paddingTop) || 0;
    const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0;

    // clientWidth/Height include padding, so we need to subtract it
    // to get the actual available space for the page
    const availableWidth = this.container.clientWidth - paddingLeft - paddingRight;
    const availableHeight = this.container.clientHeight - paddingTop - paddingBottom;

    const pageWidth = firstPage.unitViewport.width;
    const pageHeight = firstPage.unitViewport.height;

    switch (preset) {
      case ScaleValue.PAGE_WIDTH:
        // Fit page width to available space
        return availableWidth / pageWidth

      case ScaleValue.PAGE_FIT:
        // Fit entire page in available space
        const scaleX = availableWidth / pageWidth;
        const scaleY = availableHeight / pageHeight;
        return Math.min(scaleX, scaleY)

      case ScaleValue.AUTO:
        // Auto: page-width if portrait, page-fit if landscape
        if (pageWidth < pageHeight) {
          return availableWidth / pageWidth
        } else {
          const scaleX = availableWidth / pageWidth;
          const scaleY = availableHeight / pageHeight;
          return Math.min(scaleX, scaleY)
        }

      default:
        return 1.0
    }
  }

  // ===== Pinch-to-Zoom for Mobile =====

  /**
   * Set up pinch-to-zoom gesture handling for touch devices.
   */
  _setupPinchToZoom() {
    let initialDistance = 0;
    let initialScale = 1;
    let isPinching = false;

    const getDistance = (touch1, touch2) => {
      const dx = touch1.clientX - touch2.clientX;
      const dy = touch1.clientY - touch2.clientY;
      return Math.sqrt(dx * dx + dy * dy)
    };

    this.container.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        isPinching = true;
        initialDistance = getDistance(e.touches[0], e.touches[1]);
        initialScale = this.displayScale;
        // Prevent default to stop page scrolling during pinch
        e.preventDefault();
      }
    }, { passive: false });

    this.container.addEventListener("touchmove", (e) => {
      if (!isPinching || e.touches.length !== 2) return

      e.preventDefault();

      const currentDistance = getDistance(e.touches[0], e.touches[1]);
      const scaleFactor = currentDistance / initialDistance;
      let newScale = initialScale * scaleFactor;

      // Clamp scale to reasonable bounds
      const minScale = 0.25;
      const maxScale = 5;
      newScale = Math.max(minScale, Math.min(maxScale, newScale));

      // Only update if scale changed meaningfully
      if (Math.abs(newScale - this.displayScale) > 0.01) {
        this.setScale(newScale);
      }
    }, { passive: false });

    this.container.addEventListener("touchend", (e) => {
      if (e.touches.length < 2) {
        isPinching = false;
      }
    });

    this.container.addEventListener("touchcancel", () => {
      isPinching = false;
    });
  }

  // ===== Navigation Methods =====

  /**
   * Navigate to a specific page.
   * @param {number} pageNumber
   */
  goToPage(pageNumber) {
    // Ensure pageNumber is an integer
    pageNumber = parseInt(pageNumber, 10);

    if (pageNumber < 1 || pageNumber > this.pageCount) {
      return
    }

    const pageData = this.pages.get(pageNumber);
    if (!pageData || !pageData.container) {
      return
    }

    // Calculate scroll position relative to the scroll container (not the positioned parent)
    // offsetTop is relative to offsetParent which may include toolbar, so we need to
    // calculate relative to the scroll container
    const containerRect = this.container.getBoundingClientRect();
    const pageRect = pageData.container.getBoundingClientRect();

    // How far the page currently is from the top of the scroll container
    const pageOffsetFromContainer = pageRect.top - containerRect.top;

    // Add current scroll position to get absolute position, subtract padding for breathing room
    const targetScrollTop = this.container.scrollTop + pageOffsetFromContainer - 16;

    this.container.scrollTo({
      top: Math.max(0, targetScrollTop),
      behavior: "smooth"
    });

    this.eventBus.dispatch(ViewerEvents.PAGE_CHANGING, { pageNumber });
  }

  /**
   * Get the current page (the one most visible in the viewport).
   * Uses the page that occupies the most vertical space in the viewport.
   * @returns {number}
   */
  getCurrentPage() {
    if (!this.pdfDocument || this.pageCount === 0) {
      return 1
    }

    const containerRect = this.container.getBoundingClientRect();
    const containerTop = containerRect.top;
    const containerBottom = containerRect.bottom;
    containerRect.height;

    let bestPage = 1;
    let bestVisibleArea = 0;

    for (let pageNum = 1; pageNum <= this.pageCount; pageNum++) {
      const pageData = this.pages.get(pageNum);
      if (!pageData || !pageData.container) continue

      const pageRect = pageData.container.getBoundingClientRect();

      // Calculate how much of the page is visible in the container
      const visibleTop = Math.max(pageRect.top, containerTop);
      const visibleBottom = Math.min(pageRect.bottom, containerBottom);
      const visibleHeight = Math.max(0, visibleBottom - visibleTop);

      if (visibleHeight > bestVisibleArea) {
        bestVisibleArea = visibleHeight;
        bestPage = pageNum;
      }

      // If we've scrolled past this page entirely, we can stop checking
      if (pageRect.top > containerBottom) {
        break
      }
    }

    return bestPage
  }

  // ===== Accessor Methods =====

  getPageCount() {
    return this.pageCount
  }

  getPageContainer(pageNumber) {
    return this.pages.get(pageNumber)?.container
  }

  getPageCanvas(pageNumber) {
    return this.pages.get(pageNumber)?.canvas
  }

  getTextLayer(pageNumber) {
    return this.pages.get(pageNumber)?.textLayer
  }

  getPageHeight(pageNumber) {
    return this.pages.get(pageNumber)?.unitViewport?.height || 0
  }

  getPageWidth(pageNumber) {
    return this.pages.get(pageNumber)?.unitViewport?.width || 0
  }

  /**
   * Get page number from a DOM element within a page.
   * @param {HTMLElement} element
   * @returns {number|null}
   */
  getPageNumberFromElement(element) {
    const pageContainer = element.closest(".pdf-page");
    if (pageContainer) {
      return parseInt(pageContainer.dataset.pageNumber, 10)
    }
    return null
  }

  // ===== Coordinate Transformation =====

  /**
   * Convert screen coordinates to PDF page coordinates (unscaled).
   * @param {number} screenX
   * @param {number} screenY
   * @param {number} pageNumber
   * @returns {Object|null} - { x, y } in PDF coordinates
   */
  screenToPdfCoords(screenX, screenY, pageNumber) {
    const pageData = this.pages.get(pageNumber);
    if (!pageData) return null

    const rect = pageData.container.getBoundingClientRect();
    const x = (screenX - rect.left) / this.displayScale;
    const y = (screenY - rect.top) / this.displayScale;

    return { x, y }
  }

  /**
   * Convert PDF page coordinates to screen coordinates.
   * @param {number} pdfX
   * @param {number} pdfY
   * @param {number} pageNumber
   * @returns {Object|null} - { x, y } in screen coordinates
   */
  pdfToScreenCoords(pdfX, pdfY, pageNumber) {
    const pageData = this.pages.get(pageNumber);
    if (!pageData) return null

    const rect = pageData.container.getBoundingClientRect();
    const x = pdfX * this.displayScale + rect.left;
    const y = pdfY * this.displayScale + rect.top;

    return { x, y }
  }

  // ===== Text Layer Selection Handling =====

  /**
   * Detect iOS Safari which doesn't support ::selection styling
   */
  static _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)

  /**
   * Bind selection handling to a text layer.
   * Prevents selection jumping in non-Firefox browsers.
   */
  _bindTextLayerSelection(textLayerDiv, endOfContent) {
    this._textLayers.set(textLayerDiv, endOfContent);

    textLayerDiv.addEventListener("mousedown", () => {
      textLayerDiv.classList.add("selecting");
    });

    // Touch events for iOS selection handling
    textLayerDiv.addEventListener("touchstart", () => {
      textLayerDiv.classList.add("selecting");
    }, { passive: true });
  }

  /**
   * Create/update visible selection highlight overlays for iOS.
   * iOS Safari ignores ::selection CSS, so we need visible overlays.
   */
  _updateIOSSelectionHighlights() {
    // Remove existing iOS selection highlights
    this._clearIOSSelectionHighlights();

    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return
    }

    // Process each range in the selection
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);

      // Check if this range intersects any of our text layers
      for (const textLayerDiv of this._textLayers.keys()) {
        if (!range.intersectsNode(textLayerDiv)) continue

        const pageContainer = textLayerDiv.closest(".pdf-page");
        if (!pageContainer) continue

        // Get all client rects for the selection within this text layer
        const rects = range.getClientRects();
        const pageRect = pageContainer.getBoundingClientRect();

        for (const rect of rects) {
          // Skip if rect is outside the page or too small
          if (rect.width < 1 || rect.height < 1) continue
          if (rect.right < pageRect.left || rect.left > pageRect.right) continue
          if (rect.bottom < pageRect.top || rect.top > pageRect.bottom) continue

          // Create highlight element positioned relative to page
          const highlight = document.createElement("div");
          highlight.className = "ios-selection-highlight";
          highlight.style.cssText = `
            position: absolute;
            left: ${rect.left - pageRect.left}px;
            top: ${rect.top - pageRect.top}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            pointer-events: none;
            z-index: 5;
          `;
          pageContainer.appendChild(highlight);
        }
      }
    }
  }

  /**
   * Remove all iOS selection highlight overlays within this viewer
   */
  _clearIOSSelectionHighlights() {
    this.container.querySelectorAll(".ios-selection-highlight").forEach(el => el.remove());
  }

  /**
   * Set up global selection listener for cross-page text selection.
   */
  _setupGlobalSelectionListener() {
    let prevRange = null;
    let isPointerDown = false;

    const reset = (endDiv, textLayer) => {
      textLayer.append(endDiv);
      endDiv.style.width = "";
      endDiv.style.height = "";
      textLayer.classList.remove("selecting");
    };

    const clearSelection = () => {
      this._textLayers.forEach(reset);
      // Clear iOS selection highlights
      if (CoreViewer._isIOS) {
        this._clearIOSSelectionHighlights();
      }
    };

    document.addEventListener("pointerdown", () => {
      isPointerDown = true;
    });

    document.addEventListener("pointerup", () => {
      isPointerDown = false;
      clearSelection();
    });

    window.addEventListener("blur", () => {
      isPointerDown = false;
      clearSelection();
    });

    document.addEventListener("keyup", () => {
      if (!isPointerDown) {
        clearSelection();
      }
    });

    document.addEventListener("selectionchange", () => {
      // Early return if no text layers registered yet
      if (this._textLayers.size === 0) return

      const selection = document.getSelection();
      if (selection.rangeCount === 0) {
        clearSelection();
        return
      }

      // Find which text layers have active selections
      const activeTextLayers = new Set();
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        for (const textLayerDiv of this._textLayers.keys()) {
          if (!activeTextLayers.has(textLayerDiv) && range.intersectsNode(textLayerDiv)) {
            activeTextLayers.add(textLayerDiv);
          }
        }
      }

      for (const [textLayerDiv, endDiv] of this._textLayers) {
        if (activeTextLayers.has(textLayerDiv)) {
          textLayerDiv.classList.add("selecting");
        } else {
          reset(endDiv, textLayerDiv);
        }
      }

      // Move endOfContent to prevent selection jumping (non-Firefox browsers)
      const range = selection.getRangeAt(0);
      const modifyStart = prevRange && (
        range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
        range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0
      );

      let anchor = modifyStart ? range.startContainer : range.endContainer;
      if (anchor.nodeType === Node.TEXT_NODE) {
        anchor = anchor.parentNode;
      }

      if (!modifyStart && range.endOffset === 0) {
        while (anchor && !anchor.previousSibling) {
          anchor = anchor.parentNode;
        }
        if (anchor) {
          anchor = anchor.previousSibling;
          while (anchor && anchor.childNodes && anchor.childNodes.length) {
            anchor = anchor.lastChild;
          }
        }
      }

      if (anchor) {
        const parentTextLayer = anchor.parentElement?.closest(".textLayer");
        const endDiv = this._textLayers.get(parentTextLayer);
        if (endDiv && anchor.parentElement) {
          endDiv.style.width = parentTextLayer.style.width;
          endDiv.style.height = parentTextLayer.style.height;
          anchor.parentElement.insertBefore(
            endDiv,
            modifyStart ? anchor : anchor.nextSibling
          );
        }
      }

      prevRange = range.cloneRange();

      // Update iOS selection highlights (iOS Safari ignores ::selection CSS)
      if (CoreViewer._isIOS) {
        this._updateIOSSelectionHighlights();
      }
    });
  }

  // ===== Cleanup =====

  destroy() {
    // Remove event listeners
    this.container.removeEventListener("scroll", this._scrollHandler);
    this._resizeObserver.disconnect();

    // Clean up rendering queue
    this._renderingQueue.destroy();

    // Clean up PDF document
    if (this.pdfDocument) {
      this.pdfDocument.destroy();
      this.pdfDocument = null;
    }

    // Clean up event bus
    this.eventBus.destroy();

    // Clear container
    this.container.innerHTML = "";
    this.pages.clear();
    this._textLayers.clear();
  }
}

/**
 * Base class for annotation storage implementations.
 *
 * Subclasses must implement all methods to provide persistence for annotations.
 * The AnnotationManager delegates all storage operations to a store instance.
 *
 * @example
 * class MyCustomStore extends AnnotationStore {
 *   async load() { return fetch('/my-api/annotations').then(r => r.json()) }
 *   async create(data) { ... }
 *   // ... etc
 * }
 */
class AnnotationStore {
  /**
   * Load all annotations.
   * @returns {Promise<Array>} Array of annotation objects
   */
  async load() {
    throw new Error("AnnotationStore.load() not implemented")
  }

  /**
   * Create a new annotation.
   * @param {Object} data - Annotation data (without id)
   * @returns {Promise<Object>} Created annotation with server-assigned id
   */
  async create(data) {
    throw new Error("AnnotationStore.create() not implemented")
  }

  /**
   * Update an existing annotation.
   * @param {string|number} id - Annotation id
   * @param {Object} data - Fields to update
   * @returns {Promise<Object>} Updated annotation
   */
  async update(id, data) {
    throw new Error("AnnotationStore.update() not implemented")
  }

  /**
   * Delete an annotation.
   * @param {string|number} id - Annotation id
   * @returns {Promise<Object>} Deleted annotation
   */
  async delete(id) {
    throw new Error("AnnotationStore.delete() not implemented")
  }

  /**
   * Restore a soft-deleted annotation.
   * @param {string|number} id - Annotation id
   * @returns {Promise<Object>} Restored annotation
   */
  async restore(id) {
    throw new Error("AnnotationStore.restore() not implemented")
  }
}

/**
 * REST API annotation store with configurable URL patterns.
 *
 * By default, uses Rails-style REST conventions:
 * - GET    {baseUrl}.json           - load all
 * - POST   {baseUrl}                - create
 * - PATCH  {baseUrl}/{id}           - update
 * - DELETE {baseUrl}/{id}           - delete
 * - PATCH  {baseUrl}/{id}/restore   - restore
 *
 * URL patterns can be customized via function options:
 *
 * @example
 * // Rails default (just provide baseUrl)
 * new RestAnnotationStore({ baseUrl: '/documents/123/annotations' })
 *
 * @example
 * // Custom URL patterns
 * new RestAnnotationStore({
 *   baseUrl: '/api/annotations',
 *   loadUrl: () => '/api/annotations',  // no .json suffix
 *   updateUrl: (id) => `/api/annotations/${id}/edit`
 * })
 *
 * @example
 * // Fully custom URLs with closures
 * const docId = 123
 * new RestAnnotationStore({
 *   loadUrl: () => `/api/v2/documents/${docId}/annotations`,
 *   createUrl: () => `/api/v2/documents/${docId}/annotations`,
 *   updateUrl: (id) => `/api/v2/annotations/${id}`,
 *   deleteUrl: (id) => `/api/v2/annotations/${id}`,
 *   restoreUrl: (id) => `/api/v2/annotations/${id}/restore`
 * })
 */
class RestAnnotationStore extends AnnotationStore {
  /**
   * @param {Object} options
   * @param {string} [options.baseUrl] - Base URL for Rails-style defaults
   * @param {Function} [options.loadUrl] - () => string - URL for loading annotations
   * @param {Function} [options.createUrl] - () => string - URL for creating annotations
   * @param {Function} [options.updateUrl] - (id) => string - URL for updating annotations
   * @param {Function} [options.deleteUrl] - (id) => string - URL for deleting annotations
   * @param {Function} [options.restoreUrl] - (id) => string - URL for restoring annotations
   */
  constructor(options = {}) {
    super();
    this.baseUrl = options.baseUrl;

    // Function-based URL builders with Rails-style defaults
    this.getLoadUrl = options.loadUrl || (() => `${this.baseUrl}.json`);
    this.getCreateUrl = options.createUrl || (() => this.baseUrl);
    this.getUpdateUrl = options.updateUrl || ((id) => `${this.baseUrl}/${id}`);
    this.getDeleteUrl = options.deleteUrl || ((id) => `${this.baseUrl}/${id}`);
    this.getRestoreUrl = options.restoreUrl || ((id) => `${this.baseUrl}/${id}/restore`);
  }

  async load() {
    const request = new FetchRequest("get", this.getLoadUrl());
    const response = await request.perform();

    if (response.ok) {
      return await response.json
    } else {
      throw new Error("Failed to load annotations")
    }
  }

  async create(data) {
    const request = new FetchRequest("post", this.getCreateUrl(), {
      body: JSON.stringify({ annotation: data }),
      contentType: "application/json",
      responseKind: "json"
    });

    const response = await request.perform();

    if (response.ok) {
      return await response.json
    } else {
      throw new Error("Failed to create annotation")
    }
  }

  async update(id, data) {
    const request = new FetchRequest("patch", this.getUpdateUrl(id), {
      body: JSON.stringify({ annotation: data }),
      contentType: "application/json",
      responseKind: "json"
    });

    const response = await request.perform();

    if (response.ok) {
      return await response.json
    } else {
      throw new Error("Failed to update annotation")
    }
  }

  async delete(id) {
    const request = new FetchRequest("delete", this.getDeleteUrl(id), {
      responseKind: "json"
    });

    const response = await request.perform();

    if (response.ok) {
      return await response.json
    } else {
      throw new Error("Failed to delete annotation")
    }
  }

  async restore(id) {
    const request = new FetchRequest("patch", this.getRestoreUrl(id), {
      responseKind: "json"
    });

    const response = await request.perform();

    if (response.ok) {
      return await response.json
    } else {
      throw new Error("Failed to restore annotation")
    }
  }
}

/**
 * In-memory annotation store for development and demo purposes.
 *
 * Annotations are stored in memory only and lost on page refresh.
 * Useful for:
 * - Local development without a backend
 * - Demo/preview modes
 * - Testing
 *
 * @example
 * new MemoryAnnotationStore()
 */
class MemoryAnnotationStore extends AnnotationStore {
  constructor() {
    super();
    this._annotations = [];
    this._nextId = 1;
  }

  async load() {
    return [...this._annotations]
  }

  async create(data) {
    const annotation = {
      ...data,
      id: `local-${this._nextId++}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    this._annotations.push(annotation);
    return annotation
  }

  async update(id, data) {
    const index = this._annotations.findIndex(a => a.id === id);
    if (index === -1) {
      throw new Error("Annotation not found")
    }

    const annotation = {
      ...this._annotations[index],
      ...data,
      id, // Preserve original id
      updated_at: new Date().toISOString()
    };

    this._annotations[index] = annotation;
    return annotation
  }

  async delete(id) {
    const index = this._annotations.findIndex(a => a.id === id);
    if (index === -1) {
      throw new Error("Annotation not found")
    }

    const [annotation] = this._annotations.splice(index, 1);
    return annotation
  }

  async restore(id) {
    // Memory store doesn't support soft-delete/restore
    console.warn("MemoryAnnotationStore.restore() is not supported");
    return null
  }
}

// Custom event types for error handling
const AnnotationErrorType = {
  LOAD_FAILED: "load_failed",
  CREATE_FAILED: "create_failed",
  UPDATE_FAILED: "update_failed",
  DELETE_FAILED: "delete_failed",
  RESTORE_FAILED: "restore_failed"
};

class AnnotationManager {
  /**
   * @param {Object} options
   * @param {AnnotationStore} [options.store] - Custom store implementation
   * @param {string} [options.annotationsUrl] - Base URL for REST store (creates RestAnnotationStore)
   * @param {number} [options.documentId] - Document ID
   * @param {Function} [options.onAnnotationCreated] - Callback when annotation created
   * @param {Function} [options.onAnnotationUpdated] - Callback when annotation updated
   * @param {Function} [options.onAnnotationDeleted] - Callback when annotation deleted
   * @param {Element} [options.eventTarget] - Element for dispatching error events
   */
  constructor(options = {}) {
    this.documentId = options.documentId;
    this.onAnnotationCreated = options.onAnnotationCreated;
    this.onAnnotationUpdated = options.onAnnotationUpdated;
    this.onAnnotationDeleted = options.onAnnotationDeleted;
    this.eventTarget = options.eventTarget;

    // Determine store: explicit > REST URL > memory
    if (options.store) {
      this.store = options.store;
    } else if (options.annotationsUrl) {
      this.store = new RestAnnotationStore({ baseUrl: options.annotationsUrl });
    } else {
      this.store = new MemoryAnnotationStore();
    }

    this.annotations = new Map(); // id -> annotation
    this.annotationsByPage = new Map(); // pageNumber -> [annotations]
  }

  /**
   * Dispatch an error event for UI feedback and logging.
   */
  _dispatchError(errorType, message, originalError) {
    if (this.eventTarget) {
      this.eventTarget.dispatchEvent(new CustomEvent("pdf-viewer:error", {
        bubbles: true,
        detail: {
          source: "annotation_manager",
          errorType,
          message,
          error: originalError
        }
      }));
    }
  }

  async loadAnnotations() {
    try {
      const annotations = await this.store.load();
      this._processAnnotations(annotations);
    } catch (error) {
      console.error("Failed to load annotations:", error);
      this._dispatchError(AnnotationErrorType.LOAD_FAILED, "Failed to load annotations", error);
      throw error
    }
  }

  _processAnnotations(annotationsData) {
    this.annotations.clear();
    this.annotationsByPage.clear();

    for (const annotation of annotationsData) {
      this.annotations.set(annotation.id, annotation);

      if (!this.annotationsByPage.has(annotation.page)) {
        this.annotationsByPage.set(annotation.page, []);
      }
      this.annotationsByPage.get(annotation.page).push(annotation);
    }
  }

  getAnnotation(id) {
    return this.annotations.get(id)
  }

  getAnnotationsForPage(pageNumber) {
    return this.annotationsByPage.get(pageNumber) || []
  }

  getAllAnnotations() {
    return Array.from(this.annotations.values())
  }

  async createAnnotation(data) {
    try {
      const annotation = await this.store.create(data);
      this._addAnnotation(annotation);

      if (this.onAnnotationCreated) {
        this.onAnnotationCreated(annotation);
      }

      return annotation
    } catch (error) {
      console.error("Failed to create annotation:", error);
      this._dispatchError(AnnotationErrorType.CREATE_FAILED, "Failed to save annotation", error);
      throw error
    }
  }

  async updateAnnotation(id, data) {
    try {
      const annotation = await this.store.update(id, data);
      this._updateAnnotation(annotation);

      if (this.onAnnotationUpdated) {
        this.onAnnotationUpdated(annotation);
      }

      return annotation
    } catch (error) {
      console.error("Failed to update annotation:", error);
      this._dispatchError(AnnotationErrorType.UPDATE_FAILED, "Failed to update annotation", error);
      throw error
    }
  }

  async deleteAnnotation(id) {
    const existingAnnotation = this.annotations.get(id);
    if (!existingAnnotation) return

    try {
      const annotation = await this.store.delete(id);
      this._removeAnnotation(id);

      if (this.onAnnotationDeleted) {
        this.onAnnotationDeleted(existingAnnotation);
      }

      return existingAnnotation
    } catch (error) {
      console.error("Failed to delete annotation:", error);
      this._dispatchError(AnnotationErrorType.DELETE_FAILED, "Failed to delete annotation", error);
      throw error
    }
  }

  async restoreAnnotation(id) {
    try {
      const annotation = await this.store.restore(id);
      if (!annotation) return null

      this._addAnnotation(annotation);

      if (this.onAnnotationCreated) {
        this.onAnnotationCreated(annotation);
      }

      return annotation
    } catch (error) {
      console.error("Failed to restore annotation:", error);
      this._dispatchError(AnnotationErrorType.RESTORE_FAILED, "Failed to restore annotation", error);
      throw error
    }
  }

  _addAnnotation(annotation) {
    this.annotations.set(annotation.id, annotation);

    if (!this.annotationsByPage.has(annotation.page)) {
      this.annotationsByPage.set(annotation.page, []);
    }
    this.annotationsByPage.get(annotation.page).push(annotation);
  }

  _updateAnnotation(annotation) {
    const oldAnnotation = this.annotations.get(annotation.id);
    if (!oldAnnotation) {
      this._addAnnotation(annotation);
      return
    }

    // Remove from old page if page changed
    if (oldAnnotation.page !== annotation.page) {
      this._removeAnnotationFromPage(oldAnnotation.id, oldAnnotation.page);

      if (!this.annotationsByPage.has(annotation.page)) {
        this.annotationsByPage.set(annotation.page, []);
      }
      this.annotationsByPage.get(annotation.page).push(annotation);
    } else {
      // Update in place
      const pageAnnotations = this.annotationsByPage.get(annotation.page);
      const index = pageAnnotations.findIndex(a => a.id === annotation.id);
      if (index !== -1) {
        pageAnnotations[index] = annotation;
      }
    }

    this.annotations.set(annotation.id, annotation);
  }

  _removeAnnotation(id) {
    const annotation = this.annotations.get(id);
    if (!annotation) return

    this._removeAnnotationFromPage(id, annotation.page);
    this.annotations.delete(id);
  }

  _removeAnnotationFromPage(id, pageNumber) {
    const pageAnnotations = this.annotationsByPage.get(pageNumber);
    if (pageAnnotations) {
      const index = pageAnnotations.findIndex(a => a.id === id);
      if (index !== -1) {
        pageAnnotations.splice(index, 1);
      }
    }
  }
}

class Watermark {
  constructor(userName) {
    this.userName = userName;
  }

  // Apply watermark to canvas
  // scale: the scale at which the canvas is rendered (e.g., 2.0 for high DPI)
  applyToPage(canvas, scale = 2.0) {
    if (!this.userName) return

    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;

    // Draw diagonal watermark (center of page)
    this._drawDiagonalWatermark(ctx, width, height, scale);

    // Draw header watermark
    this._drawHeaderWatermark(ctx, width, scale);
  }

  _drawDiagonalWatermark(ctx, width, height, scale) {
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate(-Math.PI / 4); // -45 degrees

    // Scale font size to match canvas resolution
    const fontSize = 25 * scale;
    ctx.font = `${fontSize}px sans-serif`;
    ctx.fillStyle = "rgba(0, 0, 0, 0.07)"; // 7% opacity
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(this.userName, 0, 0);

    ctx.restore();
  }

  _drawHeaderWatermark(ctx, width, scale) {
    ctx.save();

    // Scale font size and offset to match canvas resolution
    const fontSize = 6 * scale;
    const topOffset = 5 * scale;
    ctx.font = `${fontSize}px sans-serif`;
    ctx.fillStyle = "rgba(0, 0, 0, 0.10)"; // 10% opacity
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(this.userName, width / 2, topOffset);

    ctx.restore();
  }
}

class DownloadManager {
  constructor(options = {}) {
    this.documentUrl = options.documentUrl;
    this.documentName = options.documentName;
    this.organizationName = options.organizationName;
    this.userName = options.userName;
    this.annotationManager = options.annotationManager;
    this.producer = options.producer || "stimulus-pdf-viewer";
    this._extGStateCache = new Map();
  }

  async downloadWithAnnotations() {
    // Clear cache for fresh download
    this._extGStateCache.clear();

    // Fetch original PDF using Rails request.js for consistent CSRF handling
    const request = new FetchRequest("get", this.documentUrl, { responseKind: "blob" });
    const response = await request.perform();
    const existingPdfBytes = await response.response.arrayBuffer();
    const pdfDoc = await PDFDocument.load(existingPdfBytes);

    // Set document metadata
    this._setDocumentMetadata(pdfDoc);

    // Get all annotations
    const annotations = this.annotationManager.getAllAnnotations();

    // Embed font for watermark
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // Process each page
    const pages = pdfDoc.getPages();
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const pageNumber = i + 1;
      const { width, height } = page.getSize();

      // Apply watermark
      this._applyWatermarkToPage(page, font, width, height);

      // Apply annotations for this page
      const pageAnnotations = annotations.filter(a => a.page === pageNumber);
      this._applyAnnotationsToPage(pdfDoc, page, pageAnnotations, height);
    }

    // Save and download
    const pdfBytes = await pdfDoc.save();
    const filename = this._sanitizeFilename(this.documentName || "document");
    this._triggerDownload(pdfBytes, filename);
  }

  _applyWatermarkToPage(page, font, width, height) {
    if (!this.userName) return

    // Diagonal watermark
    page.drawText(this.userName, {
      x: width / 2 - 50,
      y: height / 2,
      size: 25,
      font: font,
      color: rgb(0, 0, 0),
      opacity: 0.07,
      rotate: degrees(-45)
    });

    // Header watermark
    const textWidth = font.widthOfTextAtSize(this.userName, 6);
    page.drawText(this.userName, {
      x: (width - textWidth) / 2,
      y: height - 10,
      size: 6,
      font: font,
      color: rgb(0, 0, 0),
      opacity: 0.10
    });
  }

  _applyAnnotationsToPage(pdfDoc, page, annotations, pageHeight) {
    for (const annotation of annotations) {
      switch (annotation.annotation_type) {
        case "highlight":
          this._applyHighlight(pdfDoc, page, annotation, pageHeight);
          break
        case "underline":
          this._applyUnderline(pdfDoc, page, annotation, pageHeight);
          break
        case "ink":
          this._applyInk(pdfDoc, page, annotation, pageHeight);
          break
        case "note":
          this._applyNote(pdfDoc, page, annotation, pageHeight);
          break
      }
    }
  }

  _applyHighlight(pdfDoc, page, annotation, pageHeight) {
    const { quads, color } = annotation;
    if (!quads || quads.length === 0) return

    const rgba = this._parseColor(color);

    // Build QuadPoints array - PDF format is [x1,y1,x2,y2,x3,y3,x4,y4] for each quad
    // Order: bottom-left, bottom-right, top-right, top-left (counter-clockwise from bottom-left)
    const quadPoints = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const quad of quads) {
      // Convert from top-left origin to bottom-left
      const points = [
        quad.p3.x, pageHeight - quad.p3.y, // bottom-left
        quad.p4.x, pageHeight - quad.p4.y, // bottom-right
        quad.p2.x, pageHeight - quad.p2.y, // top-right
        quad.p1.x, pageHeight - quad.p1.y, // top-left
      ];
      quadPoints.push(...points);

      // Track bounding box for Rect
      for (let i = 0; i < points.length; i += 2) {
        minX = Math.min(minX, points[i]);
        maxX = Math.max(maxX, points[i]);
        minY = Math.min(minY, points[i + 1]);
        maxY = Math.max(maxY, points[i + 1]);
      }
    }

    const annotationDict = pdfDoc.context.obj({
      Type: PDFName.of("Annot"),
      Subtype: PDFName.of("Highlight"),
      Rect: [minX, minY, maxX, maxY],
      QuadPoints: quadPoints,
      C: [rgba.r, rgba.g, rgba.b],
      CA: 0.4,
      F: 4,
      ...this._getAnnotationMetadata(annotation),
    });

    this._addAnnotationToPage(pdfDoc, page, annotationDict);
  }

  _applyUnderline(pdfDoc, page, annotation, pageHeight) {
    const { quads, color } = annotation;
    if (!quads || quads.length === 0) return

    const rgba = this._parseColor(color);

    // Build QuadPoints array - same format as highlight
    const quadPoints = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const quad of quads) {
      const points = [
        quad.p3.x, pageHeight - quad.p3.y,
        quad.p4.x, pageHeight - quad.p4.y,
        quad.p2.x, pageHeight - quad.p2.y,
        quad.p1.x, pageHeight - quad.p1.y,
      ];
      quadPoints.push(...points);

      for (let i = 0; i < points.length; i += 2) {
        minX = Math.min(minX, points[i]);
        maxX = Math.max(maxX, points[i]);
        minY = Math.min(minY, points[i + 1]);
        maxY = Math.max(maxY, points[i + 1]);
      }
    }

    const annotationDict = pdfDoc.context.obj({
      Type: PDFName.of("Annot"),
      Subtype: PDFName.of("Underline"),
      Rect: [minX, minY, maxX, maxY],
      QuadPoints: quadPoints,
      C: [rgba.r, rgba.g, rgba.b],
      F: 4,
      ...this._getAnnotationMetadata(annotation),
    });

    this._addAnnotationToPage(pdfDoc, page, annotationDict);
  }

  _applyInk(pdfDoc, page, annotation, pageHeight) {
    // Freehand highlights need different rendering (thick, semi-transparent strokes)
    if (annotation.subject === "Free Highlight") {
      this._applyFreehandHighlight(pdfDoc, page, annotation, pageHeight);
      return
    }

    const { ink_strokes, color } = annotation;
    if (!ink_strokes || ink_strokes.length === 0) return

    const rgba = this._parseColor(color);
    const strokeWidth = 2;

    // Build InkList and track bounding box
    const inkList = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const stroke of ink_strokes) {
      const points = stroke.points || [];
      if (points.length < 2) continue

      const pathPoints = [];
      for (const point of points) {
        const pdfX = point.x;
        const pdfY = pageHeight - point.y;
        pathPoints.push(pdfX, pdfY);

        minX = Math.min(minX, pdfX);
        maxX = Math.max(maxX, pdfX);
        minY = Math.min(minY, pdfY);
        maxY = Math.max(maxY, pdfY);
      }
      inkList.push(pathPoints);
    }

    if (inkList.length === 0) return

    // Add padding to bounding box for stroke width
    const padding = strokeWidth + 2;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;

    // Build appearance stream content (PDF drawing commands)
    // Coordinates in appearance stream are relative to the BBox origin
    let streamContent = `${strokeWidth} w 1 J 1 j `; // width, round line cap, round line join
    streamContent += `${rgba.r} ${rgba.g} ${rgba.b} RG `; // stroke color

    for (const pathPoints of inkList) {
      for (let i = 0; i < pathPoints.length; i += 2) {
        // Translate to appearance stream coordinates (relative to minX, minY)
        const x = pathPoints[i] - minX;
        const y = pathPoints[i + 1] - minY;
        if (i === 0) {
          streamContent += `${x.toFixed(2)} ${y.toFixed(2)} m `; // moveto
        } else {
          streamContent += `${x.toFixed(2)} ${y.toFixed(2)} l `; // lineto
        }
      }
      streamContent += "S "; // stroke
    }

    // Create the appearance stream (Form XObject)
    const appearanceStream = pdfDoc.context.stream(streamContent, {
      Type: PDFName.of("XObject"),
      Subtype: PDFName.of("Form"),
      FormType: 1,
      BBox: [0, 0, maxX - minX, maxY - minY],
    });
    const appearanceRef = pdfDoc.context.register(appearanceStream);

    const annotationDict = pdfDoc.context.obj({
      Type: PDFName.of("Annot"),
      Subtype: PDFName.of("Ink"),
      Rect: [minX, minY, maxX, maxY],
      InkList: inkList,
      C: [rgba.r, rgba.g, rgba.b],
      BS: { W: strokeWidth, LC: 1 },
      F: 4,
      AP: { N: appearanceRef },
      ...this._getAnnotationMetadata(annotation),
    });

    this._addAnnotationToPage(pdfDoc, page, annotationDict);
  }

  _applyFreehandHighlight(pdfDoc, page, annotation, pageHeight) {
    const { ink_strokes, color } = annotation;
    if (!ink_strokes || ink_strokes.length === 0) return

    const rgba = this._parseColor(color);
    const strokeWidth = annotation.thickness || 24;
    const opacity = annotation.opacity || 0.2;

    // Build path and track bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const paths = [];

    for (const stroke of ink_strokes) {
      const points = stroke.points || [];
      if (points.length < 2) continue

      const pathPoints = [];
      for (const point of points) {
        const pdfX = point.x;
        const pdfY = pageHeight - point.y;
        pathPoints.push({ x: pdfX, y: pdfY });

        minX = Math.min(minX, pdfX);
        maxX = Math.max(maxX, pdfX);
        minY = Math.min(minY, pdfY);
        maxY = Math.max(maxY, pdfY);
      }
      paths.push(pathPoints);
    }

    if (paths.length === 0) return

    // Add padding for stroke width
    const padding = strokeWidth / 2 + 2;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;

    // Build appearance stream with transparency
    // Use graphics state for opacity
    let streamContent = `/GS1 gs `; // Use graphics state with opacity
    streamContent += `${strokeWidth} w 1 J 1 j `; // width, round line cap, round line join
    streamContent += `${rgba.r} ${rgba.g} ${rgba.b} RG `; // stroke color

    for (const pathPoints of paths) {
      for (let i = 0; i < pathPoints.length; i++) {
        const x = (pathPoints[i].x - minX).toFixed(2);
        const y = (pathPoints[i].y - minY).toFixed(2);
        if (i === 0) {
          streamContent += `${x} ${y} m `; // moveto
        } else {
          streamContent += `${x} ${y} l `; // lineto
        }
      }
      streamContent += "S "; // stroke
    }

    // Get cached graphics state for transparency and blend mode
    const gsRef = this._getExtGState(pdfDoc, { opacity });

    // Create resources dictionary with the graphics state
    const resourcesDict = pdfDoc.context.obj({
      ExtGState: { GS1: gsRef },
    });

    // Create the appearance stream
    const appearanceStream = pdfDoc.context.stream(streamContent, {
      Type: PDFName.of("XObject"),
      Subtype: PDFName.of("Form"),
      FormType: 1,
      BBox: [0, 0, maxX - minX, maxY - minY],
      Resources: resourcesDict,
    });
    const appearanceRef = pdfDoc.context.register(appearanceStream);

    // Build InkList for the annotation structure
    const inkList = paths.map(pathPoints =>
      pathPoints.flatMap(p => [p.x, p.y])
    );

    const annotationDict = pdfDoc.context.obj({
      Type: PDFName.of("Annot"),
      Subtype: PDFName.of("Ink"),
      Rect: [minX, minY, maxX, maxY],
      InkList: inkList,
      C: [rgba.r, rgba.g, rgba.b],
      CA: opacity,
      BS: { W: strokeWidth, LC: 1 },
      F: 4,
      AP: { N: appearanceRef },
      ...this._getAnnotationMetadata(annotation),
    });

    this._addAnnotationToPage(pdfDoc, page, annotationDict);
  }

  _applyNote(pdfDoc, page, annotation, pageHeight) {
    const { rect, contents, color } = annotation;
    if (!rect || !contents) return

    const rgba = this._parseColor(color);
    const [x, y] = rect;
    // Convert from top-left origin to bottom-left (PDF uses bottom-left)
    const pdfY = pageHeight - y;
    const iconSize = 24;

    const annotationDict = pdfDoc.context.obj({
      Type: PDFName.of("Annot"),
      Subtype: PDFName.of("Text"),
      Rect: [x, pdfY - iconSize, x + iconSize, pdfY],
      Contents: PDFString.of(contents),
      C: [rgba.r, rgba.g, rgba.b],
      Name: PDFName.of("Comment"),
      Open: false,
      F: 4,
      ...this._getAnnotationMetadata(annotation),
    });

    this._addAnnotationToPage(pdfDoc, page, annotationDict);
  }

  _getExtGState(pdfDoc, { opacity, blendMode = "Multiply" }) {
    const key = `${opacity}:${blendMode}`;
    if (this._extGStateCache.has(key)) {
      return this._extGStateCache.get(key)
    }

    const gsDict = pdfDoc.context.obj({
      Type: PDFName.of("ExtGState"),
      CA: opacity,
      ca: opacity,
      BM: PDFName.of(blendMode),
    });

    const gsRef = pdfDoc.context.register(gsDict);
    this._extGStateCache.set(key, gsRef);
    return gsRef
  }

  _addAnnotationToPage(pdfDoc, page, annotationDict) {
    const annotationRef = pdfDoc.context.register(annotationDict);
    const pageDict = page.node;
    let annotsArray = pageDict.lookup(PDFName.of("Annots"));

    if (annotsArray instanceof PDFArray) {
      annotsArray.push(annotationRef);
    } else {
      const newAnnotsArray = pdfDoc.context.obj([annotationRef]);
      pageDict.set(PDFName.of("Annots"), newAnnotsArray);
    }
  }

  _setDocumentMetadata(pdfDoc) {
    if (this.documentName) {
      pdfDoc.setTitle(this.documentName);
    }
    if (this.userName) {
      pdfDoc.setAuthor(this.userName);
    }
    if (this.organizationName) {
      pdfDoc.setCreator(this.organizationName);
    }
    pdfDoc.setProducer(this.producer);
    pdfDoc.setModificationDate(new Date());
  }

  _getAnnotationMetadata(annotation) {
    const metadata = {};

    // Author (T = title/author in PDF spec)
    if (this.userName) {
      metadata.T = PDFString.of(this.userName);
    }

    // Modification date (M) - use annotation's updated_at or created_at
    const dateStr = annotation.updated_at || annotation.created_at;
    if (dateStr) {
      metadata.M = PDFString.of(this._formatPdfDate(new Date(dateStr)));
    }

    // Creation date
    if (annotation.created_at) {
      metadata.CreationDate = PDFString.of(this._formatPdfDate(new Date(annotation.created_at)));
    }

    return metadata
  }

  _formatPdfDate(date) {
    // PDF date format: D:YYYYMMDDHHmmssOHH'mm'
    const pad = (n) => n.toString().padStart(2, "0");

    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());

    // Timezone offset
    const tzOffset = date.getTimezoneOffset();
    const tzSign = tzOffset <= 0 ? "+" : "-";
    const tzHours = pad(Math.floor(Math.abs(tzOffset) / 60));
    const tzMinutes = pad(Math.abs(tzOffset) % 60);

    return `D:${year}${month}${day}${hours}${minutes}${seconds}${tzSign}${tzHours}'${tzMinutes}'`
  }

  _parseColor(colorStr) {
    if (!colorStr) {
      return { r: 1, g: 1, b: 0, a: 1 } // Default yellow
    }

    // Handle #RRGGBB or #RRGGBBAA format
    const hex = colorStr.replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;

    return { r, g, b, a }
  }

  setDownloadBridge(bridge) {
    this._downloadBridge = bridge;
  }

  _sanitizeFilename(name) {
    // Remove or replace characters that are problematic in filenames
    let sanitized = name
      .replace(/[<>:"/\\|?*]/g, "") // Remove illegal characters
      .replace(/\s+/g, " ")          // Normalize whitespace
      .trim();

    // Ensure it ends with .pdf
    if (!sanitized.toLowerCase().endsWith(".pdf")) {
      sanitized += ".pdf";
    }

    return sanitized || "document.pdf"
  }

  _triggerDownload(bytes, filename) {
    const blob = new Blob([bytes], { type: "application/pdf" });

    if (this._downloadBridge?.enabled) {
      this._downloadBridge.downloadBlob(blob, filename);
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Shared SVG icons for the PDF viewer UI components.
 *
 * Usage:
 *   import { Icons } from "stimulus-pdf-viewer"
 *   element.innerHTML = Icons.close
 *
 * Icons use width="16" height="16" by default. Override with CSS if needed.
 */

const Icons = {
  // Close/X icon - used in sidebars, find bar, undo bar
  close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>`,

  // Delete/Trash icon - used in annotation popup, edit toolbar
  delete: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  </svg>`,

  // Edit/Pencil icon - used in annotation popup
  edit: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>`,

  // Comment/Speech bubble icon - used in annotation edit toolbar
  comment: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>`,

  // Chevron down - used in color pickers, dropdowns
  chevronDown: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
    <polyline points="6 9 12 15 18 9"/>
  </svg>`,

  // Chevron up - used in find bar navigation
  chevronUp: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="18 15 12 9 6 15"/>
  </svg>`,

  // Chevron right - used in annotation sidebar
  chevronRight: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="9 18 15 12 9 6"/>
  </svg>`
};

class ColorPicker {
  static COLORS = [
    { name: "Orange", value: "#FFA500" },
    { name: "Yellow", value: "#FFFF00" },
    { name: "Green", value: "#00FF00" },
    { name: "Blue", value: "#00BFFF" },
    { name: "Pink", value: "#FF69B4" }
  ]

  // Default colors for different tool modes
  static DEFAULT_HIGHLIGHT_COLOR = "#FFA500" // Orange
  static DEFAULT_INK_COLOR = "#00BFFF" // Blue

  constructor(options = {}) {
    this.onChange = options.onChange;
    this.currentColor = ColorPicker.DEFAULT_HIGHLIGHT_COLOR;
    this.isOpen = false;

    this._createUI();
    this._setupEventListeners();
  }

  _createUI() {
    this.element = document.createElement("div");
    this.element.className = "color-picker";
    this.element.innerHTML = `
      <button class="color-picker-toggle" aria-label="Select color" aria-expanded="false">
        <span class="color-picker-swatch" style="background-color: ${this.currentColor}"></span>
        ${Icons.chevronDown}
      </button>
      <div class="color-picker-dropdown hidden">
        ${ColorPicker.COLORS.map(color => `
          <button class="color-picker-option ${color.value === this.currentColor ? 'selected' : ''}"
                  data-color="${color.value}"
                  aria-label="${color.name}"
                  title="${color.name}">
            <span class="color-picker-swatch" style="background-color: ${color.value}"></span>
          </button>
        `).join("")}
      </div>
    `;
  }

  /**
   * Render the color picker into a container.
   */
  render(container) {
    container.appendChild(this.element);
  }

  _setupEventListeners() {
    const toggle = this.element.querySelector(".color-picker-toggle");
    const dropdown = this.element.querySelector(".color-picker-dropdown");
    const options = this.element.querySelectorAll(".color-picker-option");

    // Toggle dropdown
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      this.isOpen = !this.isOpen;
      dropdown.classList.toggle("hidden", !this.isOpen);
      toggle.setAttribute("aria-expanded", this.isOpen);
    });

    // Color selection
    options.forEach(option => {
      option.addEventListener("click", (e) => {
        e.stopPropagation();
        const color = option.dataset.color;
        this.setColor(color);
        this._closeDropdown();
      });
    });

    // Close on outside click
    document.addEventListener("click", () => {
      if (this.isOpen) {
        this._closeDropdown();
      }
    });
  }

  _closeDropdown() {
    this.isOpen = false;
    const dropdown = this.element.querySelector(".color-picker-dropdown");
    const toggle = this.element.querySelector(".color-picker-toggle");
    dropdown.classList.add("hidden");
    toggle.setAttribute("aria-expanded", "false");
  }

  setColor(color) {
    this.currentColor = color;

    // Update toggle swatch
    const toggleSwatch = this.element.querySelector(".color-picker-toggle .color-picker-swatch");
    toggleSwatch.style.backgroundColor = color;

    // Update selected state
    const options = this.element.querySelectorAll(".color-picker-option");
    options.forEach(option => {
      option.classList.toggle("selected", option.dataset.color === color);
    });

    // Notify listeners
    if (this.onChange) {
      this.onChange(color);
    }
  }

  getColor() {
    return this.currentColor
  }
}

class AnnotationEditToolbar {
  constructor(options = {}) {
    this.onColorChange = options.onColorChange;
    this.onDelete = options.onDelete;
    this.onEdit = options.onEdit;
    this.onComment = options.onComment;
    this.onDeselect = options.onDeselect;
    this.colors = options.colors || ColorPicker.COLORS.map(c => c.value);

    this.currentAnnotation = null;
    this.element = null;
    this.colorDropdownOpen = false;

    this._createToolbar();
    this._setupEventListeners();
  }

  _createToolbar() {
    this.element = document.createElement("div");
    this.element.className = "annotation-edit-toolbar hidden";
    this.element.innerHTML = `
      <div class="toolbar-buttons">
        <button class="toolbar-btn comment-btn hidden" title="Add Comment (C)">
          ${Icons.comment}
        </button>
        <button class="color-picker-btn" title="Change color" aria-haspopup="true" aria-expanded="false">
          <span class="color-swatch"></span>
          ${Icons.chevronDown}
        </button>
        <div class="color-dropdown hidden">
          ${this.colors.map(color => `
            <button class="color-option" data-color="${color}" aria-selected="false">
              <span class="color-swatch" style="background-color: ${color}"></span>
            </button>
          `).join("")}
        </div>
        <button class="toolbar-btn edit-btn hidden" title="Edit (E)">
          ${Icons.edit}
        </button>
        <div class="toolbar-divider"></div>
        <button class="toolbar-btn delete-btn" title="Delete (Delete)">
          ${Icons.delete}
        </button>
      </div>
      <div class="toolbar-annotation-content hidden"></div>
    `;

    this.commentBtn = this.element.querySelector(".comment-btn");
    this.editBtn = this.element.querySelector(".edit-btn");
    this.annotationContent = this.element.querySelector(".toolbar-annotation-content");
  }

  _setupEventListeners() {
    // Color picker button
    const colorBtn = this.element.querySelector(".color-picker-btn");
    colorBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggleColorDropdown();
    });

    // Color options
    const colorOptions = this.element.querySelectorAll(".color-option");
    colorOptions.forEach(option => {
      option.addEventListener("click", (e) => {
        e.stopPropagation();
        const color = option.dataset.color;
        this._selectColor(color);
      });
    });

    // Comment button (for highlight/underline/ink annotations)
    this.commentBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.currentAnnotation && this.onComment) {
        this.onComment(this.currentAnnotation);
      }
    });

    // Edit button (for notes)
    this.editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.currentAnnotation && this.onEdit) {
        this.onEdit(this.currentAnnotation);
      }
    });

    // Delete button
    const deleteBtn = this.element.querySelector(".delete-btn");
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.currentAnnotation && this.onDelete) {
        this.onDelete(this.currentAnnotation);
      }
      this.hide();
    });

    // Close color dropdown on outside click
    document.addEventListener("click", (e) => {
      if (this.colorDropdownOpen && !this.element.contains(e.target)) {
        this._closeColorDropdown();
      }
    });

    // Handle keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (this.element.classList.contains("hidden")) return

      // Don't intercept if user is typing
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")) return

      if (e.key === "Escape") {
        if (this.colorDropdownOpen) {
          this._closeColorDropdown();
        } else {
          this.hide();
          this.onDeselect?.();
        }
        e.preventDefault();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (this.currentAnnotation && this.onDelete) {
          this.onDelete(this.currentAnnotation);
        }
        this.hide();
      } else if (e.key === "e" || e.key === "E") {
        // Edit shortcut for notes
        if (this.currentAnnotation?.annotation_type === "note" && this.onEdit) {
          e.preventDefault();
          this.onEdit(this.currentAnnotation);
        }
      } else if (e.key === "c" || e.key === "C") {
        // Comment shortcut for highlight/underline/ink annotations
        const supportsComment = ["highlight", "line", "ink"].includes(this.currentAnnotation?.annotation_type);
        if (supportsComment && this.onComment) {
          e.preventDefault();
          this.onComment(this.currentAnnotation);
        }
      }
    });
  }

  _toggleColorDropdown() {
    if (this.colorDropdownOpen) {
      this._closeColorDropdown();
    } else {
      this._openColorDropdown();
    }
  }

  _openColorDropdown() {
    const dropdown = this.element.querySelector(".color-dropdown");
    const btn = this.element.querySelector(".color-picker-btn");
    dropdown.classList.remove("hidden");
    btn.setAttribute("aria-expanded", "true");
    this.colorDropdownOpen = true;
  }

  _closeColorDropdown() {
    const dropdown = this.element.querySelector(".color-dropdown");
    const btn = this.element.querySelector(".color-picker-btn");
    dropdown.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
    this.colorDropdownOpen = false;
  }

  _selectColor(color) {
    if (this.currentAnnotation && this.onColorChange) {
      this.onColorChange(this.currentAnnotation, color);
    }
    this._updateSelectedColor(color);
    this._closeColorDropdown();
  }

  _updateSelectedColor(color) {
    // Update the swatch in the button
    const swatch = this.element.querySelector(".color-picker-btn .color-swatch");
    swatch.style.backgroundColor = color;

    // Update aria-selected states
    const options = this.element.querySelectorAll(".color-option");
    options.forEach(option => {
      option.setAttribute("aria-selected", option.dataset.color === color ? "true" : "false");
    });
  }

  show(annotation, parentElement, pageHeight = null) {
    this.currentAnnotation = annotation;

    // Update color swatch to match annotation's current color
    const color = annotation.color || ColorPicker.DEFAULT_HIGHLIGHT_COLOR;
    this._updateSelectedColor(color);

    // Show/hide buttons based on annotation type
    const isNote = annotation.annotation_type === "note";
    const supportsComment = ["highlight", "line", "ink"].includes(annotation.annotation_type);

    // Comment button for highlight/underline/ink, edit button for notes
    this.commentBtn.classList.toggle("hidden", !supportsComment);
    this.editBtn.classList.toggle("hidden", !isNote);

    // Update comment button title based on whether contents exists
    if (supportsComment) {
      const hasComment = annotation.contents && annotation.contents.trim();
      this.commentBtn.title = hasComment ? "Edit Comment (C)" : "Add Comment (C)";
    }

    // Show contents for any annotation type that has it
    if (annotation.contents) {
      this.annotationContent.textContent = annotation.contents;
      this.annotationContent.classList.remove("hidden");
    } else {
      this.annotationContent.classList.add("hidden");
    }

    // Determine if toolbar should flip above the annotation
    // Check if annotation bottom + toolbar height (~50px) would exceed page
    const toolbarHeight = 50;
    const annotationBottom = annotation.rect[1] + annotation.rect[3];
    const shouldFlip = pageHeight && (annotationBottom + toolbarHeight > pageHeight);

    this.element.classList.toggle("flipped", shouldFlip);

    // Append to the annotation element so it moves/scales with it
    parentElement.appendChild(this.element);
    this.element.classList.remove("hidden");
  }

  hide() {
    this._closeColorDropdown();
    this.element.classList.add("hidden");
    this.currentAnnotation = null;

    // Clear annotation content
    this.annotationContent.textContent = "";
    this.annotationContent.classList.add("hidden");

    // Remove from parent when hidden
    if (this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }

  isVisible() {
    return !this.element.classList.contains("hidden")
  }

  destroy() {
    this.element.remove();
  }
}

// Time before the undo bar automatically hides (ms)
const AUTO_HIDE_DELAY = 5000;

class UndoBar {
  constructor(container, options = {}) {
    this.container = container;
    this.onUndo = options.onUndo;

    this.currentAnnotation = null;
    this.hideTimeout = null;

    this._createBar();
    this._setupEventListeners();

    // Start hidden
    this.container.classList.add("hidden");
  }

  _createBar() {
    this.container.innerHTML = `
      <span class="pdf-undo-bar-message"></span>
      <button class="pdf-undo-bar-btn">Undo</button>
      <button class="pdf-undo-bar-dismiss" aria-label="Dismiss">
        ${Icons.close}
      </button>
    `;

    this.messageElement = this.container.querySelector(".pdf-undo-bar-message");
    this.undoButton = this.container.querySelector(".pdf-undo-bar-btn");
    this.dismissButton = this.container.querySelector(".pdf-undo-bar-dismiss");
  }

  _setupEventListeners() {
    this.undoButton.addEventListener("click", () => {
      if (this.currentAnnotation && this.onUndo) {
        this.onUndo(this.currentAnnotation);
      }
      this.hide();
    });

    this.dismissButton.addEventListener("click", () => {
      this.hide();
    });
  }

  show(annotation) {
    // Clear any existing timeout
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
    }

    this.currentAnnotation = annotation;

    // Set message based on annotation type
    const typeMessages = {
      highlight: "Highlight deleted",
      underline: "Underline deleted",
      note: "Note deleted",
      ink: "Drawing deleted"
    };
    this.messageElement.textContent = typeMessages[annotation.annotation_type] || "Annotation deleted";

    // Show the bar (hidden class is on the container)
    this.container.classList.remove("hidden");

    // Auto-hide after delay
    this.hideTimeout = setTimeout(() => {
      this.hide();
    }, AUTO_HIDE_DELAY);
  }

  hide() {
    this.container.classList.add("hidden");
    this.currentAnnotation = null;

    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
  }

  destroy() {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
    }
  }
}

/**
 * ThumbnailView - Renders a single page thumbnail
 *
 * Inspired by PDF.js PDFThumbnailView but simplified for our use case.
 * Renders thumbnails at a fixed width with lazy loading support.
 */

const THUMBNAIL_WIDTH = 150; // Fixed thumbnail width in pixels
const RENDER_QUALITY = 2; // Canvas scale factor for crisp thumbnails

const ThumbnailRenderingState = {
  INITIAL: 0,
  RUNNING: 1,
  FINISHED: 2
};

class ThumbnailView {
  constructor({ container, pageNumber, defaultViewport, onClick }) {
    this.pageNumber = pageNumber;
    this.pdfPage = null;
    this.viewport = defaultViewport;
    this.renderingState = ThumbnailRenderingState.INITIAL;
    this.renderTask = null;
    this.onClick = onClick;

    // Calculate dimensions based on viewport aspect ratio
    const ratio = defaultViewport.width / defaultViewport.height;
    this.canvasWidth = THUMBNAIL_WIDTH;
    this.canvasHeight = Math.round(THUMBNAIL_WIDTH / ratio);

    // Create DOM elements
    this._createElements(container);
  }

  _createElements(container) {
    // Thumbnail container
    this.div = document.createElement("div");
    this.div.className = "thumbnail";
    this.div.dataset.pageNumber = this.pageNumber;

    // Page number label
    const label = document.createElement("span");
    label.className = "thumbnail-label";
    label.textContent = this.pageNumber;

    // Image placeholder (will be replaced with canvas/img)
    this.image = document.createElement("div");
    this.image.className = "thumbnail-image";
    this.image.style.width = `${this.canvasWidth}px`;
    this.image.style.height = `${this.canvasHeight}px`;

    // Click handler
    this.div.addEventListener("click", () => {
      if (this.onClick) {
        this.onClick(this.pageNumber);
      }
    });

    // Keyboard accessibility
    this.div.tabIndex = 0;
    this.div.role = "button";
    this.div.setAttribute("aria-label", `Page ${this.pageNumber}`);
    this.div.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (this.onClick) {
          this.onClick(this.pageNumber);
        }
      }
    });

    this.div.appendChild(this.image);
    this.div.appendChild(label);
    container.appendChild(this.div);
  }

  /**
   * Set the PDF page and update dimensions
   */
  setPdfPage(pdfPage) {
    this.pdfPage = pdfPage;
    const viewport = pdfPage.getViewport({ scale: 1 });
    this.viewport = viewport;

    // Recalculate dimensions
    const ratio = viewport.width / viewport.height;
    this.canvasHeight = Math.round(THUMBNAIL_WIDTH / ratio);
    this.image.style.height = `${this.canvasHeight}px`;
  }

  /**
   * Render the thumbnail
   */
  async draw() {
    if (this.renderingState !== ThumbnailRenderingState.INITIAL) {
      return
    }

    if (!this.pdfPage) {
      return
    }

    this.renderingState = ThumbnailRenderingState.RUNNING;

    try {
      // Calculate scale to fit thumbnail width
      const scale = THUMBNAIL_WIDTH / this.viewport.width;
      const viewport = this.pdfPage.getViewport({ scale });

      // Create canvas
      const canvas = document.createElement("canvas");
      canvas.className = "thumbnail-canvas";
      canvas.width = Math.round(viewport.width * RENDER_QUALITY);
      canvas.height = Math.round(viewport.height * RENDER_QUALITY);
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.style.height = `${Math.round(viewport.height)}px`;

      const ctx = canvas.getContext("2d");
      ctx.scale(RENDER_QUALITY, RENDER_QUALITY);

      // Render the page
      this.renderTask = this.pdfPage.render({
        canvasContext: ctx,
        viewport: viewport
      });

      await this.renderTask.promise;

      // Replace placeholder with canvas
      this.image.innerHTML = "";
      this.image.appendChild(canvas);
      this.image.style.height = "auto";

      this.renderingState = ThumbnailRenderingState.FINISHED;
      this.renderTask = null;
    } catch (error) {
      if (error.name === "RenderingCancelledException") {
        this.renderingState = ThumbnailRenderingState.INITIAL;
      } else {
        console.error(`Error rendering thumbnail ${this.pageNumber}:`, error);
        this.renderingState = ThumbnailRenderingState.INITIAL;
      }
      this.renderTask = null;
    }
  }

  /**
   * Cancel any in-progress rendering
   */
  cancelRendering() {
    if (this.renderTask) {
      this.renderTask.cancel();
      this.renderTask = null;
    }
  }

  /**
   * Reset to initial state
   */
  reset() {
    this.cancelRendering();
    this.renderingState = ThumbnailRenderingState.INITIAL;
    this.image.innerHTML = "";
    this.image.style.height = `${this.canvasHeight}px`;
  }

  /**
   * Mark as current page
   */
  setActive(isActive) {
    if (isActive) {
      this.div.classList.add("active");
      this.div.setAttribute("aria-current", "page");
    } else {
      this.div.classList.remove("active");
      this.div.removeAttribute("aria-current");
    }
  }

  /**
   * Scroll this thumbnail into view
   */
  scrollIntoView() {
    this.div.scrollIntoView({
      behavior: "smooth",
      block: "nearest"
    });
  }

  /**
   * Clean up
   */
  destroy() {
    this.cancelRendering();
    this.div.remove();
  }
}

/**
 * ThumbnailSidebar - Toggle-able sidebar with browsable page thumbnails
 *
 * Features:
 * - Lazy loading of thumbnails (only renders visible thumbnails)
 * - Click to navigate to page
 * - Current page highlighting
 * - Resizable sidebar
 * - Collapse/expand toggle
 */

const SIDEBAR_DEFAULT_WIDTH$1 = 200;
const SIDEBAR_MIN_WIDTH$1 = 150;
const SIDEBAR_MAX_WIDTH$1 = 400;

class ThumbnailSidebar {
  constructor({ container, viewer, eventBus, onPageClick }) {
    this.container = container;
    this.viewer = viewer;
    this.eventBus = eventBus;
    this.onPageClick = onPageClick;
    this.eventTarget = container; // Use container for dispatching error events

    this.thumbnails = [];
    this.pdfDocument = null;
    this.currentPage = 1;
    this.isOpen = false;
    this.sidebarWidth = SIDEBAR_DEFAULT_WIDTH$1;

    this._createElements();
    this._setupEventListeners();
  }

  _createElements() {
    // Main sidebar element
    this.element = document.createElement("div");
    this.element.className = "pdf-sidebar is-left pdf-thumbnail-sidebar";
    this.element.style.setProperty("--sidebar-width", `${this.sidebarWidth}px`);

    // Sidebar header with title and close button
    this.header = document.createElement("div");
    this.header.className = "pdf-sidebar-header";
    this.header.innerHTML = `
      <span class="pdf-sidebar-title">Pages</span>
      <button class="pdf-sidebar-close" type="button" aria-label="Close sidebar">
        ${Icons.close}
      </button>
    `;

    // Scrollable thumbnails container
    this.thumbnailContainer = document.createElement("div");
    this.thumbnailContainer.className = "pdf-sidebar-content";

    // Resize handle
    this.resizer = document.createElement("div");
    this.resizer.className = "pdf-sidebar-resizer";

    // Assemble sidebar
    this.element.appendChild(this.header);
    this.element.appendChild(this.thumbnailContainer);
    this.element.appendChild(this.resizer);

    // Insert sidebar at beginning of container (before pages container)
    this.container.insertBefore(this.element, this.container.firstChild);
  }

  _setupEventListeners() {
    // Close button in header
    const closeBtn = this.header.querySelector(".pdf-sidebar-close");
    closeBtn.addEventListener("click", () => this.close());

    // Thumbnail scroll - lazy load thumbnails
    this.thumbnailContainer.addEventListener("scroll", () => {
      this._renderVisibleThumbnails();
    });

    // Sidebar resizing
    this._setupResizer();

    // Listen for page changes from the viewer
    this.eventBus.on(ViewerEvents.PAGE_CHANGING, ({ pageNumber }) => {
      this._onPageChange(pageNumber);
    });

    // Listen for scroll events to update current page indicator
    this.eventBus.on(ViewerEvents.SCROLL, () => {
      const currentPage = this.viewer.getCurrentPage();
      if (currentPage !== this.currentPage) {
        this._onPageChange(currentPage);
      }
    });

    // Keyboard navigation within sidebar
    this.thumbnailContainer.addEventListener("keydown", (e) => {
      this._handleKeydown(e);
    });
  }

  _setupResizer() {
    let startX, startWidth;

    const onMouseMove = (e) => {
      const delta = e.clientX - startX;
      const newWidth = Math.max(SIDEBAR_MIN_WIDTH$1, Math.min(SIDEBAR_MAX_WIDTH$1, startWidth + delta));
      this.sidebarWidth = newWidth;
      this.element.style.setProperty("--sidebar-width", `${newWidth}px`);
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      this.element.classList.remove("resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    this.resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = this.sidebarWidth;
      this.element.classList.add("resizing");
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  _handleKeydown(e) {
    const focusedThumbnail = document.activeElement?.closest(".thumbnail");
    if (!focusedThumbnail) return

    const currentIndex = parseInt(focusedThumbnail.dataset.pageNumber, 10) - 1;

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        if (currentIndex > 0) {
          this.thumbnails[currentIndex - 1].div.focus();
        }
        break
      case "ArrowDown":
        e.preventDefault();
        if (currentIndex < this.thumbnails.length - 1) {
          this.thumbnails[currentIndex + 1].div.focus();
        }
        break
      case "Home":
        e.preventDefault();
        this.thumbnails[0]?.div.focus();
        break
      case "End":
        e.preventDefault();
        this.thumbnails[this.thumbnails.length - 1]?.div.focus();
        break
    }
  }

  /**
   * Initialize thumbnails for the loaded PDF document
   */
  async setDocument(pdfDocument) {
    // Clear existing thumbnails
    this.thumbnailContainer.innerHTML = "";
    this.thumbnails = [];
    this.pdfDocument = pdfDocument;

    if (!pdfDocument) return

    const numPages = pdfDocument.numPages;

    // Get first page for default viewport
    const firstPage = await pdfDocument.getPage(1);
    const defaultViewport = firstPage.getViewport({ scale: 1 });

    // Create thumbnail views for all pages
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const thumbnail = new ThumbnailView({
        container: this.thumbnailContainer,
        pageNumber: pageNum,
        defaultViewport: defaultViewport,
        onClick: (page) => this._onThumbnailClick(page)
      });
      this.thumbnails.push(thumbnail);
    }

    // Set the first page's pdfPage immediately
    this.thumbnails[0]?.setPdfPage(firstPage);
    this.thumbnails[0]?.setActive(true);

    // Render visible thumbnails if sidebar is open
    if (this.isOpen) {
      this._renderVisibleThumbnails();
    }
  }

  _onThumbnailClick(pageNumber) {
    if (this.onPageClick) {
      this.onPageClick(pageNumber);
    }
    this._onPageChange(pageNumber);
  }

  _onPageChange(pageNumber) {
    if (pageNumber === this.currentPage) return

    // Update active state
    const prevThumbnail = this.thumbnails[this.currentPage - 1];
    const newThumbnail = this.thumbnails[pageNumber - 1];

    if (prevThumbnail) {
      prevThumbnail.setActive(false);
    }
    if (newThumbnail) {
      newThumbnail.setActive(true);
      // Scroll thumbnail into view if sidebar is open
      if (this.isOpen) {
        newThumbnail.scrollIntoView();
      }
    }

    this.currentPage = pageNumber;
  }

  /**
   * Render thumbnails that are currently visible in the scroll container
   */
  _renderVisibleThumbnails() {
    if (!this.isOpen || this.thumbnails.length === 0) return

    const containerRect = this.thumbnailContainer.getBoundingClientRect();
    this.thumbnailContainer.scrollTop;
    const containerHeight = this.thumbnailContainer.clientHeight;

    // Buffer to render thumbnails slightly before they become visible
    const buffer = 100;

    for (const thumbnail of this.thumbnails) {
      const thumbRect = thumbnail.div.getBoundingClientRect();
      const relativeTop = thumbRect.top - containerRect.top;

      // Check if thumbnail is visible (with buffer)
      const isVisible = (
        relativeTop + thumbRect.height > -buffer &&
        relativeTop < containerHeight + buffer
      );

      if (isVisible && thumbnail.renderingState === ThumbnailRenderingState.INITIAL) {
        // Load the PDF page if needed and render
        this._ensurePageAndRender(thumbnail);
      }
    }
  }

  async _ensurePageAndRender(thumbnail) {
    if (!this.pdfDocument) return

    // Get the PDF page if not already loaded
    if (!thumbnail.pdfPage) {
      try {
        const pdfPage = await this.pdfDocument.getPage(thumbnail.pageNumber);
        thumbnail.setPdfPage(pdfPage);
      } catch (error) {
        console.error(`Error loading page ${thumbnail.pageNumber}:`, error);
        this._dispatchError(`Failed to load page ${thumbnail.pageNumber}`, error);
        return
      }
    }

    thumbnail.draw();
  }

  /**
   * Dispatch an error event for UI feedback and logging.
   */
  _dispatchError(message, originalError) {
    if (this.eventTarget) {
      this.eventTarget.dispatchEvent(new CustomEvent("pdf-viewer:error", {
        bubbles: true,
        detail: {
          source: "thumbnail_sidebar",
          errorType: "page_load_failed",
          message,
          error: originalError
        }
      }));
    }
  }

  /**
   * Open the sidebar
   */
  open() {
    this.isOpen = true;
    this.element.classList.add("open");
    this.container.classList.add("sidebar-open");

    // Render visible thumbnails
    requestAnimationFrame(() => {
      this._renderVisibleThumbnails();
      // Scroll current page into view
      const currentThumbnail = this.thumbnails[this.currentPage - 1];
      if (currentThumbnail) {
        currentThumbnail.scrollIntoView();
      }
    });
  }

  /**
   * Close the sidebar
   */
  close() {
    this.isOpen = false;
    this.element.classList.remove("open");
    this.container.classList.remove("sidebar-open");
  }

  /**
   * Toggle the sidebar
   */
  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Clean up
   */
  destroy() {
    for (const thumbnail of this.thumbnails) {
      thumbnail.destroy();
    }
    this.thumbnails = [];
    this.element.remove();
  }
}

/**
 * AnnotationSidebar - Right-side sidebar listing all annotations on the PDF
 *
 * Features:
 * - Lists all annotations with type icon, snippet/label, and metadata
 * - Sort by page number or timestamp (newest/oldest)
 * - Filter by annotation type
 * - Click to navigate and highlight annotation
 * - Real-time updates when annotations change
 * - Resizable and collapsible
 */

const SIDEBAR_DEFAULT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 450;

const SortMode = {
  PAGE: "page",
  NEWEST: "newest",
  OLDEST: "oldest"
};

const FilterType = {
  ALL: "all",
  HIGHLIGHT: "highlight",
  NOTE: "note",
  DRAWING: "drawing",
  UNDERLINE: "underline"
};

// Icons for annotation types (SVG strings)
const ANNOTATION_ICONS = {
  highlight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="2" y="14" width="20" height="6" rx="1" fill="#FFEB3B" stroke="none" opacity="0.6"/>
    <line x1="4" y1="17" x2="20" y2="17"/>
  </svg>`,
  note: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" fill="#FFF9C4"/>
    <line x1="8" y1="9" x2="16" y2="9"/>
    <line x1="8" y1="13" x2="14" y2="13"/>
  </svg>`,
  ink: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
  </svg>`,
  line: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/>
    <line x1="4" y1="21" x2="20" y2="21" stroke-width="3"/>
  </svg>`
};

class AnnotationSidebar {
  constructor({ element, itemTemplate, container, annotationManager, onAnnotationClick }) {
    this.annotationManager = annotationManager;
    this.onAnnotationClick = onAnnotationClick;
    this.itemTemplate = itemTemplate;  // Optional <template> element for custom list items

    this.isOpen = false;
    this.sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
    this.sortMode = SortMode.PAGE;
    this.filterType = FilterType.ALL;
    this.selectedAnnotationId = null;

    if (element) {
      // User provided HTML - find elements via data attributes
      this.element = element;
      this.container = element.parentElement;
      this.listContainer = element.querySelector('[data-role="list"]');
      this.header = element.querySelector('.pdf-sidebar-header');
      this.emptyState = element.querySelector('[data-role="empty-state"]');
      this.sortControls = element.querySelector('[data-role="sort-controls"]');
      this.filterControls = element.querySelector('[data-role="filter-controls"]');
      this.resizer = element.querySelector('[data-role="resizer"]');

      // Read initial width from CSS variable if set
      const currentWidth = element.style.getPropertyValue('--sidebar-width');
      if (currentWidth) {
        this.sidebarWidth = parseInt(currentWidth, 10) || SIDEBAR_DEFAULT_WIDTH;
      } else {
        element.style.setProperty('--sidebar-width', `${this.sidebarWidth}px`);
      }
    } else {
      // Fallback - create default HTML (existing behavior)
      this.container = container;
      this._createElements();
    }

    this._setupEventListeners();
  }

  _createElements() {
    // Main sidebar element - positioned on the RIGHT
    this.element = document.createElement("div");
    this.element.className = "pdf-sidebar is-right pdf-annotation-sidebar";
    this.element.style.setProperty("--sidebar-width", `${this.sidebarWidth}px`);

    // Sidebar header with title, count badge, and controls
    this.header = document.createElement("div");
    this.header.className = "pdf-sidebar-header";
    this.header.innerHTML = `
      <div class="pdf-sidebar-header-left">
        <span class="pdf-sidebar-title">Annotations</span>
        <span class="annotation-count-badge">0</span>
      </div>
      <button class="pdf-sidebar-close" type="button" aria-label="Close sidebar">
        ${Icons.close}
      </button>
    `;

    // Sort controls
    this.sortControls = document.createElement("div");
    this.sortControls.className = "annotation-sort-controls";
    this.sortControls.innerHTML = `
      <button class="sort-btn active" data-sort="${SortMode.PAGE}">Page</button>
      <button class="sort-btn" data-sort="${SortMode.NEWEST}">Newest</button>
      <button class="sort-btn" data-sort="${SortMode.OLDEST}">Oldest</button>
    `;

    // Filter controls
    this.filterControls = document.createElement("div");
    this.filterControls.className = "annotation-filter-controls";
    this.filterControls.innerHTML = `
      <select class="annotation-filter-select">
        <option value="${FilterType.ALL}">All</option>
        <option value="${FilterType.HIGHLIGHT}">Highlights</option>
        <option value="${FilterType.NOTE}">Notes</option>
        <option value="${FilterType.DRAWING}">Drawings</option>
        <option value="${FilterType.UNDERLINE}">Underlines</option>
      </select>
    `;

    // Scrollable list container
    this.listContainer = document.createElement("div");
    this.listContainer.className = "pdf-sidebar-content annotation-list";

    // Empty state
    this.emptyState = document.createElement("div");
    this.emptyState.className = "annotation-empty-state";
    this.emptyState.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 20h9"/>
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg>
      <p>No annotations yet</p>
      <p class="hint">Use the toolbar tools to add highlights, notes, or drawings</p>
    `;

    // Resize handle (on the LEFT since this is a right sidebar)
    this.resizer = document.createElement("div");
    this.resizer.className = "pdf-sidebar-resizer";

    // Controls wrapper
    const controlsWrapper = document.createElement("div");
    controlsWrapper.className = "annotation-controls-wrapper";
    controlsWrapper.appendChild(this.sortControls);
    controlsWrapper.appendChild(this.filterControls);

    // Assemble sidebar
    this.element.appendChild(this.resizer);
    this.element.appendChild(this.header);
    this.element.appendChild(controlsWrapper);
    this.element.appendChild(this.listContainer);
    this.element.appendChild(this.emptyState);

    // Insert sidebar at the END of container (after pages container for right positioning)
    this.container.appendChild(this.element);
  }

  _setupEventListeners() {
    // Close button - support both user HTML (data-action="close") and auto-generated (.pdf-sidebar-close)
    const closeBtn = this.header?.querySelector('[data-action="close"]') ||
                     this.header?.querySelector(".pdf-sidebar-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => this.close());
    }

    // Sort buttons
    if (this.sortControls) {
      this.sortControls.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-sort]") || e.target.closest(".sort-btn");
        if (btn && btn.dataset.sort) {
          this.sortMode = btn.dataset.sort;
          this.sortControls.querySelectorAll("[data-sort], .sort-btn").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          this._refreshList();
        }
      });
    }

    // Filter select - support both user HTML (data-action="filter") and auto-generated (.annotation-filter-select)
    const filterSelect = this.filterControls?.querySelector('[data-action="filter"]') ||
                         this.filterControls?.querySelector(".annotation-filter-select");
    if (filterSelect) {
      filterSelect.addEventListener("change", (e) => {
        this.filterType = e.target.value;
        this._refreshList();
      });
    }

    // Sidebar resizing
    this._setupResizer();

    // Keyboard navigation
    this.listContainer.addEventListener("keydown", (e) => {
      this._handleKeydown(e);
    });
  }

  _setupResizer() {
    if (!this.resizer) return

    let startX, startWidth;

    const onMouseMove = (e) => {
      // For right sidebar, resizing from left edge: subtract delta
      const delta = startX - e.clientX;
      const newWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startWidth + delta));
      this.sidebarWidth = newWidth;
      this.element.style.setProperty("--sidebar-width", `${newWidth}px`);
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      this.element.classList.remove("resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    this.resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = this.sidebarWidth;
      this.element.classList.add("resizing");
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  _handleKeydown(e) {
    const focused = document.activeElement?.closest(".annotation-list-item");
    if (!focused) return

    const items = Array.from(this.listContainer.querySelectorAll(".annotation-list-item"));
    const currentIndex = items.indexOf(focused);

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        if (currentIndex > 0) {
          items[currentIndex - 1].focus();
        }
        break
      case "ArrowDown":
        e.preventDefault();
        if (currentIndex < items.length - 1) {
          items[currentIndex + 1].focus();
        }
        break
      case "Enter":
      case " ":
        e.preventDefault();
        focused.click();
        break
      case "Home":
        e.preventDefault();
        items[0]?.focus();
        break
      case "End":
        e.preventDefault();
        items[items.length - 1]?.focus();
        break
    }
  }

  /**
   * Refresh the annotation list
   */
  _refreshList() {
    let annotations = this.annotationManager.getAllAnnotations();

    // Apply filter
    if (this.filterType !== FilterType.ALL) {
      annotations = annotations.filter(a => this._matchesFilter(a));
    }

    // Apply sort
    annotations = this._sortAnnotations(annotations);

    // Clear and rebuild list
    this.listContainer.innerHTML = "";

    // Update count badge - support both user HTML (data-role="count") and auto-generated
    const countBadge = this.header?.querySelector('[data-role="count"]') ||
                       this.header?.querySelector(".annotation-count-badge");
    if (countBadge) {
      countBadge.textContent = annotations.length;
    }

    // Show empty state or list
    if (annotations.length === 0) {
      this.emptyState?.classList.add("visible");
      this.listContainer.classList.add("empty");
    } else {
      this.emptyState?.classList.remove("visible");
      this.listContainer.classList.remove("empty");

      for (const annotation of annotations) {
        const item = this._createListItem(annotation);
        this.listContainer.appendChild(item);
      }
    }
  }

  _matchesFilter(annotation) {
    const type = annotation.annotation_type;

    switch (this.filterType) {
      case FilterType.HIGHLIGHT:
        return type === "highlight" || (type === "ink" && annotation.subject === "Free Highlight")
      case FilterType.NOTE:
        return type === "note"
      case FilterType.DRAWING:
        return type === "ink" && annotation.subject !== "Free Highlight"
      case FilterType.UNDERLINE:
        return type === "line"
      default:
        return true
    }
  }

  _sortAnnotations(annotations) {
    const sorted = [...annotations];

    switch (this.sortMode) {
      case SortMode.PAGE:
        sorted.sort((a, b) => {
          // Primary: page number
          if (a.page !== b.page) return a.page - b.page
          // Secondary: vertical position (top to bottom)
          const aY = this._getAnnotationY(a);
          const bY = this._getAnnotationY(b);
          return aY - bY
        });
        break
      case SortMode.NEWEST:
        sorted.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        break
      case SortMode.OLDEST:
        sorted.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        break
    }

    return sorted
  }

  _getAnnotationY(annotation) {
    if (annotation.rect) {
      return annotation.rect[1]
    }
    if (annotation.quads && annotation.quads.length > 0) {
      return annotation.quads[0].p1.y
    }
    if (annotation.ink_strokes && annotation.ink_strokes.length > 0) {
      const firstStroke = annotation.ink_strokes[0];
      if (firstStroke.points && firstStroke.points.length > 0) {
        return firstStroke.points[0].y
      }
    }
    return 0
  }

  _createListItem(annotation) {
    let item;

    if (this.itemTemplate) {
      // Clone user's template and populate data-field elements
      item = this.itemTemplate.content.firstElementChild.cloneNode(true);
      item.dataset.annotationId = annotation.id;

      // Ensure tabIndex for keyboard navigation
      if (!item.hasAttribute("tabindex")) {
        item.tabIndex = 0;
      }

      // Determine display values
      const { icon, label, typeLabel } = this._getAnnotationDisplay(annotation);
      const timestamp = this._formatTimestamp(annotation.created_at);

      // Populate data-field elements
      this._setField(item, "icon", icon, annotation.color);
      this._setField(item, "label", this._escapeHtml(label));
      this._setField(item, "type", typeLabel);
      this._setField(item, "page", `Page ${annotation.page}`);
      this._setField(item, "time", timestamp);

      // Also set data attributes for user's Stimulus controllers
      item.dataset.annotationType = annotation.annotation_type;
      item.dataset.annotationPage = annotation.page;
      item.dataset.annotationColor = annotation.color || "";
    } else {
      // Fallback - existing innerHTML approach
      item = document.createElement("div");
      item.className = "annotation-list-item";
      item.dataset.annotationId = annotation.id;
      item.tabIndex = 0;

      // Determine icon and label based on type
      const { icon, label, typeLabel } = this._getAnnotationDisplay(annotation);

      // Format timestamp
      const timestamp = this._formatTimestamp(annotation.created_at);

      item.innerHTML = `
        <div class="annotation-item-icon" style="color: ${annotation.color || '#666'}">
          ${icon}
        </div>
        <div class="annotation-item-content">
          <div class="annotation-item-label">${this._escapeHtml(label)}</div>
          <div class="annotation-item-meta">
            <span class="annotation-item-type">${typeLabel}</span>
            <span class="annotation-item-separator">•</span>
            <span class="annotation-item-page">Page ${annotation.page}</span>
            <span class="annotation-item-separator">•</span>
            <span class="annotation-item-time">${timestamp}</span>
          </div>
        </div>
        <div class="annotation-item-hover">
          <span>Jump</span>
          ${Icons.chevronRight}
        </div>
      `;
    }

    // Selection state
    if (this.selectedAnnotationId === annotation.id) {
      item.classList.add("selected");
    }

    // Click handler
    item.addEventListener("click", () => {
      this._selectItem(annotation.id);
      if (this.onAnnotationClick) {
        this.onAnnotationClick(annotation.id);
      }
    });

    return item
  }

  /**
   * Set a field value in a template-cloned element
   * @param {HTMLElement} element - The cloned template element
   * @param {string} fieldName - The data-field name to find
   * @param {string} value - The value to set (can include HTML for icons)
   * @param {string} color - Optional color to apply
   */
  _setField(element, fieldName, value, color) {
    const field = element.querySelector(`[data-field="${fieldName}"]`);
    if (field) {
      field.innerHTML = value;
      if (color && fieldName === "icon") {
        field.style.color = color;
      }
    }
  }

  _getAnnotationDisplay(annotation) {
    const type = annotation.annotation_type;
    let icon, label, typeLabel;

    if (type === "highlight" || (type === "ink" && annotation.subject === "Free Highlight")) {
      icon = ANNOTATION_ICONS.highlight;
      typeLabel = "Highlight";
      // Extract highlighted text if available
      label = annotation.title || annotation.contents || "Freehand Highlight";
      label = this._truncate(label, 80);
    } else if (type === "note") {
      icon = ANNOTATION_ICONS.note;
      typeLabel = "Note";
      label = annotation.contents || "Empty note";
      label = this._truncate(label, 80);
    } else if (type === "ink") {
      icon = ANNOTATION_ICONS.ink;
      typeLabel = "Drawing";
      label = "Ink drawing";
    } else if (type === "line") {
      icon = ANNOTATION_ICONS.line;
      typeLabel = "Underline";
      label = annotation.title || "Underlined text";
      label = this._truncate(label, 80);
    } else {
      icon = ANNOTATION_ICONS.highlight;
      typeLabel = type || "Annotation";
      label = annotation.contents || "Annotation";
    }

    return { icon, label, typeLabel }
  }

  _truncate(text, maxLength) {
    if (!text) return ""
    text = text.trim().replace(/\s+/g, " ");
    if (text.length <= maxLength) return text
    return text.substring(0, maxLength - 3) + "..."
  }

  _formatTimestamp(dateString) {
    if (!dateString) return ""

    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      // Today - show time
      return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    } else if (diffDays === 1) {
      return "Yesterday"
    } else if (diffDays < 7) {
      return date.toLocaleDateString([], { weekday: "short" })
    } else {
      return date.toLocaleDateString([], { month: "short", day: "numeric" })
    }
  }

  _escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML
  }

  _selectItem(annotationId) {
    // Deselect previous
    const prev = this.listContainer.querySelector(".annotation-list-item.selected");
    if (prev) {
      prev.classList.remove("selected");
    }

    // Select new
    this.selectedAnnotationId = annotationId;
    const item = this.listContainer.querySelector(`[data-annotation-id="${annotationId}"]`);
    if (item) {
      item.classList.add("selected");
    }
  }

  /**
   * Called when an annotation is created - refresh the list
   */
  onAnnotationCreated(annotation) {
    if (this.isOpen) {
      this._refreshList();
    }
  }

  /**
   * Called when an annotation is updated - refresh the list
   */
  onAnnotationUpdated(annotation) {
    if (this.isOpen) {
      this._refreshList();
    }
  }

  /**
   * Called when an annotation is deleted - refresh the list
   */
  onAnnotationDeleted(annotation) {
    if (this.isOpen) {
      // Clear selection if deleted annotation was selected
      if (this.selectedAnnotationId === annotation.id) {
        this.selectedAnnotationId = null;
      }
      this._refreshList();
    }
  }

  /**
   * Select and scroll to an annotation in the list
   * @param {string} annotationId - The annotation ID to select
   * @param {Object} options - Options
   * @param {boolean} options.scroll - Whether to scroll the sidebar list (default: true)
   */
  selectAnnotation(annotationId, { scroll = true } = {}) {
    this._selectItem(annotationId);
    const item = this.listContainer.querySelector(`[data-annotation-id="${annotationId}"]`);
    if (item && this.isOpen && scroll) {
      item.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  /**
   * Open the sidebar
   */
  open() {
    this.isOpen = true;
    this.element.classList.add("open");
    this.container.classList.add("annotation-sidebar-open");
    this._refreshList();
  }

  /**
   * Close the sidebar
   */
  close() {
    this.isOpen = false;
    this.element.classList.remove("open");
    this.container.classList.remove("annotation-sidebar-open");
  }

  /**
   * Toggle the sidebar
   */
  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Get current annotation count
   */
  getCount() {
    return this.annotationManager.getAllAnnotations().length
  }

  /**
   * Clean up
   */
  destroy() {
    this.element.remove();
  }
}

/**
 * FindController - PDF text search functionality.
 *
 * Provides search capabilities for the PDF viewer:
 * - Lazy text extraction (only when search is initiated)
 * - Case-insensitive and case-sensitive search
 * - Whole word matching
 * - Match highlighting in text layer
 * - Navigation between matches
 */

const FindState = {
  FOUND: 0,
  NOT_FOUND: 1,
  WRAPPED: 2,
  PENDING: 3
};

class FindController {
  constructor(viewer, options = {}) {
    this.viewer = viewer;
    this.pdfDocument = null;

    // Text content storage: pageNumber -> { textContent, textItems, str }
    this.pageContents = new Map();

    // Current search state
    this.query = "";
    this.caseSensitive = false;
    this.entireWord = false;
    this.highlightAll = true;

    // Match data: array of { pageNumber, matchIndex, startOffset, endOffset }
    this.matches = [];
    this.currentMatchIndex = -1;

    // State
    this.state = FindState.PENDING;
    this.extracting = false;
    this.extractionComplete = false;

    // Callbacks
    this.onUpdateState = options.onUpdateState || (() => {});
  }

  /**
   * Set the PDF document to search.
   * Text extraction is deferred until a search is initiated.
   * @param {PDFDocumentProxy} pdfDocument
   */
  setDocument(pdfDocument) {
    this.pdfDocument = pdfDocument;
    this.pageContents.clear();
    this.matches = [];
    this.currentMatchIndex = -1;
    this.extractionComplete = false;
    // Text extraction is now lazy - starts when find() is called
  }

  /**
   * Start text extraction if not already started.
   * Prioritizes visible pages for faster initial results.
   */
  _ensureTextExtraction() {
    if (this.extracting || this.extractionComplete) return

    this._extractTextLazily();
  }

  /**
   * Extract text lazily, prioritizing visible pages first.
   */
  async _extractTextLazily() {
    if (!this.pdfDocument || this.extracting) return

    this.extracting = true;
    const numPages = this.pdfDocument.numPages;

    // Get visible pages to prioritize them
    const visiblePages = this.viewer.viewer.getVisiblePages();
    const { first: firstVisible, last: lastVisible } = visiblePages;

    // Build extraction order: visible pages first, then remaining pages
    const extractionOrder = [];

    // Add visible pages first
    if (firstVisible !== null && lastVisible !== null) {
      for (let pageNum = firstVisible; pageNum <= lastVisible; pageNum++) {
        extractionOrder.push(pageNum);
      }
    }

    // Add remaining pages (before visible, then after visible)
    for (let pageNum = 1; pageNum < (firstVisible || 1); pageNum++) {
      extractionOrder.push(pageNum);
    }
    for (let pageNum = (lastVisible || 0) + 1; pageNum <= numPages; pageNum++) {
      extractionOrder.push(pageNum);
    }

    for (const pageNum of extractionOrder) {
      // Skip if already extracted
      if (this.pageContents.has(pageNum)) continue

      try {
        await this._extractPage(pageNum);

        // If we have an active query, search this page and update UI
        if (this.query) {
          const matchCountBefore = this.matches.length;
          this._searchPage(pageNum);

          // If new matches were added, re-sort and fix current index
          if (this.matches.length > matchCountBefore) {
            this._sortMatchesAndFixIndex();
          }

          this._updateHighlights(pageNum);
          this._notifyStateUpdate();
        }
      } catch (error) {
        console.error(`Error extracting text from page ${pageNum}:`, error);
      }
    }

    this.extracting = false;
    this.extractionComplete = true;

    // Final update when extraction is complete
    if (this.query) {
      this._notifyStateUpdate();
    }
  }

  /**
   * Extract text from a single page.
   * @param {number} pageNum
   */
  async _extractPage(pageNum) {
    const page = await this.pdfDocument.getPage(pageNum);
    const textContent = await page.getTextContent();

    // Build a searchable string and track item positions
    let pageText = "";
    const textItems = [];

    for (const item of textContent.items) {
      if (item.str) {
        textItems.push({
          str: item.str,
          startOffset: pageText.length,
          endOffset: pageText.length + item.str.length
        });
        pageText += item.str;
      }
      // Handle end-of-line markers
      if (item.hasEOL) {
        pageText += " "; // Add space for line breaks
      }
    }

    this.pageContents.set(pageNum, {
      textContent,
      textItems,
      str: pageText
    });
  }

  /**
   * Notify UI of current search state.
   */
  _notifyStateUpdate() {
    this.onUpdateState(this.state, {
      current: this.currentMatchIndex + 1,
      total: this.matches.length,
      extracting: this.extracting
    });
  }

  /**
   * Perform a search.
   * @param {string} query - The search query
   * @param {Object} options - Search options
   * @param {boolean} options.caseSensitive - Case-sensitive matching
   * @param {boolean} options.entireWord - Match whole words only
   * @param {boolean} options.highlightAll - Highlight all matches
   * @param {boolean} options.findPrevious - Search backwards
   */
  find(query, options = {}) {
    const queryChanged = query !== this.query;
    const optionsChanged =
      options.caseSensitive !== this.caseSensitive ||
      options.entireWord !== this.entireWord;

    this.query = query;
    this.caseSensitive = options.caseSensitive || false;
    this.entireWord = options.entireWord || false;
    this.highlightAll = options.highlightAll !== false;

    if (!query) {
      this._clearMatches();
      this.state = FindState.PENDING;
      this.onUpdateState(this.state, { current: 0, total: 0, extracting: false });
      return
    }

    // Start text extraction if not already running (lazy extraction)
    this._ensureTextExtraction();

    if (queryChanged || optionsChanged) {
      // New search - search all already-extracted pages
      this._clearMatches();
      this._searchExtractedPages();

      if (this.matches.length > 0) {
        this.currentMatchIndex = 0;
        this.state = FindState.FOUND;
      } else {
        this.currentMatchIndex = -1;
        // Only show NOT_FOUND if extraction is complete
        this.state = this.extractionComplete ? FindState.NOT_FOUND : FindState.PENDING;
      }
    } else {
      // Navigate to next/previous
      if (this.matches.length > 0) {
        if (options.findPrevious) {
          this.currentMatchIndex--;
          if (this.currentMatchIndex < 0) {
            this.currentMatchIndex = this.matches.length - 1;
            this.state = FindState.WRAPPED;
          } else {
            this.state = FindState.FOUND;
          }
        } else {
          this.currentMatchIndex++;
          if (this.currentMatchIndex >= this.matches.length) {
            this.currentMatchIndex = 0;
            this.state = FindState.WRAPPED;
          } else {
            this.state = FindState.FOUND;
          }
        }
      }
    }

    // Update highlights on all pages
    this._updateAllHighlights();

    // Scroll to current match
    if (this.currentMatchIndex >= 0) {
      this._scrollToMatch(this.currentMatchIndex);
    }

    this._notifyStateUpdate();
  }

  /**
   * Navigate to the next match.
   */
  findNext() {
    this.find(this.query, {
      caseSensitive: this.caseSensitive,
      entireWord: this.entireWord,
      highlightAll: this.highlightAll,
      findPrevious: false
    });
  }

  /**
   * Navigate to the previous match.
   */
  findPrevious() {
    this.find(this.query, {
      caseSensitive: this.caseSensitive,
      entireWord: this.entireWord,
      highlightAll: this.highlightAll,
      findPrevious: true
    });
  }

  /**
   * Search all already-extracted pages.
   * Results accumulate as more pages are extracted in the background.
   */
  _searchExtractedPages() {
    this.matches = [];

    // Search pages in order for consistent match numbering
    const pageNumbers = Array.from(this.pageContents.keys()).sort((a, b) => a - b);
    for (const pageNum of pageNumbers) {
      this._searchPage(pageNum);
    }
  }

  /**
   * Search a single page for matches.
   * @param {number} pageNum
   */
  _searchPage(pageNum) {
    const pageContent = this.pageContents.get(pageNum);
    if (!pageContent) return

    const { str: pageText } = pageContent;
    const query = this.caseSensitive ? this.query : this.query.toLowerCase();
    const searchText = this.caseSensitive ? pageText : pageText.toLowerCase();

    // Build regex for matching
    let pattern = this._escapeRegExp(query);
    if (this.entireWord) {
      pattern = `\\b${pattern}\\b`;
    }

    try {
      const regex = new RegExp(pattern, this.caseSensitive ? "g" : "gi");
      let match;

      while ((match = regex.exec(searchText)) !== null) {
        // Find which text items this match spans
        const startOffset = match.index;
        const endOffset = startOffset + match[0].length;

        this.matches.push({
          pageNumber: pageNum,
          startOffset,
          endOffset,
          text: pageText.substring(startOffset, endOffset)
        });
      }
    } catch (e) {
      console.error("Search regex error:", e);
    }
  }

  /**
   * Sort matches by page number and offset, preserving current selection.
   * Called after new matches are added from a newly-extracted page.
   */
  _sortMatchesAndFixIndex() {
    // Remember the current match to find its new position after sorting
    const currentMatch = this.currentMatchIndex >= 0 ? this.matches[this.currentMatchIndex] : null;

    // Sort by page number, then by start offset within page
    this.matches.sort((a, b) => {
      if (a.pageNumber !== b.pageNumber) {
        return a.pageNumber - b.pageNumber
      }
      return a.startOffset - b.startOffset
    });

    // Find the new index of the current match
    if (currentMatch) {
      this.currentMatchIndex = this.matches.indexOf(currentMatch);
    }
  }

  /**
   * Escape special regex characters.
   */
  _escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  /**
   * Clear all matches and highlights.
   */
  _clearMatches() {
    this.matches = [];
    this.currentMatchIndex = -1;

    // Remove highlight classes from all pages
    const pageCount = this.viewer.viewer.getPageCount();
    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      this._clearPageHighlights(pageNum);
    }
  }

  /**
   * Clear highlights from a specific page.
   * Removes injected highlight wrapper spans and restores original text nodes.
   */
  _clearPageHighlights(pageNum) {
    const textLayer = this.viewer.viewer.getTextLayer(pageNum);
    if (!textLayer) return

    // Find all highlight wrapper spans we created and unwrap them
    const highlights = textLayer.querySelectorAll(".search-highlight");
    highlights.forEach(highlight => {
      const parent = highlight.parentNode;
      // Replace the highlight span with its text content
      const textNode = document.createTextNode(highlight.textContent);
      parent.replaceChild(textNode, highlight);
      // Normalize to merge adjacent text nodes
      parent.normalize();
    });
  }

  /**
   * Update highlights on all pages.
   */
  _updateAllHighlights() {
    const pageCount = this.viewer.viewer.getPageCount();
    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      this._updateHighlights(pageNum);
    }
  }

  /**
   * Update highlights on a specific page.
   * Wraps matched text in highlight spans for precise highlighting.
   * @param {number} pageNum
   */
  _updateHighlights(pageNum) {
    const textLayer = this.viewer.viewer.getTextLayer(pageNum);
    if (!textLayer) return

    // Clear existing highlights on this page
    this._clearPageHighlights(pageNum);

    if (!this.highlightAll || !this.query) return

    const pageContent = this.pageContents.get(pageNum);
    if (!pageContent) return

    const { textItems } = pageContent;
    const pageMatches = this.matches.filter(m => m.pageNumber === pageNum);

    if (pageMatches.length === 0) return

    // Get all text spans in the text layer (excluding endOfContent)
    const spans = Array.from(textLayer.querySelectorAll("span:not(.endOfContent)"));

    for (const match of pageMatches) {
      const isCurrentMatch = this.matches.indexOf(match) === this.currentMatchIndex;

      // Find which spans contain this match and wrap the matched text
      for (let i = 0; i < spans.length && i < textItems.length; i++) {
        const item = textItems[i];
        const span = spans[i];

        if (!span || !item) continue

        const spanStart = item.startOffset;
        const spanEnd = item.endOffset;

        // Check if this span overlaps with the match
        if (spanEnd > match.startOffset && spanStart < match.endOffset) {
          // Calculate the portion of this span that's part of the match
          const highlightStart = Math.max(0, match.startOffset - spanStart);
          const highlightEnd = Math.min(item.str.length, match.endOffset - spanStart);

          this._wrapTextInHighlight(span, highlightStart, highlightEnd, isCurrentMatch);
        }
      }
    }
  }

  /**
   * Wrap a portion of text within a span in a highlight element.
   * Handles spans that may already have some highlights from previous matches.
   * @param {HTMLElement} span - The text span
   * @param {number} start - Start character index within the span's original text
   * @param {number} end - End character index within the span's original text
   * @param {boolean} isSelected - Whether this is the current match
   */
  _wrapTextInHighlight(span, start, end, isSelected) {
    // Walk through child nodes to find the text node containing our range
    // This handles spans that have already been partially highlighted
    let charOffset = 0;

    for (const node of Array.from(span.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const nodeText = node.textContent;
        const nodeStart = charOffset;
        const nodeEnd = charOffset + nodeText.length;

        // Check if this text node contains part of our match
        if (nodeEnd > start && nodeStart < end) {
          // Calculate the portion within this text node
          const highlightStart = Math.max(0, start - nodeStart);
          const highlightEnd = Math.min(nodeText.length, end - nodeStart);

          if (highlightStart < highlightEnd) {
            const before = nodeText.substring(0, highlightStart);
            const matched = nodeText.substring(highlightStart, highlightEnd);
            const after = nodeText.substring(highlightEnd);

            // Create the highlight wrapper
            const highlightSpan = document.createElement("span");
            highlightSpan.className = isSelected ? "search-highlight selected" : "search-highlight";
            highlightSpan.textContent = matched;

            // Build replacement fragment
            const fragment = document.createDocumentFragment();
            if (before) {
              fragment.appendChild(document.createTextNode(before));
            }
            fragment.appendChild(highlightSpan);
            if (after) {
              fragment.appendChild(document.createTextNode(after));
            }

            span.replaceChild(fragment, node);

            // If match extends beyond this node, we've done our part for this node
            // The loop will continue to handle remaining nodes if needed
          }
        }

        charOffset = nodeEnd;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // Skip over existing highlight spans but count their characters
        charOffset += node.textContent.length;
      }
    }
  }

  /**
   * Scroll to a match.
   * @param {number} matchIndex
   */
  _scrollToMatch(matchIndex) {
    const match = this.matches[matchIndex];
    if (!match) return

    // Go to the page containing the match
    this.viewer.viewer.goToPage(match.pageNumber);

    // Wait for the page to render, then scroll to the highlighted element
    setTimeout(() => {
      const textLayer = this.viewer.viewer.getTextLayer(match.pageNumber);
      if (!textLayer) return

      const selected = textLayer.querySelector(".search-highlight.selected");
      if (selected) {
        selected.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 100);
  }

  /**
   * Called when a page's text layer is rendered.
   * Updates highlights for that page.
   */
  onTextLayerRendered(pageNumber) {
    if (this.query && this.highlightAll) {
      this._updateHighlights(pageNumber);
    }
  }

  /**
   * Clean up.
   */
  destroy() {
    this.pageContents.clear();
    this.matches = [];
    this.pdfDocument = null;
  }
}

/**
 * Announcer - ARIA live region for screen reader announcements.
 *
 * Creates an invisible live region that announces state changes
 * to screen reader users. Supports both polite and assertive announcements.
 *
 * Usage:
 *   const announcer = new Announcer()
 *   announcer.announce("3 search results found")
 *   announcer.announce("Action completed", "assertive")
 */
class Announcer {
  constructor() {
    this._politeRegion = null;
    this._assertiveRegion = null;
    this._timeouts = new Map();
    this._createRegions();
  }

  _createRegions() {
    // Create polite region (for non-urgent announcements)
    this._politeRegion = document.createElement("div");
    this._politeRegion.setAttribute("role", "status");
    this._politeRegion.setAttribute("aria-live", "polite");
    this._politeRegion.setAttribute("aria-atomic", "true");
    this._politeRegion.className = "pdf-viewer-announcer";

    // Create assertive region (for urgent announcements)
    this._assertiveRegion = document.createElement("div");
    this._assertiveRegion.setAttribute("role", "alert");
    this._assertiveRegion.setAttribute("aria-live", "assertive");
    this._assertiveRegion.setAttribute("aria-atomic", "true");
    this._assertiveRegion.className = "pdf-viewer-announcer";

    document.body.appendChild(this._politeRegion);
    document.body.appendChild(this._assertiveRegion);
  }

  /**
   * Announce a message to screen readers.
   * @param {string} message - The message to announce
   * @param {"polite"|"assertive"} priority - Announcement priority (default: polite)
   */
  announce(message, priority = "polite") {
    const region = priority === "assertive" ? this._assertiveRegion : this._politeRegion;

    // Cancel any pending announcement for this region to prevent stale messages
    // during rapid navigation (e.g., quickly stepping through search results)
    if (this._timeouts.has(region)) {
      clearTimeout(this._timeouts.get(region));
    }

    // Clear and set the message (clearing first ensures repeated messages are announced)
    region.textContent = "";

    // Use setTimeout to ensure the clear is processed before the new message
    const timeoutId = setTimeout(() => {
      region.textContent = message;
      this._timeouts.delete(region);
    }, 50);

    this._timeouts.set(region, timeoutId);
  }

  /**
   * Clear any pending announcements.
   */
  clear() {
    // Cancel any pending timeouts
    for (const timeoutId of this._timeouts.values()) {
      clearTimeout(timeoutId);
    }
    this._timeouts.clear();

    this._politeRegion.textContent = "";
    this._assertiveRegion.textContent = "";
  }

  /**
   * Clean up the announcer and remove regions from DOM.
   */
  destroy() {
    // Cancel any pending timeouts
    for (const timeoutId of this._timeouts.values()) {
      clearTimeout(timeoutId);
    }
    this._timeouts.clear();

    this._politeRegion?.remove();
    this._assertiveRegion?.remove();
    this._politeRegion = null;
    this._assertiveRegion = null;
  }
}

// Singleton instance for shared use across the PDF viewer
let _sharedInstance = null;

/**
 * Get the shared announcer instance.
 * Creates one if it doesn't exist.
 * @returns {Announcer}
 */
function getAnnouncer() {
  if (!_sharedInstance) {
    _sharedInstance = new Announcer();
  }
  return _sharedInstance
}

/**
 * Destroy the shared announcer instance.
 * Call this when the PDF viewer is destroyed.
 */
function destroyAnnouncer() {
  if (_sharedInstance) {
    _sharedInstance.destroy();
    _sharedInstance = null;
  }
}

/**
 * FindBar - Search UI component for the PDF viewer.
 *
 * Provides a search bar with:
 * - Text input for search query
 * - Previous/Next navigation buttons
 * - Match count display
 * - Case-sensitive toggle
 * - Whole word toggle
 * - Close button
 */


// Delay before triggering search after user stops typing (ms)
const SEARCH_DEBOUNCE_DELAY = 150;

// Time before the "wrapped search" message auto-hides (ms)
const WRAP_MESSAGE_DISPLAY_TIME = 2000;

class FindBar {
  constructor(options = {}) {
    this.findController = options.findController;
    this.onClose = options.onClose || (() => {});

    this.element = null;
    this.inputElement = null;
    this.resultsElement = null;
    this.messageElement = null;

    this._visible = false;
    this._searchTimeout = null;

    this._createUI();
    this._setupEventListeners();
  }

  _createUI() {
    this.element = document.createElement("div");
    this.element.className = "pdf-find-bar hidden";
    this.element.innerHTML = `
      <div class="find-bar-content">
        <div class="find-input-container">
          <input type="text" class="find-input" placeholder="Find in document..." autocomplete="off" aria-label="Find">
          <span class="find-results"></span>
        </div>
        <div class="find-buttons">
          <button class="find-btn find-previous" title="Previous (Shift+Enter)" aria-label="Previous match">
            ${Icons.chevronUp}
          </button>
          <button class="find-btn find-next" title="Next (Enter)" aria-label="Next match">
            ${Icons.chevronDown}
          </button>
        </div>
        <div class="find-separator"></div>
        <div class="find-options">
          <label class="find-option" title="Match case">
            <input type="checkbox" class="find-case-sensitive">
            <span>Aa</span>
          </label>
          <label class="find-option" title="Whole words">
            <input type="checkbox" class="find-entire-word">
            <span>W</span>
          </label>
        </div>
        <div class="find-separator"></div>
        <button class="find-btn find-close" title="Close (Escape)" aria-label="Close">
          ${Icons.close}
        </button>
      </div>
      <div class="find-message hidden"></div>
    `;

    // Cache elements
    this.inputElement = this.element.querySelector(".find-input");
    this.resultsElement = this.element.querySelector(".find-results");
    this.messageElement = this.element.querySelector(".find-message");
    this.prevButton = this.element.querySelector(".find-previous");
    this.nextButton = this.element.querySelector(".find-next");
    this.caseSensitiveCheckbox = this.element.querySelector(".find-case-sensitive");
    this.entireWordCheckbox = this.element.querySelector(".find-entire-word");
    this.closeButton = this.element.querySelector(".find-close");
  }

  _setupEventListeners() {
    // Input changes trigger search (debounced)
    this.inputElement.addEventListener("input", () => {
      this._debounceSearch();
    });

    // Enter to find next, Shift+Enter to find previous
    this.inputElement.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          this.findController?.findPrevious();
        } else {
          this.findController?.findNext();
        }
      } else if (e.key === "Escape") {
        this.close();
      }
    });

    // Navigation buttons
    this.prevButton.addEventListener("click", () => {
      this.findController?.findPrevious();
    });

    this.nextButton.addEventListener("click", () => {
      this.findController?.findNext();
    });

    // Options change trigger new search
    this.caseSensitiveCheckbox.addEventListener("change", () => {
      this._performSearch();
    });

    this.entireWordCheckbox.addEventListener("change", () => {
      this._performSearch();
    });

    // Close button
    this.closeButton.addEventListener("click", () => {
      this.close();
    });

    // Listen for escape key globally when visible
    this._keydownHandler = (e) => {
      if (e.key === "Escape" && this._visible) {
        this.close();
      }
    };
    document.addEventListener("keydown", this._keydownHandler);
  }

  _debounceSearch() {
    if (this._searchTimeout) {
      clearTimeout(this._searchTimeout);
    }
    this._searchTimeout = setTimeout(() => {
      this._performSearch();
    }, SEARCH_DEBOUNCE_DELAY);
  }

  _performSearch() {
    const query = this.inputElement.value;

    this.findController?.find(query, {
      caseSensitive: this.caseSensitiveCheckbox.checked,
      entireWord: this.entireWordCheckbox.checked,
      highlightAll: true
    });
  }

  /**
   * Update the UI based on search state.
   * Called by FindController.
   * @param {number} state - FindState enum value
   * @param {Object} info - Match info
   * @param {number} info.current - Current match index (1-based)
   * @param {number} info.total - Total matches found so far
   * @param {boolean} info.extracting - Whether text extraction is still in progress
   */
  updateState(state, { current, total, extracting = false }) {
    // Track previous total for announcing only on change
    const previousTotal = this._previousTotal;
    this._previousTotal = total;

    // Update results count
    if (total > 0) {
      // Show "X of Y+" while still extracting to indicate more results may appear
      const suffix = extracting ? "+" : "";
      this.resultsElement.textContent = `${current} of ${total}${suffix}`;
      this.resultsElement.classList.remove("not-found");
    } else if (this.inputElement.value) {
      // Show "Searching..." while extracting, "No results" when done
      this.resultsElement.textContent = extracting ? "Searching..." : "No results";
      this.resultsElement.classList.toggle("not-found", !extracting);
    } else {
      this.resultsElement.textContent = "";
      this.resultsElement.classList.remove("not-found");
    }

    // Announce results to screen readers (only when total changes and extraction is done)
    if (total !== previousTotal && !extracting) {
      if (total > 0) {
        getAnnouncer().announce(`${total} ${total === 1 ? "result" : "results"} found`);
      } else if (this.inputElement.value) {
        getAnnouncer().announce("No results found");
      }
    }

    // Show wrapped message
    if (state === FindState.WRAPPED) {
      const wrappedMessage = current === 1 ? "Reached end, continued from beginning" : "Reached beginning, continued from end";
      this.messageElement.textContent = wrappedMessage;
      this.messageElement.classList.remove("hidden");

      // Announce wrap to screen readers
      getAnnouncer().announce(wrappedMessage);

      // Auto-hide after delay
      setTimeout(() => {
        this.messageElement.classList.add("hidden");
      }, WRAP_MESSAGE_DISPLAY_TIME);
    } else {
      this.messageElement.classList.add("hidden");
    }

    // Update button states
    const hasMatches = total > 0;
    this.prevButton.disabled = !hasMatches;
    this.nextButton.disabled = !hasMatches;
  }

  /**
   * Show the find bar.
   */
  open() {
    // Store currently focused element for restoration on close
    this._previousFocusElement = document.activeElement;

    this._visible = true;
    this.element.classList.remove("hidden");
    // Use preventScroll to avoid iOS Safari scrolling the page when focusing
    this.inputElement.focus({ preventScroll: true });
    this.inputElement.select();
  }

  /**
   * Hide the find bar.
   */
  close() {
    this._visible = false;
    this.element.classList.add("hidden");

    // Clear search when closing
    this.inputElement.value = "";
    this.resultsElement.textContent = "";
    this._previousTotal = undefined; // Reset total tracking
    this.findController?.find(""); // Clear highlights

    this.onClose();

    // Restore focus to previously focused element for keyboard accessibility
    if (this._previousFocusElement && typeof this._previousFocusElement.focus === "function") {
      setTimeout(() => {
        this._previousFocusElement?.focus({ preventScroll: true });
        this._previousFocusElement = null;
      }, 0);
    }
  }

  /**
   * Toggle visibility.
   */
  toggle() {
    if (this._visible) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Check if visible.
   */
  get visible() {
    return this._visible
  }

  /**
   * Render the find bar into a container.
   */
  render(container) {
    container.appendChild(this.element);
  }

  /**
   * Clean up. Safe to call multiple times.
   */
  destroy() {
    if (this._keydownHandler) {
      document.removeEventListener("keydown", this._keydownHandler);
      this._keydownHandler = null;
    }
    if (this._searchTimeout) {
      clearTimeout(this._searchTimeout);
      this._searchTimeout = null;
    }
    this.element?.remove();
    this.element = null;
  }
}

class BaseTool {
  constructor(pdfViewer) {
    this.pdfViewer = pdfViewer;
    this.viewer = pdfViewer.viewer;
    this.annotationManager = pdfViewer.annotationManager;
    this.isActive = false;

    // Bind event handlers - use pointer events for unified mouse/touch/pen support
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
  }

  activate() {
    this.isActive = true;
    this._addEventListeners();
    this.onActivate();
  }

  deactivate() {
    this.isActive = false;
    this._removeEventListeners();
    this.onDeactivate();
  }

  _addEventListeners() {
    const container = this.pdfViewer.pagesContainer;
    // Pointer events unify mouse, touch, and pen/stylus input
    container.addEventListener("pointerdown", this._onPointerDown);
    container.addEventListener("pointermove", this._onPointerMove);
    container.addEventListener("pointerup", this._onPointerUp);
    container.addEventListener("pointercancel", this._onPointerUp);
  }

  _removeEventListeners() {
    const container = this.pdfViewer.pagesContainer;
    container.removeEventListener("pointerdown", this._onPointerDown);
    container.removeEventListener("pointermove", this._onPointerMove);
    container.removeEventListener("pointerup", this._onPointerUp);
    container.removeEventListener("pointercancel", this._onPointerUp);
  }

  _onPointerDown(event) {
    if (!this.isActive) return
    this.onPointerDown(event);
  }

  _onPointerMove(event) {
    if (!this.isActive) return
    this.onPointerMove(event);
  }

  _onPointerUp(event) {
    if (!this.isActive) return
    this.onPointerUp(event);
  }

  // Override in subclasses - pointer events work like mouse events but also support touch/pen
  onActivate() {}
  onDeactivate() {}
  onPointerDown(event) {}
  onPointerMove(event) {}
  onPointerUp(event) {}
  onTextLayerReady(pageNumber, textLayer) {}

  destroy() {
    this.deactivate();
  }
}

class SelectTool extends BaseTool {
  constructor(pdfViewer) {
    super(pdfViewer);
    this.cursorStyle = "default";
    this.isSelectingText = false;
  }

  onActivate() {
    this.pdfViewer.pagesContainer.style.cursor = this.cursorStyle;
  }

  onDeactivate() {
    this.pdfViewer.pagesContainer.style.cursor = "default";
    this.pdfViewer.pagesContainer.classList.remove("is-selecting-text");
  }

  onPointerDown(event) {
    // Check if clicking on a text element - if so, user might be starting text selection
    const isTextElement = event.target.matches(".textLayer span, .textLayer br");
    if (isTextElement) {
      this.isSelectingText = true;
      // Disable annotation pointer events during text selection
      this.pdfViewer.pagesContainer.classList.add("is-selecting-text");

      // Capture pointer to ensure we receive pointerup even if released outside container
      // This ensures the is-selecting-text class is always cleaned up properly
      event.target.setPointerCapture(event.pointerId);
    }
  }

  onPointerUp(event) {
    // Release pointer capture if we have it
    if (this.isSelectingText && event.target.hasPointerCapture?.(event.pointerId)) {
      event.target.releasePointerCapture(event.pointerId);
    }

    if (this.isSelectingText) {
      this.isSelectingText = false;
      this.pdfViewer.pagesContainer.classList.remove("is-selecting-text");
    }
  }

  // Select tool allows clicking on annotations to select them
  // The click handling is done in the PdfViewer's annotation rendering
}

class CoordinateTransformer {
  constructor(viewer) {
    this.viewer = viewer;
  }

  // Screen event -> PDF page coordinates (top-left origin)
  screenToPdf(event, pageNumber) {
    const pageContainer = this.viewer.getPageContainer(pageNumber);
    if (!pageContainer) return null

    const rect = pageContainer.getBoundingClientRect();
    const scale = this.viewer.getScale();

    // Get position relative to page element
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    // Scale to PDF coordinates
    const pdfX = screenX / scale;
    const pdfY = screenY / scale;

    return { x: pdfX, y: pdfY, pageNumber }
  }

  // PDF coordinates (top-left origin) -> screen position
  pdfToScreen(x, y, pageNumber) {
    const pageContainer = this.viewer.getPageContainer(pageNumber);
    if (!pageContainer) return null

    const rect = pageContainer.getBoundingClientRect();
    const scale = this.viewer.getScale();

    const screenX = x * scale + rect.left;
    const screenY = y * scale + rect.top;

    return { x: screenX, y: screenY }
  }

  // Convert selection rectangles to quads format
  selectionRectsToQuads(rects, pageNumber) {
    const pageContainer = this.viewer.getPageContainer(pageNumber);
    if (!pageContainer) return []

    const pageRect = pageContainer.getBoundingClientRect();
    const scale = this.viewer.getScale();

    // Minimum size threshold to filter out phantom rects (in PDF coordinates)
    const minSize = 1;

    // Convert to simple rect objects, filtering out invalid/phantom rects
    // Chrome's getClientRects() can return zero-size rects for line breaks,
    // or rects outside the selection area
    const rectArray = Array.from(rects)
      .filter(rect => {
        // Filter out zero-size or tiny rects
        const width = rect.right - rect.left;
        const height = rect.bottom - rect.top;
        if (width < 1 || height < 1) return false

        // Filter out rects that are entirely outside the page
        if (rect.right < pageRect.left || rect.left > pageRect.right) return false
        if (rect.bottom < pageRect.top || rect.top > pageRect.bottom) return false

        return true
      })
      .map(rect => ({
        left: (rect.left - pageRect.left) / scale,
        right: (rect.right - pageRect.left) / scale,
        top: (rect.top - pageRect.top) / scale,
        bottom: (rect.bottom - pageRect.top) / scale
      }))
      .filter(rect => {
        // After conversion to PDF coords, also filter out degenerate rects
        const width = rect.right - rect.left;
        const height = rect.bottom - rect.top;
        if (width < minSize || height < minSize) return false

        // Filter out rects at the very top-left corner (likely phantom rects)
        // Real text selections rarely start at exactly (0,0)
        if (rect.left < minSize && rect.top < minSize) return false

        return true
      });

    const mergedRects = this._mergeOverlappingRects(rectArray);

    return mergedRects.map(rect => ({
      p1: { x: rect.left, y: rect.top },     // top-left
      p2: { x: rect.right, y: rect.top },    // top-right
      p3: { x: rect.left, y: rect.bottom },  // bottom-left
      p4: { x: rect.right, y: rect.bottom }  // bottom-right
    }))
  }

  // Merge overlapping or adjacent rectangles to prevent double-rendering
  _mergeOverlappingRects(rects) {
    if (rects.length === 0) return []

    // First pass: merge rects that overlap vertically AND horizontally
    let working = [...rects];
    let merged = true;

    while (merged) {
      merged = false;
      const result = [];

      for (const rect of working) {
        let didMerge = false;

        for (let i = 0; i < result.length; i++) {
          const existing = result[i];

          // Calculate vertical overlap amount
          const overlapTop = Math.max(rect.top, existing.top);
          const overlapBottom = Math.min(rect.bottom, existing.bottom);
          const overlapHeight = Math.max(0, overlapBottom - overlapTop);

          // Require significant vertical overlap (at least 50% of smaller rect's height)
          // This prevents merging rects from different lines that only slightly overlap
          const rectHeight = rect.bottom - rect.top;
          const existingHeight = existing.bottom - existing.top;
          const minHeight = Math.min(rectHeight, existingHeight);
          const significantVerticalOverlap = overlapHeight > minHeight * 0.5;

          const horizontalOverlap = rect.left < existing.right && rect.right > existing.left;

          // Also merge if they're adjacent horizontally on same line
          const sameLine = Math.abs(rect.top - existing.top) < 3 && Math.abs(rect.bottom - existing.bottom) < 3;
          const horizontallyAdjacent = Math.abs(rect.left - existing.right) < 2 || Math.abs(existing.left - rect.right) < 2;

          if ((significantVerticalOverlap && horizontalOverlap) || (sameLine && horizontallyAdjacent)) {
            // Merge: extend existing rect to encompass both
            result[i] = {
              left: Math.min(existing.left, rect.left),
              right: Math.max(existing.right, rect.right),
              top: Math.min(existing.top, rect.top),
              bottom: Math.max(existing.bottom, rect.bottom)
            };
            didMerge = true;
            merged = true;
            break
          }
        }

        if (!didMerge) {
          result.push({ ...rect });
        }
      }

      working = result;
    }

    return working
  }

  // Convert ink strokes from screen coordinates to PDF coordinates
  strokesToPdfCoords(strokes, pageNumber) {
    const pageContainer = this.viewer.getPageContainer(pageNumber);
    if (!pageContainer) return []

    const pageRect = pageContainer.getBoundingClientRect();
    const scale = this.viewer.getScale();

    return strokes.map(stroke => ({
      points: stroke.points.map(point => ({
        x: (point.x - pageRect.left) / scale,
        y: (point.y - pageRect.top) / scale
      }))
    }))
  }

  // Convert freehand strokes to quads (for freehand highlight)
  strokesPathToQuads(points, thickness, pageNumber) {
    const pageContainer = this.viewer.getPageContainer(pageNumber);
    if (!pageContainer) return []

    const pageRect = pageContainer.getBoundingClientRect();
    const scale = this.viewer.getScale();
    const halfThickness = (thickness / 2) / scale;

    const quads = [];

    for (let i = 1; i < points.length; i++) {
      const p1 = {
        x: (points[i - 1].x - pageRect.left) / scale,
        y: (points[i - 1].y - pageRect.top) / scale
      };
      const p2 = {
        x: (points[i].x - pageRect.left) / scale,
        y: (points[i].y - pageRect.top) / scale
      };

      // Calculate perpendicular offset for stroke width
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.sqrt(dx * dx + dy * dy);

      if (len === 0) continue

      const nx = -dy / len * halfThickness;
      const ny = dx / len * halfThickness;

      quads.push({
        p1: { x: p1.x - nx, y: p1.y - ny },
        p2: { x: p1.x + nx, y: p1.y + ny },
        p3: { x: p2.x - nx, y: p2.y - ny },
        p4: { x: p2.x + nx, y: p2.y + ny }
      });
    }

    return quads
  }

  // Calculate bounding rect from quads
  quadsToBoundingRect(quads) {
    if (quads.length === 0) return null

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const quad of quads) {
      for (const key of ["p1", "p2", "p3", "p4"]) {
        minX = Math.min(minX, quad[key].x);
        minY = Math.min(minY, quad[key].y);
        maxX = Math.max(maxX, quad[key].x);
        maxY = Math.max(maxY, quad[key].y);
      }
    }

    return [minX, minY, maxX - minX, maxY - minY]
  }
}

/**
 * TextSelectionTool - Base class for tools that work with text selection.
 *
 * Provides shared functionality for:
 * - Tracking text selection state
 * - Converting selection to PDF coordinates
 * - Managing mode classes on the pages container
 *
 * Subclasses should implement:
 * - getModeClass(): returns the CSS class to add when tool is active
 * - createAnnotationFromSelection(selection, pageNumber, quads, rect): creates the annotation
 */
class TextSelectionTool extends BaseTool {
  constructor(pdfViewer) {
    super(pdfViewer);
    this.transformer = new CoordinateTransformer(this.viewer);
    this.isSelectingText = false;

    // Touch text selection state (for programmatic selection on touch devices)
    this.touchSelectionStart = null;
    this.isTouchTextSelecting = false;
  }

  /**
   * Returns the CSS class to add to pagesContainer when this tool is active.
   * Subclasses should override this.
   */
  getModeClass() {
    return ""
  }

  onActivate() {
    const modeClass = this.getModeClass();
    if (modeClass) {
      this.pdfViewer.pagesContainer.classList.add(modeClass);
    }
    // Add highlighting class to textLayers (like PDF.js does)
    this._enableTextLayerHighlighting();
    // Add touch listeners for programmatic text selection on touch devices
    this._addTouchListeners();
  }

  onDeactivate() {
    const modeClass = this.getModeClass();
    if (modeClass) {
      this.pdfViewer.pagesContainer.classList.remove(modeClass);
    }
    this.pdfViewer.pagesContainer.classList.remove("is-selecting-text");
    this._disableTextLayerHighlighting();
    this._removeTouchListeners();
    this._cleanupTouchTextSelection();
    this.isSelectingText = false;
  }

  _enableTextLayerHighlighting() {
    const textLayers = this.pdfViewer.pagesContainer.querySelectorAll(".textLayer");
    textLayers.forEach(layer => layer.classList.add("highlighting"));
  }

  _disableTextLayerHighlighting() {
    const textLayers = this.pdfViewer.pagesContainer.querySelectorAll(".textLayer");
    textLayers.forEach(layer => layer.classList.remove("highlighting"));
  }

  onPointerDown(event) {
    // Ignore clicks on annotations or the edit toolbar
    if (event.target.closest(".annotation") || event.target.closest(".annotation-edit-toolbar")) {
      return
    }

    // Check if this is a touch/pen event
    const isTouch = event.pointerType === "touch" || event.pointerType === "pen";

    // Track text selection when clicking on text elements
    const isTextElement = event.target.matches(".textLayer span, .textLayer br");
    if (isTextElement) {
      this.isSelectingText = true;
      this.pdfViewer.pagesContainer.classList.add("is-selecting-text");

      // Capture pointer to ensure we receive pointerup even if released outside container
      // This ensures the is-selecting-text class is always cleaned up properly
      event.target.setPointerCapture(event.pointerId);

      if (isTouch) {
        // On touch devices, implement programmatic text selection
        // since native drag-to-select requires long-press
        this._startTouchTextSelection(event);
      }
      // For mouse, let the browser handle text selection naturally
    }
  }

  onPointerMove(event) {
    if (this.isTouchTextSelecting) {
      this._continueTouchTextSelection(event);
    }
  }

  onPointerUp(event) {
    // Release pointer capture if we have it
    // Check both touch and regular text selection since we now capture for both
    if ((this.isSelectingText || this.isTouchTextSelecting) && event.target.hasPointerCapture?.(event.pointerId)) {
      event.target.releasePointerCapture(event.pointerId);
    }

    // Clear text selection tracking
    if (this.isSelectingText) {
      this.isSelectingText = false;
      this.pdfViewer.pagesContainer.classList.remove("is-selecting-text");
    }

    // Clean up touch text selection state
    if (this.isTouchTextSelecting) {
      this._cleanupTouchTextSelection();
    }

    // Check for text selection
    const selection = window.getSelection();
    if (!selection.isCollapsed) {
      this._handleTextSelection(selection);
    }
  }

  /**
   * Process a text selection and create an annotation.
   * Can be overridden by subclasses for custom handling.
   */
  async _handleTextSelection(selection) {
    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects());

    if (rects.length === 0) return

    // Find which page the selection is on
    const textLayer = range.startContainer.parentElement?.closest(".textLayer");
    if (!textLayer) return

    const pageContainer = textLayer.closest(".pdf-page");
    if (!pageContainer) return

    const pageNumber = parseInt(pageContainer.dataset.pageNumber, 10);

    // Convert rects to quads
    const quads = this.transformer.selectionRectsToQuads(rects, pageNumber);
    if (quads.length === 0) return

    // Calculate bounding rect
    const rect = this.transformer.quadsToBoundingRect(quads);

    // Get selected text
    const selectedText = selection.toString();

    // Clear selection
    selection.removeAllRanges();

    // Let subclass create the annotation
    await this.createAnnotationFromSelection(selectedText, pageNumber, quads, rect);
  }

  /**
   * Creates an annotation from the text selection.
   * Subclasses must implement this method.
   */
  async createAnnotationFromSelection(selectedText, pageNumber, quads, rect) {
    throw new Error("Subclasses must implement createAnnotationFromSelection()")
  }

  // ============================================
  // Touch Event Handlers (for iOS scroll prevention)
  // ============================================

  _addTouchListeners() {
    // Touch events fire before pointer events - we need to prevent default
    // at this level to stop iOS from initiating scroll/drag gestures
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this.pdfViewer.pagesContainer.addEventListener("touchstart", this._onTouchStart, { passive: false });
    this.pdfViewer.pagesContainer.addEventListener("touchmove", this._onTouchMove, { passive: false });
  }

  _removeTouchListeners() {
    if (this._onTouchStart) {
      this.pdfViewer.pagesContainer.removeEventListener("touchstart", this._onTouchStart);
    }
    if (this._onTouchMove) {
      this.pdfViewer.pagesContainer.removeEventListener("touchmove", this._onTouchMove);
    }
  }

  _onTouchStart(event) {
    // Only prevent default when touching text elements or during active selection
    const touch = event.touches[0];
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    const isTextElement = target?.matches(".textLayer span, .textLayer br");

    if (isTextElement || this.isTouchTextSelecting) {
      event.preventDefault();
    }
  }

  _onTouchMove(event) {
    // Prevent scroll during text selection
    if (this.isTouchTextSelecting) {
      event.preventDefault();
      return
    }

    // Also prevent if currently touching a text element
    const touch = event.touches[0];
    if (touch) {
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      if (target?.matches(".textLayer span, .textLayer br")) {
        event.preventDefault();
      }
    }
  }

  // ============================================
  // Programmatic Touch Text Selection
  // ============================================

  _startTouchTextSelection(event) {
    // Prevent default to stop scroll and native text selection behavior
    event.preventDefault();

    // Get the caret position at touch point
    const range = this._caretRangeFromPoint(event.clientX, event.clientY);
    if (!range) return

    // Store the start position
    this.touchSelectionStart = {
      node: range.startContainer,
      offset: range.startOffset
    };
    this.isTouchTextSelecting = true;

    // Add class to indicate touch selection is active
    this.pdfViewer.pagesContainer.classList.add("is-touch-selecting");

    // Capture pointer to receive all move/up events
    event.target.setPointerCapture(event.pointerId);

    // Clear any existing selection
    window.getSelection().removeAllRanges();
  }

  _continueTouchTextSelection(event) {
    if (!this.isTouchTextSelecting || !this.touchSelectionStart) return

    // Prevent scroll during text selection
    event.preventDefault();

    // Get the caret position at current touch point
    const range = this._caretRangeFromPoint(event.clientX, event.clientY);
    if (!range) return

    // Build a selection range from start to current position
    const selection = window.getSelection();
    const selectionRange = document.createRange();

    try {
      // Determine the order (start before end or end before start)
      const startNode = this.touchSelectionStart.node;
      const startOffset = this.touchSelectionStart.offset;
      const endNode = range.startContainer;
      const endOffset = range.startOffset;

      // Compare positions to determine direction
      const position = startNode.compareDocumentPosition(endNode);
      const isForward = position === 0
        ? startOffset <= endOffset
        : !(position & Node.DOCUMENT_POSITION_PRECEDING);

      if (isForward) {
        selectionRange.setStart(startNode, startOffset);
        selectionRange.setEnd(endNode, endOffset);
      } else {
        selectionRange.setStart(endNode, endOffset);
        selectionRange.setEnd(startNode, startOffset);
      }

      // Apply the selection (this makes it visible to the user)
      selection.removeAllRanges();
      selection.addRange(selectionRange);
    } catch (e) {
      // Range operations can throw if nodes are in different documents
      // or other edge cases - just ignore and continue
    }
  }

  _cleanupTouchTextSelection() {
    this.isTouchTextSelecting = false;
    this.touchSelectionStart = null;
    this.pdfViewer.pagesContainer.classList.remove("is-touch-selecting");
  }

  _caretRangeFromPoint(x, y) {
    // Use the standard API if available, with fallback for older browsers
    if (document.caretRangeFromPoint) {
      return document.caretRangeFromPoint(x, y)
    } else if (document.caretPositionFromPoint) {
      // Firefox uses caretPositionFromPoint
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) {
        const range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.setEnd(pos.offsetNode, pos.offset);
        return range
      }
    }
    return null
  }
}

class HighlightTool extends TextSelectionTool {
  constructor(pdfViewer) {
    super(pdfViewer);

    // Freehand state
    this.isFreehand = false;
    this.freehandPoints = [];
    this.freehandPageNumber = null;
    this.freehandCanvas = null;

    // Default freehand thickness (in pixels)
    this.freehandThickness = 24;
  }

  getModeClass() {
    return "highlight-mode"
  }

  onActivate() {
    super.onActivate();
    this._updateSelectionColor();
  }

  onDeactivate() {
    super.onDeactivate();
    this._clearSelectionColor();
    this._cleanupFreehand();
  }

  // Override base class touch handlers to also handle freehand drawing
  _onTouchStart(event) {
    const touch = event.touches[0];
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    const isTextElement = target?.matches(".textLayer span, .textLayer br");

    // Prevent default for text selection, active selection, OR freehand
    if (isTextElement || this.isTouchTextSelecting || this.isFreehand) {
      event.preventDefault();
    }

    // Also prevent for any touch on the PDF page (for freehand drawing)
    // But allow touches on annotations to pass through so they can be selected
    if (target?.closest(".pdf-page") && !target?.closest(".annotation-edit-toolbar") && !target?.closest(".annotation")) {
      event.preventDefault();
    }
  }

  _onTouchMove(event) {
    // Prevent scroll during any active drawing or text selection
    if (this.isTouchTextSelecting || this.isFreehand) {
      event.preventDefault();
      return
    }

    // Also prevent if currently touching a text element
    const touch = event.touches[0];
    if (touch) {
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      if (target?.matches(".textLayer span, .textLayer br")) {
        event.preventDefault();
      }
    }
  }

  setColor(color) {
    this._updateSelectionColor();
  }

  _updateSelectionColor() {
    const color = this.pdfViewer.getHighlightColor() || ColorPicker.DEFAULT_HIGHLIGHT_COLOR;
    // Set CSS variable for text selection highlight with 40% opacity
    this.pdfViewer.pagesContainer.style.setProperty(
      "--selection-highlight-color",
      `${color}66` // Add 40% alpha
    );
  }

  _clearSelectionColor() {
    this.pdfViewer.pagesContainer.style.removeProperty("--selection-highlight-color");
  }

  onPointerDown(event) {
    // Ignore clicks on annotations or the edit toolbar
    if (event.target.closest(".annotation") || event.target.closest(".annotation-edit-toolbar")) {
      return
    }

    // Check if this is a touch/pen event
    const isTouch = event.pointerType === "touch" || event.pointerType === "pen";

    // Check if clicking on an actual text element (span/br inside textLayer)
    // The textLayer covers the entire page, so we need to check for text elements specifically
    const isTextElement = event.target.matches(".textLayer span, .textLayer br");

    if (isTextElement) {
      // Track text selection to disable annotation pointer events during drag
      this.isSelectingText = true;
      this.pdfViewer.pagesContainer.classList.add("is-selecting-text");

      if (isTouch) {
        // On touch devices, implement programmatic text selection
        // since native drag-to-select requires long-press
        this._startTouchTextSelection(event);
      }
      // For mouse, let the browser handle text selection naturally
      return
    }

    // Start freehand mode when clicking outside text elements
    this._startFreehand(event);
  }

  onPointerMove(event) {
    if (this.isFreehand) {
      this._continueFreehand(event);
    } else if (this.isTouchTextSelecting) {
      this._continueTouchTextSelection(event);
    }
  }

  async onPointerUp(event) {
    // Release pointer capture if we have it
    const hasCapture = this.isFreehand || this.isTouchTextSelecting;
    if (hasCapture && event.target.hasPointerCapture?.(event.pointerId)) {
      event.target.releasePointerCapture(event.pointerId);
    }

    // Clear text selection tracking
    if (this.isSelectingText) {
      this.isSelectingText = false;
      this.pdfViewer.pagesContainer.classList.remove("is-selecting-text");
    }

    // Clean up touch text selection state
    if (this.isTouchTextSelecting) {
      this._cleanupTouchTextSelection();
    }

    // Check for text selection first
    const selection = window.getSelection();

    if (!selection.isCollapsed && !this.isFreehand) {
      // Capture selection data before any DOM changes
      const range = selection.getRangeAt(0);
      const rects = Array.from(range.getClientRects());
      const selectedText = selection.toString();
      const textLayer = range.startContainer.parentElement?.closest(".textLayer");

      // Clear selection immediately to avoid interference with DOM updates
      selection.removeAllRanges();

      // Text was selected, create text highlight
      if (rects.length > 0 && textLayer) {
        this._createTextHighlightFromData(rects, selectedText, textLayer);
      }
    } else if (this.isFreehand && this.freehandPoints.length > 1) {
      // Freehand was drawn, create freehand highlight
      // Keep preview visible until annotation is saved
      await this._createFreehandHighlight();
    }

    this._cleanupFreehand();
  }

  _startFreehand(event) {
    // Find which page we're on
    const pageContainer = event.target.closest(".pdf-page");
    if (!pageContainer) return

    // Prevent text selection and clear any existing selection
    event.preventDefault();
    window.getSelection().removeAllRanges();

    this.freehandPageNumber = parseInt(pageContainer.dataset.pageNumber, 10);
    this.isFreehand = true;
    this.freehandPoints = [{ x: event.clientX, y: event.clientY }];

    // Add drawing state class to maintain cursor during drag
    this.pdfViewer.pagesContainer.classList.add("is-drawing");

    // Capture pointer to receive all move/up events even outside the container
    event.target.setPointerCapture(event.pointerId);

    // Create a temporary canvas for drawing
    this._createFreehandCanvas(pageContainer);
    this._drawFreehandPreview();
  }

  _continueFreehand(event) {
    if (!this.isFreehand) return

    // Dedupe consecutive identical points
    const lastPoint = this.freehandPoints[this.freehandPoints.length - 1];
    if (lastPoint.x === event.clientX && lastPoint.y === event.clientY) return

    this.freehandPoints.push({ x: event.clientX, y: event.clientY });
    this._drawFreehandPreview();
  }

  _createFreehandCanvas(pageContainer) {
    const canvas = document.createElement("canvas");
    canvas.className = "freehand-preview";
    canvas.width = pageContainer.offsetWidth;
    canvas.height = pageContainer.offsetHeight;
    canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 100;
    `;
    pageContainer.appendChild(canvas);
    this.freehandCanvas = canvas;
  }

  _drawFreehandPreview() {
    if (!this.freehandCanvas || this.freehandPoints.length < 2) return

    const ctx = this.freehandCanvas.getContext("2d");
    const rect = this.freehandCanvas.getBoundingClientRect();
    const color = this.pdfViewer.getHighlightColor() || ColorPicker.DEFAULT_HIGHLIGHT_COLOR;

    ctx.clearRect(0, 0, this.freehandCanvas.width, this.freehandCanvas.height);

    ctx.strokeStyle = color;
    ctx.lineWidth = this.freehandThickness;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 0.4;

    ctx.beginPath();
    ctx.moveTo(
      this.freehandPoints[0].x - rect.left,
      this.freehandPoints[0].y - rect.top
    );

    for (let i = 1; i < this.freehandPoints.length; i++) {
      ctx.lineTo(
        this.freehandPoints[i].x - rect.left,
        this.freehandPoints[i].y - rect.top
      );
    }
    ctx.stroke();
  }

  _cleanupFreehand() {
    this.isFreehand = false;
    this.freehandPoints = [];
    this.freehandPageNumber = null;

    // Remove drawing state class
    this.pdfViewer.pagesContainer.classList.remove("is-drawing");

    if (this.freehandCanvas) {
      this.freehandCanvas.remove();
      this.freehandCanvas = null;
    }
  }

  async _createTextHighlightFromData(rects, selectedText, textLayer) {
    const pageContainer = textLayer.closest(".pdf-page");
    if (!pageContainer) return

    const pageNumber = parseInt(pageContainer.dataset.pageNumber, 10);

    // Convert rects to quads
    const quads = this.transformer.selectionRectsToQuads(rects, pageNumber);
    if (quads.length === 0) return

    // Calculate bounding rect
    const rect = this.transformer.quadsToBoundingRect(quads);

    // Get current color
    const color = this.pdfViewer.getHighlightColor() || ColorPicker.DEFAULT_HIGHLIGHT_COLOR;

    // Create annotation
    await this.annotationManager.createAnnotation({
      annotation_type: "highlight",
      page: pageNumber,
      quads: quads,
      rect: rect,
      color: color + "CC", // Add alpha
      opacity: 0.4,
      title: selectedText.substring(0, 255),
      subject: "Highlight"
    });
  }

  async _createFreehandHighlight() {
    if (this.freehandPoints.length < 2 || !this.freehandPageNumber) return

    const pageContainer = this.pdfViewer.viewer.getPageContainer(this.freehandPageNumber);
    if (!pageContainer) return

    const pageRect = pageContainer.getBoundingClientRect();
    const scale = this.pdfViewer.viewer.getScale();

    // Convert screen coordinates to PDF coordinates
    const pdfPoints = this.freehandPoints.map(point => ({
      x: (point.x - pageRect.left) / scale,
      y: (point.y - pageRect.top) / scale
    }));

    // Calculate bounding rect
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of pdfPoints) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }

    // Get current color and encode opacity into alpha channel
    // The backend derives opacity from color's alpha (e.g., #FFA50066 = 40% opacity)
    const baseColor = this.pdfViewer.getHighlightColor() || ColorPicker.DEFAULT_HIGHLIGHT_COLOR;
    const opacity = 0.4;
    const alphaHex = Math.round(opacity * 255).toString(16).padStart(2, "0");
    const colorWithAlpha = baseColor + alphaHex;

    // Create ink annotation with highlight styling (thick stroke, low opacity)
    await this.annotationManager.createAnnotation({
      annotation_type: "ink",
      page: this.freehandPageNumber,
      ink_strokes: [{ points: pdfPoints }],
      rect: [minX, minY, maxX - minX, maxY - minY],
      color: colorWithAlpha,
      thickness: this.freehandThickness / scale,
      subject: "Free Highlight"
    });
  }

  // Override to skip base class text handling since we handle it specially
  async createAnnotationFromSelection(selectedText, pageNumber, quads, rect) {
    // Not used - highlight tool handles text selection in onPointerUp directly
    // to support both text selection and freehand modes
  }
}

class UnderlineTool extends TextSelectionTool {
  constructor(pdfViewer) {
    super(pdfViewer);
    this.underlineColor = "#FF0000";
  }

  getModeClass() {
    return "underline-mode"
  }

  onActivate() {
    super.onActivate();
    this.pdfViewer.pagesContainer.style.cursor = "text";
  }

  onDeactivate() {
    super.onDeactivate();
    this.pdfViewer.pagesContainer.style.cursor = "default";
  }

  async createAnnotationFromSelection(selectedText, pageNumber, quads, rect) {
    await this.annotationManager.createAnnotation({
      annotation_type: "line",
      page: pageNumber,
      quads: quads,
      rect: rect,
      color: "#FF0000",
      opacity: 1.0,
      title: selectedText.substring(0, 255),
      subject: "Underline"
    });
  }
}

class NoteTool extends BaseTool {
  constructor(pdfViewer) {
    super(pdfViewer);
    this.transformer = new CoordinateTransformer(this.viewer);
    this.noteDialog = null;
    this.pendingNote = null;
    this._previousFocusElement = null; // For focus restoration on dialog close
  }

  onActivate() {
    this.pdfViewer.pagesContainer.classList.add("note-mode");
  }

  onDeactivate() {
    this.pdfViewer.pagesContainer.classList.remove("note-mode");
    this._closeDialog();
  }

  onPointerDown(event) {
    // Find which page we're clicking on
    const pageContainer = event.target.closest(".pdf-page");
    if (!pageContainer) return

    // Don't create note if clicking on an existing annotation or the edit toolbar
    if (event.target.closest(".annotation") || event.target.closest(".annotation-edit-toolbar")) return

    const pageNumber = parseInt(pageContainer.dataset.pageNumber, 10);
    const coords = this.transformer.screenToPdf(event, pageNumber);

    if (!coords) return

    this.pendingNote = {
      pageNumber,
      x: coords.x,
      y: coords.y
    };

    this._showNoteDialog(event.clientX, event.clientY);
  }

  _showNoteDialog(x, y) {
    // Store currently focused element for restoration on close
    this._previousFocusElement = document.activeElement;

    // Remove any existing dialog (but keep pendingNote)
    this._removeDialog();

    // Create dialog
    this.noteDialog = document.createElement("div");
    this.noteDialog.className = "note-dialog";
    this.noteDialog.innerHTML = `
      <div class="note-dialog-header">
        <span>Add Note</span>
        <button class="note-dialog-close" aria-label="Close">
          ${Icons.close}
        </button>
      </div>
      <textarea class="note-dialog-input" placeholder="Enter your note..." rows="4"></textarea>
      <div class="note-dialog-actions">
        <button class="note-dialog-save">Save</button>
      </div>
    `;

    document.body.appendChild(this.noteDialog);

    // Position dialog, ensuring it stays within viewport bounds
    const { left, top } = this._constrainDialogPosition(x, y);
    this.noteDialog.style.cssText = `
      position: fixed;
      left: ${left}px;
      top: ${top}px;
      z-index: 1000;
    `;

    // Focus the textarea after the browser finishes processing the pointer event
    // Use preventScroll to avoid iOS Safari scrolling the page when focusing
    const textarea = this.noteDialog.querySelector(".note-dialog-input");
    requestAnimationFrame(() => textarea.focus({ preventScroll: true }));

    // Set up event listeners
    this._setupDialogListeners();
  }

  _constrainDialogPosition(x, y) {
    // Get dialog dimensions after it's in the DOM
    const rect = this.noteDialog.getBoundingClientRect();
    const dialogWidth = rect.width;
    const dialogHeight = rect.height;
    const margin = 10;

    let left = x;
    let top = y;

    // Constrain horizontally
    if (left + dialogWidth > window.innerWidth - margin) {
      left = window.innerWidth - dialogWidth - margin;
    }
    if (left < margin) {
      left = margin;
    }

    // Constrain vertically
    if (top + dialogHeight > window.innerHeight - margin) {
      top = window.innerHeight - dialogHeight - margin;
    }
    if (top < margin) {
      top = margin;
    }

    return { left, top }
  }

  _setupDialogListeners() {
    const textarea = this.noteDialog.querySelector(".note-dialog-input");
    const closeBtn = this.noteDialog.querySelector(".note-dialog-close");
    const saveBtn = this.noteDialog.querySelector(".note-dialog-save");

    closeBtn.addEventListener("click", () => this._closeDialog());

    saveBtn.addEventListener("click", async () => {
      const text = textarea.value.trim();
      if (text) {
        await this._createNote(text);
      }
      this._closeDialog();
    });

    // Save on Ctrl+Enter
    textarea.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        const text = textarea.value.trim();
        if (text) {
          this._createNote(text);
        }
        this._closeDialog();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this._closeDialog();
      }
    });
  }

  _removeDialog() {
    if (this.noteDialog) {
      // Blur before removing to prevent scroll when focused element disappears
      document.activeElement?.blur();
      this.noteDialog.remove();
      this.noteDialog = null;
    }
  }

  _closeDialog() {
    this._removeDialog();
    this.pendingNote = null;
  }

  async _createNote(text) {
    if (!this.pendingNote) return

    const { pageNumber, x, y } = this.pendingNote;
    const color = this.pdfViewer.getHighlightColor() || ColorPicker.DEFAULT_HIGHLIGHT_COLOR;

    // Create annotation
    await this.annotationManager.createAnnotation({
      annotation_type: "note",
      page: pageNumber,
      rect: [x, y, 24, 24], // Icon size
      contents: text,
      color: color,
      subject: "Comment"
    });
  }

  // Method to edit an existing note or add/edit a comment on other annotation types
  editNote(annotation) {
    // Store currently focused element for restoration on close
    this._previousFocusElement = document.activeElement;

    // Get the position of the annotation on screen
    const pageContainer = this.viewer.getPageContainer(annotation.page);
    if (!pageContainer) return

    const scale = this.viewer.getScale();
    const x = annotation.rect[0] * scale;
    const y = annotation.rect[1] * scale;
    const rect = pageContainer.getBoundingClientRect();

    // Store the annotation being edited
    this.editingAnnotation = annotation;

    // Determine dialog title based on annotation type and whether contents exists
    const isNote = annotation.annotation_type === "note";
    const hasContents = annotation.contents && annotation.contents.trim();
    let dialogTitle;
    if (isNote) {
      dialogTitle = "Edit Note";
    } else {
      dialogTitle = hasContents ? "Edit Comment" : "Add Comment";
    }

    this._showEditDialog(rect.left + x, rect.top + y, annotation.contents, dialogTitle);
  }

  _showEditDialog(x, y, existingText, title = "Edit Note") {
    // Remove any existing dialog (but keep editingAnnotation)
    this._removeDialog();

    // Create dialog
    this.noteDialog = document.createElement("div");
    this.noteDialog.className = "note-dialog";
    this.noteDialog.innerHTML = `
      <div class="note-dialog-header">
        <span>${title}</span>
        <button class="note-dialog-close" aria-label="Close">
          ${Icons.close}
        </button>
      </div>
      <textarea class="note-dialog-input" rows="4">${existingText || ""}</textarea>
      <div class="note-dialog-actions">
        <button class="note-dialog-save">Save</button>
      </div>
    `;

    document.body.appendChild(this.noteDialog);

    // Position dialog, ensuring it stays within viewport bounds
    const { left, top } = this._constrainDialogPosition(x, y);
    this.noteDialog.style.cssText = `
      position: fixed;
      left: ${left}px;
      top: ${top}px;
      z-index: 1000;
    `;

    // Focus and select all text after the browser finishes processing
    // Use preventScroll to avoid iOS Safari scrolling the page when focusing
    const textarea = this.noteDialog.querySelector(".note-dialog-input");
    requestAnimationFrame(() => {
      textarea.focus({ preventScroll: true });
      textarea.select();
    });

    // Set up event listeners for edit mode
    this._setupEditDialogListeners();
  }

  _setupEditDialogListeners() {
    const textarea = this.noteDialog.querySelector(".note-dialog-input");
    const closeBtn = this.noteDialog.querySelector(".note-dialog-close");
    const saveBtn = this.noteDialog.querySelector(".note-dialog-save");

    closeBtn.addEventListener("click", () => this._closeDialog());

    saveBtn.addEventListener("click", () => {
      const text = textarea.value.trim();
      if (text && this.editingAnnotation) {
        this._updateNote(this.editingAnnotation.id, text);
      }
      this._closeDialog();
    });

    textarea.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        const text = textarea.value.trim();
        if (text && this.editingAnnotation) {
          this._updateNote(this.editingAnnotation.id, text);
        }
        this._closeDialog();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this._closeDialog();
      }
    });
  }

  async _updateNote(annotationId, text) {
    await this.annotationManager.updateAnnotation(annotationId, {
      contents: text
    });
    this.editingAnnotation = null;
  }

  destroy() {
    this._closeDialog();
    super.destroy();
  }
}

// Time to wait before saving a batch of ink strokes (ms)
const BATCH_SAVE_DELAY = 2000;

class InkTool extends BaseTool {
  constructor(pdfViewer) {
    super(pdfViewer);
    this.transformer = new CoordinateTransformer(this.viewer);

    this.isDrawing = false;
    this.currentStroke = null;
    this.currentPageNumber = null;
    this.drawingCanvas = null;
    this.previousColor = null;
    this.inkColor = ColorPicker.DEFAULT_INK_COLOR;

    // Batch save state
    this.pendingStrokes = [];
    this.pendingPageNumber = null;
    this.pendingColor = null;
    this.saveTimeout = null;
  }

  onActivate() {
    this.pdfViewer.pagesContainer.classList.add("ink-mode");
    this._addTouchListeners();

    // Save current color and switch to draw tool's remembered color
    this.previousColor = this.pdfViewer.colorPicker.currentColor;
    this.pdfViewer.colorPicker.setColor(this.inkColor);
  }

  async onDeactivate() {
    this.pdfViewer.pagesContainer.classList.remove("ink-mode");
    this._removeTouchListeners();

    // Remember draw tool's current color before switching away
    this.inkColor = this.pdfViewer.colorPicker.currentColor;

    // Save any pending strokes immediately
    await this._savePendingStrokes();

    // Clean up any in-progress drawing
    this._cleanupCurrentStroke();

    // Restore previous color when leaving draw mode
    if (this.previousColor) {
      this.pdfViewer.colorPicker.setColor(this.previousColor);
      this.previousColor = null;
    }
  }

  _addTouchListeners() {
    // Touch events fire before pointer events - prevent default to stop iOS scroll
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this.pdfViewer.pagesContainer.addEventListener("touchstart", this._onTouchStart, { passive: false });
    this.pdfViewer.pagesContainer.addEventListener("touchmove", this._onTouchMove, { passive: false });
  }

  _removeTouchListeners() {
    this.pdfViewer.pagesContainer.removeEventListener("touchstart", this._onTouchStart);
    this.pdfViewer.pagesContainer.removeEventListener("touchmove", this._onTouchMove);
  }

  _onTouchStart(event) {
    // Prevent scroll when touching the PDF page
    // But allow touches on annotations to pass through so they can be selected
    const touch = event.touches[0];
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    if (target?.closest(".pdf-page") && !target?.closest(".annotation-edit-toolbar") && !target?.closest(".annotation")) {
      event.preventDefault();
    }
  }

  _onTouchMove(event) {
    // Prevent scroll during drawing
    if (this.isDrawing) {
      event.preventDefault();
    }
  }

  async onPointerDown(event) {
    // Find which page we're on
    const pageContainer = event.target.closest(".pdf-page");
    if (!pageContainer) return

    // Don't draw on annotations or the edit toolbar
    if (event.target.closest(".annotation") || event.target.closest(".annotation-edit-toolbar")) return

    const pageNumber = parseInt(pageContainer.dataset.pageNumber, 10);

    // If drawing on a different page, save pending strokes first
    if (this.pendingStrokes.length > 0 && this.pendingPageNumber !== pageNumber) {
      await this._savePendingStrokes();
    }

    this.currentPageNumber = pageNumber;
    this.isDrawing = true;
    this.currentStroke = {
      points: [{ x: event.clientX, y: event.clientY }]
    };

    // Add drawing state class to maintain cursor during drag
    this.pdfViewer.pagesContainer.classList.add("is-drawing");

    // Capture pointer to receive all move/up events even outside the container
    event.target.setPointerCapture(event.pointerId);

    // Create drawing canvas for this stroke
    this._createDrawingCanvas(pageContainer);

    event.preventDefault();
  }

  onPointerMove(event) {
    if (!this.isDrawing || !this.currentStroke) return

    // Dedupe consecutive identical points
    const lastPoint = this.currentStroke.points[this.currentStroke.points.length - 1];
    if (lastPoint.x === event.clientX && lastPoint.y === event.clientY) return

    this.currentStroke.points.push({ x: event.clientX, y: event.clientY });
    this._drawCurrentStroke();
  }

  async onPointerUp(event) {
    if (!this.isDrawing || !this.currentStroke) return

    // Release pointer capture
    if (event.target.hasPointerCapture?.(event.pointerId)) {
      event.target.releasePointerCapture(event.pointerId);
    }

    // Remove drawing state class
    this.pdfViewer.pagesContainer.classList.remove("is-drawing");

    // Add stroke to pending batch if it has enough points
    if (this.currentStroke.points.length > 1) {
      this._addToPendingBatch();
    }

    // Clean up canvas immediately
    this._cleanupCurrentStroke();

    // Schedule batch save
    this._scheduleBatchSave();
  }

  _createDrawingCanvas(pageContainer) {
    const canvas = document.createElement("canvas");
    canvas.className = "ink-drawing-canvas";
    canvas.width = pageContainer.offsetWidth;
    canvas.height = pageContainer.offsetHeight;
    canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 50;
    `;
    pageContainer.appendChild(canvas);
    this.drawingCanvas = canvas;
  }

  _drawCurrentStroke() {
    if (!this.drawingCanvas || !this.currentStroke) return

    const ctx = this.drawingCanvas.getContext("2d");
    const rect = this.drawingCanvas.getBoundingClientRect();

    // Get current stroke color
    const color = this.pdfViewer.getHighlightColor() || ColorPicker.DEFAULT_INK_COLOR;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const points = this.currentStroke.points;
    if (points.length < 2) return

    // Draw only the last segment for performance
    ctx.beginPath();
    ctx.moveTo(
      points[points.length - 2].x - rect.left,
      points[points.length - 2].y - rect.top
    );
    ctx.lineTo(
      points[points.length - 1].x - rect.left,
      points[points.length - 1].y - rect.top
    );
    ctx.stroke();
  }

  _addToPendingBatch() {
    const pageContainer = this.pdfViewer.viewer.getPageContainer(this.currentPageNumber);
    if (!pageContainer) return

    const pageRect = pageContainer.getBoundingClientRect();
    const scale = this.pdfViewer.viewer.getScale();
    const color = this.pdfViewer.getHighlightColor() || ColorPicker.DEFAULT_INK_COLOR;

    // Convert stroke to PDF coordinates
    const pdfPoints = this.currentStroke.points.map(point => ({
      x: (point.x - pageRect.left) / scale,
      y: (point.y - pageRect.top) / scale
    }));

    // Create temporary SVG element for immediate visual feedback
    const tempElement = this._createTempStrokeElement(pdfPoints, color, pageContainer, scale);

    // Add to pending batch
    this.pendingStrokes.push({ pdfPoints, tempElement });
    this.pendingPageNumber = this.currentPageNumber;
    this.pendingColor = color;
  }

  _createTempStrokeElement(pdfPoints, color, pageContainer, scale) {
    // Create SVG element
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("ink-temp-stroke");
    svg.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 45;
      overflow: visible;
    `;

    // Create polyline for the stroke
    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    const pointsStr = pdfPoints.map(p => `${p.x * scale},${p.y * scale}`).join(" ");
    polyline.setAttribute("points", pointsStr);
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", color);
    polyline.setAttribute("stroke-width", "2");
    polyline.setAttribute("stroke-linecap", "round");
    polyline.setAttribute("stroke-linejoin", "round");

    svg.appendChild(polyline);
    pageContainer.appendChild(svg);

    return svg
  }

  _scheduleBatchSave() {
    // Clear any existing timeout
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    // Schedule save after delay
    this.saveTimeout = setTimeout(() => {
      this._savePendingStrokes();
    }, BATCH_SAVE_DELAY);
  }

  async _savePendingStrokes() {
    // Clear timeout
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    if (this.pendingStrokes.length === 0 || !this.pendingPageNumber) return

    const pageContainer = this.pdfViewer.viewer.getPageContainer(this.pendingPageNumber);
    if (!pageContainer) return

    // Capture pending state
    const strokesToSave = this.pendingStrokes;
    const pageNumber = this.pendingPageNumber;
    const color = this.pendingColor;

    // Clear pending state
    this.pendingStrokes = [];
    this.pendingPageNumber = null;
    this.pendingColor = null;

    // Calculate bounding rect for all strokes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const inkStrokes = strokesToSave.map(stroke => {
      for (const point of stroke.pdfPoints) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
      return { points: stroke.pdfPoints }
    });

    // Create annotation
    await this.annotationManager.createAnnotation({
      annotation_type: "ink",
      page: pageNumber,
      ink_strokes: inkStrokes,
      rect: [minX, minY, maxX - minX, maxY - minY],
      color: color,
      subject: "Free Hand"
    });

    // Remove temp elements after annotation is created
    for (const stroke of strokesToSave) {
      if (stroke.tempElement) {
        stroke.tempElement.remove();
      }
    }
  }

  _cleanupCurrentStroke() {
    this.currentStroke = null;
    this.isDrawing = false;

    if (this.drawingCanvas) {
      this.drawingCanvas.remove();
      this.drawingCanvas = null;
    }
  }

  destroy() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    // Remove any temp elements
    for (const stroke of this.pendingStrokes) {
      if (stroke.tempElement) {
        stroke.tempElement.remove();
      }
    }
    this.pendingStrokes = [];
    this._cleanupCurrentStroke();
    super.destroy();
  }
}

const ToolMode = {
  SELECT: "select",
  HIGHLIGHT: "highlight",
  UNDERLINE: "underline",
  NOTE: "note",
  INK: "ink"
};

class PdfViewer {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.documentUrl = options.documentUrl;
    this.documentName = options.documentName;
    this.organizationName = options.organizationName;
    this.annotationsUrl = options.annotationsUrl;
    this.trackingUrl = options.trackingUrl;
    this.userName = options.userName;
    this.documentId = options.documentId;
    this.initialPage = options.initialPage || 1;
    this.initialAnnotation = options.initialAnnotation;

    this.currentTool = null;
    this.currentMode = ToolMode.SELECT;
    this.selectedAnnotation = null;
    this.selectedAnnotationElement = null;
    this.pendingAnnotationSelection = null; // Annotation ID to select when rendered
    this._currentPage = 1; // Track current page for change detection

    this._setupContainer();
    this._initializeComponents();
    this._setupEventListeners();
  }

  _setupContainer() {
    // Use existing HTML structure from template
    this.toolbarContainer = this.container.querySelector(".pdf-viewer-toolbar");
    this.bodyContainer = this.container.querySelector(".pdf-viewer-body");
    this.pagesContainer = this.container.querySelector(".pdf-pages-container");

    // Create undo bar container if not present
    this.undoBarContainer = this.container.querySelector(".pdf-undo-bar");
    if (!this.undoBarContainer) {
      this.undoBarContainer = document.createElement("div");
      this.undoBarContainer.className = "pdf-undo-bar";
      this.container.appendChild(this.undoBarContainer);
    }
  }

  _initializeComponents() {
    if (!this.pagesContainer) {
      console.error("[PdfViewer] ERROR: .pdf-pages-container not found!");
      return
    }

    // Core viewer (PDF.js wrapper with lazy rendering and events)
    this.viewer = new CoreViewer(this.pagesContainer, {
      initialScale: 1.0
    });

    // Subscribe to core viewer events
    this._setupViewerEvents();

    // Annotation manager for CRUD operations
    // Accepts custom store, falls back to REST store if URL provided, else memory store
    this.annotationManager = new AnnotationManager({
      store: this.options.annotationStore,
      annotationsUrl: this.annotationsUrl,
      documentId: this.documentId,
      eventTarget: this.container, // For dispatching error events
      onAnnotationCreated: this._onAnnotationCreated.bind(this),
      onAnnotationUpdated: this._onAnnotationUpdated.bind(this),
      onAnnotationDeleted: this._onAnnotationDeleted.bind(this)
    });

    // Watermark overlay
    this.watermark = new Watermark(this.userName);

    // Download manager
    this.downloadManager = new DownloadManager({
      documentUrl: this.documentUrl,
      documentName: this.documentName,
      organizationName: this.organizationName,
      userName: this.userName,
      annotationManager: this.annotationManager
    });

    // UI Components
    this.annotationEditToolbar = new AnnotationEditToolbar({
      onColorChange: this._onAnnotationColorChange.bind(this),
      onDelete: this._onAnnotationDelete.bind(this),
      onEdit: this._onAnnotationEdit.bind(this),
      onComment: this._onAnnotationComment.bind(this),
      onDeselect: this._deselectAnnotation.bind(this)
    });

    this.undoBar = new UndoBar(this.undoBarContainer, {
      onUndo: this._onAnnotationUndo.bind(this)
    });

    this.colorPicker = new ColorPicker({
      onChange: this._onColorChange.bind(this)
    });

    // Thumbnail sidebar (inserted before pages container in the body)
    if (this.bodyContainer) {
      this.thumbnailSidebar = new ThumbnailSidebar({
        container: this.bodyContainer,
        viewer: this.viewer,
        eventBus: this.viewer.eventBus,
        onPageClick: (pageNumber) => this.viewer.goToPage(pageNumber)
      });

      // Annotation sidebar - check for user-defined element, fallback to auto-generated
      const annotationSidebarEl = this.container.querySelector('[data-pdf-sidebar="annotations"]');
      const annotationItemTemplate = this.container.querySelector('[data-pdf-template="annotation-item"]');

      this.annotationSidebar = new AnnotationSidebar({
        element: annotationSidebarEl,           // null if not provided (triggers fallback)
        itemTemplate: annotationItemTemplate,   // null if not provided (uses innerHTML)
        container: this.bodyContainer,          // Used for fallback
        annotationManager: this.annotationManager,
        onAnnotationClick: (annotationId) => this._scrollToAnnotationWithFlash(annotationId)
      });
    }

    // Find controller and find bar
    this.findController = new FindController(this, {
      onUpdateState: (state, matchInfo) => {
        this.findBar?.updateState(state, matchInfo);
      }
    });

    this.findBar = new FindBar({
      findController: this.findController,
      onClose: () => {
        // Focus returns to document when find bar closes
      }
    });

    // Initialize tools
    this.tools = {
      [ToolMode.SELECT]: new SelectTool(this),
      [ToolMode.HIGHLIGHT]: new HighlightTool(this),
      [ToolMode.UNDERLINE]: new UnderlineTool(this),
      [ToolMode.NOTE]: new NoteTool(this),
      [ToolMode.INK]: new InkTool(this)
    };
  }

  /**
   * Set up event listeners for the core viewer.
   * Uses the EventBus for internal communication.
   */
  _setupViewerEvents() {
    const eventBus = this.viewer.eventBus;

    // Document loaded - dispatch ready event
    eventBus.on(ViewerEvents.DOCUMENT_LOADED, ({ pageCount }) => {
      this._onDocumentLoaded(pageCount);
    });

    // Page rendered - apply watermark and render annotations
    eventBus.on(ViewerEvents.PAGE_RENDERED, ({ pageNumber, canvas, container }) => {
      this._onPageRendered(pageNumber, canvas, container);
    });

    // Text layer ready - notify tools and find controller
    eventBus.on(ViewerEvents.TEXT_LAYER_RENDERED, ({ pageNumber, textLayer }) => {
      this._onTextLayerRendered(pageNumber, textLayer);
      this.findController?.onTextLayerRendered(pageNumber);
    });

    // Scale changed - dispatch event
    eventBus.on(ViewerEvents.SCALE_CHANGED, ({ scale, previousScale }) => {
      this._dispatchEvent("pdf-viewer:scale-changed", { scale, previousScale });
    });

    // Scroll - track page changes
    eventBus.on(ViewerEvents.SCROLL, () => {
      this._checkPageChange();
    });
  }

  /**
   * Called when the PDF document is loaded.
   */
  _onDocumentLoaded(pageCount) {
    this._currentPage = 1;
    this._dispatchEvent("pdf-viewer:ready", {
      pageCount,
      currentPage: 1
    });
  }

  /**
   * Check if the current page has changed and dispatch event if so.
   */
  _checkPageChange() {
    const newPage = this.viewer.getCurrentPage();
    if (newPage !== this._currentPage) {
      const previousPage = this._currentPage;
      this._currentPage = newPage;
      this._dispatchEvent("pdf-viewer:page-changed", {
        currentPage: newPage,
        previousPage,
        pageCount: this.viewer.getPageCount()
      });
    }
  }

  /**
   * Dispatch a custom event on the container element.
   * @param {string} eventName
   * @param {Object} detail
   */
  _dispatchEvent(eventName, detail) {
    this.container.dispatchEvent(new CustomEvent(eventName, {
      bubbles: true,
      detail
    }));
  }

  _setupEventListeners() {
    // Handle visibility change for time tracking
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this._pauseTracking();
      } else {
        this._resumeTracking();
      }
    });

    // Deselect annotation when clicking outside
    this.pagesContainer.addEventListener("click", (e) => {
      // Don't deselect if clicking on an annotation or the edit toolbar
      if (e.target.closest(".annotation") || e.target.closest(".annotation-edit-toolbar")) {
        return
      }
      this._deselectAnnotation();
    });

    // Handle error events from annotation manager and other components
    this.container.addEventListener("pdf-viewer:error", (e) => {
      this._handleError(e.detail);
    });
  }

  /**
   * Handle errors from PDF viewer components.
   * Calls optional onError callback and dispatches event for UI feedback.
   */
  _handleError({ source, errorType, message, error }) {
    // Call optional error handler if provided
    if (this.options.onError) {
      const errorObj = error instanceof Error ? error : new Error(message);
      errorObj.name = `PdfViewer.${source}.${errorType}`;
      this.options.onError(errorObj);
    }

    // Re-dispatch as a more specific event that UI can listen for
    this.container.dispatchEvent(new CustomEvent("pdf-viewer:user-error", {
      bubbles: true,
      detail: { source, errorType, message }
    }));
  }

  async load() {
    try {
      // Load the PDF document
      await this.viewer.load(this.documentUrl);

      // Initialize find controller with the loaded document
      if (this.findController && this.viewer.pdfDocument) {
        this.findController.setDocument(this.viewer.pdfDocument);
      }

      // Initialize thumbnail sidebar with the loaded document
      if (this.thumbnailSidebar && this.viewer.pdfDocument) {
        await this.thumbnailSidebar.setDocument(this.viewer.pdfDocument);
      }

      // Load existing annotations from store
      await this.annotationManager.loadAnnotations();

      // Render annotations on all rendered pages
      this._renderAnnotations();

      // Navigate to initial page if specified
      if (this.initialPage > 1) {
        this.viewer.goToPage(this.initialPage);
      }

      // Navigate to initial annotation if specified
      if (this.initialAnnotation) {
        this._scrollToAnnotation(this.initialAnnotation);
      }

      // Start with select tool
      this.setTool(ToolMode.SELECT);

      // Start time tracking
      this._startTracking();
    } catch (error) {
      console.error("Failed to load PDF viewer:", error);
      throw error
    }
  }

  setTool(mode) {
    // Deactivate current tool
    if (this.currentTool) {
      this.currentTool.deactivate();
    }

    // Deselect any selected annotation when switching tools
    this._deselectAnnotation();

    // Activate new tool
    this.currentMode = mode;
    this.currentTool = this.tools[mode];

    if (this.currentTool) {
      this.currentTool.activate();
    }

    // Dispatch event for toolbar to update
    this.container.dispatchEvent(new CustomEvent("pdf-viewer:mode-changed", {
      bubbles: true,
      detail: { mode }
    }));
  }

  getHighlightColor() {
    return this.colorPicker.currentColor
  }

  /**
   * Toggle the find bar visibility.
   */
  toggleFindBar() {
    this.findBar?.toggle();
  }

  /**
   * Open the find bar.
   */
  openFindBar() {
    this.findBar?.open();
  }

  /**
   * Close the find bar.
   */
  closeFindBar() {
    this.findBar?.close();
  }

  /**
   * Get the current page number.
   * @returns {number}
   */
  getCurrentPage() {
    return this.viewer?.getCurrentPage() || 1
  }

  /**
   * Get the total page count.
   * @returns {number}
   */
  getPageCount() {
    return this.viewer?.getPageCount() || 0
  }

  /**
   * Get the current zoom scale.
   * @returns {number}
   */
  getScale() {
    return this.viewer?.getScale() || 1
  }

  /**
   * Navigate to a specific page.
   * @param {number} pageNumber
   */
  goToPage(pageNumber) {
    this.viewer?.goToPage(pageNumber);
    // Check and dispatch page change event
    this._checkPageChange();
  }

  // Page rendering callbacks
  _onPageRendered(pageNumber, pageCanvas, pageContainer) {
    // Apply watermark to the page (pass effective scale for proper font sizing)
    const effectiveScale = this.viewer.getScale() * this.viewer.devicePixelRatio;
    this.watermark.applyToPage(pageCanvas, effectiveScale);

    // Render annotations for this page
    this._renderAnnotationsForPage(pageNumber, pageContainer);
  }

  _onTextLayerRendered(pageNumber, textLayer) {
    // Text layer is ready for text selection tools
    if (this.currentTool && this.currentTool.onTextLayerReady) {
      this.currentTool.onTextLayerReady(pageNumber, textLayer);
    }
  }

  // Annotation callbacks
  _onAnnotationCreated(annotation) {
    this._renderAnnotationsForPage(annotation.page, this.viewer.getPageContainer(annotation.page));

    // Auto-select the newly created annotation
    const pageContainer = this.viewer.getPageContainer(annotation.page);
    const element = pageContainer?.querySelector(`[data-annotation-id="${annotation.id}"]`);
    if (element) {
      this._selectAnnotation(annotation, element);
    }

    // Notify annotation sidebar
    this.annotationSidebar?.onAnnotationCreated(annotation);

    // Announce to screen readers
    const typeLabel = this._getAnnotationTypeLabel(annotation.annotation_type);
    getAnnouncer().announce(`${typeLabel} added on page ${annotation.page}`);

    this.container.dispatchEvent(new CustomEvent("pdf-viewer:annotation-created", {
      bubbles: true,
      detail: { annotation }
    }));
  }

  _onAnnotationUpdated(annotation) {
    // Remember if this annotation was selected
    const wasSelected = this.selectedAnnotation && this.selectedAnnotation.id === annotation.id;

    // Hide toolbar before re-render (it will be re-shown after)
    if (wasSelected) {
      this.annotationEditToolbar.hide();
    }

    this._renderAnnotationsForPage(annotation.page, this.viewer.getPageContainer(annotation.page));

    // Re-select the annotation after re-render
    if (wasSelected) {
      const pageContainer = this.viewer.getPageContainer(annotation.page);
      const element = pageContainer?.querySelector(`[data-annotation-id="${annotation.id}"]`);
      if (element) {
        // Get the fresh annotation data from the manager
        const updatedAnnotation = this.annotationManager.getAnnotation(annotation.id);
        if (updatedAnnotation) {
          // Directly set selection state without going through _selectAnnotation
          // to avoid the ID match short-circuit
          this.selectedAnnotation = updatedAnnotation;
          this.selectedAnnotationElement = element;
          element.classList.add("selected");
          this.annotationEditToolbar.show(updatedAnnotation, element);
        }
      }
    }

    // Notify annotation sidebar
    this.annotationSidebar?.onAnnotationUpdated(annotation);

    // Announce to screen readers
    const typeLabel = this._getAnnotationTypeLabel(annotation.annotation_type);
    getAnnouncer().announce(`${typeLabel} updated`);
  }

  _onAnnotationDeleted(annotation) {
    // Deselect if this annotation was selected
    if (this.selectedAnnotation && this.selectedAnnotation.id === annotation.id) {
      this._deselectAnnotation();
    }

    // Show undo bar
    this.undoBar.show(annotation);

    this._renderAnnotationsForPage(annotation.page, this.viewer.getPageContainer(annotation.page));

    // Notify annotation sidebar
    this.annotationSidebar?.onAnnotationDeleted(annotation);

    // Announce to screen readers
    const typeLabel = this._getAnnotationTypeLabel(annotation.annotation_type);
    getAnnouncer().announce(`${typeLabel} deleted. Press Control Z to undo.`);

    this.container.dispatchEvent(new CustomEvent("pdf-viewer:annotation-deleted", {
      bubbles: true,
      detail: { annotation }
    }));
  }

  _onAnnotationEdit(annotation) {
    // For notes, show the edit popup
    if (annotation.annotation_type === "note") {
      this.tools[ToolMode.NOTE].editNote(annotation);
    }
  }

  _onAnnotationComment(annotation) {
    // For highlight/underline/ink, use the note tool's edit dialog to edit contents
    const supportsComment = ["highlight", "line", "ink"].includes(annotation.annotation_type);
    if (supportsComment) {
      this.tools[ToolMode.NOTE].editNote(annotation);
    }
  }

  async _onAnnotationDelete(annotation) {
    await this.annotationManager.deleteAnnotation(annotation.id);
  }

  async _onAnnotationUndo(annotation) {
    await this.annotationManager.restoreAnnotation(annotation.id);
    this._renderAnnotationsForPage(annotation.page, this.viewer.getPageContainer(annotation.page));

    // Announce to screen readers
    const typeLabel = this._getAnnotationTypeLabel(annotation.annotation_type);
    getAnnouncer().announce(`${typeLabel} restored`);
  }

  /**
   * Get human-readable label for annotation type.
   * @param {string} type - Annotation type (highlight, note, ink, line)
   * @returns {string} Human-readable label
   */
  _getAnnotationTypeLabel(type) {
    switch (type) {
      case "highlight": return "Highlight"
      case "note": return "Note"
      case "ink": return "Drawing"
      case "line": return "Underline"
      default: return "Annotation"
    }
  }

  _onColorChange(color) {
    // Update current tool color if applicable
    if (this.currentTool && this.currentTool.setColor) {
      this.currentTool.setColor(color);
    }
  }

  // Render all annotations
  _renderAnnotations() {
    const pageCount = this.viewer.getPageCount();
    for (let page = 1; page <= pageCount; page++) {
      const pageContainer = this.viewer.getPageContainer(page);
      if (pageContainer) {
        this._renderAnnotationsForPage(page, pageContainer);
      }
    }
  }

  _renderAnnotationsForPage(pageNumber, pageContainer) {
    if (!pageContainer) return

    const annotations = this.annotationManager.getAnnotationsForPage(pageNumber);

    // Clear existing layers (including SVG layers so they're re-created after the new canvas)
    const existingLayers = pageContainer.querySelectorAll(".annotation-layer, .highlight-blend-layer, .highlight-svg-layer, .underline-svg-layer");
    existingLayers.forEach(layer => layer.remove());

    // Get page dimensions for percentage-based positioning
    const pageWidth = parseFloat(pageContainer.style.getPropertyValue("--page-width")) || 612;
    const pageHeight = parseFloat(pageContainer.style.getPropertyValue("--page-height")) || 792;

    // Create SVG layer for highlight rendering (sibling of canvas, for blend mode)
    const highlightSvgLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    highlightSvgLayer.classList.add("highlight-svg-layer");

    // Create separate SVG layer for underlines (no blend mode needed)
    const underlineSvgLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    underlineSvgLayer.classList.add("underline-svg-layer");

    // Insert right after canvas
    const canvas = pageContainer.querySelector("canvas.pdf-canvas");
    if (canvas) {
      canvas.after(highlightSvgLayer);
      highlightSvgLayer.after(underlineSvgLayer);
    } else {
      pageContainer.appendChild(highlightSvgLayer);
      pageContainer.appendChild(underlineSvgLayer);
    }

    // Set viewBox to page dimensions - SVG will scale with the page container
    // Using unscaled coordinates so annotations scale automatically with zoom
    highlightSvgLayer.setAttribute("viewBox", `0 0 ${pageWidth} ${pageHeight}`);
    underlineSvgLayer.setAttribute("viewBox", `0 0 ${pageWidth} ${pageHeight}`);

    // Create annotation layer for interactive elements
    const annotationLayer = document.createElement("div");
    annotationLayer.className = "annotation-layer";

    // Render each annotation using percentage-based positioning
    for (const annotation of annotations) {
      const isHighlight = annotation.annotation_type === "highlight" ||
                         (annotation.annotation_type === "ink" && annotation.subject === "Free Highlight");
      const isUnderline = annotation.annotation_type === "line";

      if (isHighlight) {
        // Render colored SVG in the highlight layer (has mix-blend-mode for text visibility)
        // Uses unscaled coordinates - viewBox handles scaling
        this._renderHighlightSvg(annotation, highlightSvgLayer);
        // Create transparent interactive element in annotation layer
        const element = this._createHighlightInteractive(annotation, pageWidth, pageHeight);
        if (element) {
          this._attachAnnotationClickHandler(element, annotation.id);
          annotationLayer.appendChild(element);
        }
      } else if (isUnderline) {
        // Render underlines as SVG lines in the underline layer (no blend mode)
        this._renderUnderlineSvg(annotation, underlineSvgLayer);
        // Create transparent interactive element in annotation layer
        const element = this._createUnderlineInteractive(annotation, pageWidth, pageHeight);
        if (element) {
          this._attachAnnotationClickHandler(element, annotation.id);
          annotationLayer.appendChild(element);
        }
      } else {
        // Other annotations go directly in annotation layer
        const element = this._createAnnotationElement(annotation, pageWidth, pageHeight);
        if (element) {
          this._attachAnnotationClickHandler(element, annotation.id);
          annotationLayer.appendChild(element);
        }
      }
    }

    // Annotation layer goes at the end (above text layer)
    pageContainer.appendChild(annotationLayer);

    // Check if there's a pending annotation to select on this page
    if (this.pendingAnnotationSelection) {
      // Use .annotation class to avoid matching SVG elements
      const element = annotationLayer.querySelector(`.annotation[data-annotation-id="${this.pendingAnnotationSelection}"]`);
      if (element) {
        const annotation = this.annotationManager.getAnnotation(this.pendingAnnotationSelection);
        const shouldFlash = this.pendingAnnotationFlash === this.pendingAnnotationSelection;
        this.pendingAnnotationSelection = null;
        this.pendingAnnotationFlash = null;

        // Scroll annotation to center of the PDF container
        // Use manual scroll instead of scrollIntoView() to avoid scrolling ancestors
        const container = this.viewer.container;
        const containerRect = container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const elementCenterY = elementRect.top + elementRect.height / 2 - containerRect.top;
        const elementCenterX = elementRect.left + elementRect.width / 2 - containerRect.left;
        const containerCenterY = containerRect.height / 2;
        const containerCenterX = containerRect.width / 2;
        const scrollOffsetY = elementCenterY - containerCenterY;
        const scrollOffsetX = elementCenterX - containerCenterX;

        container.scrollTo({
          top: container.scrollTop + scrollOffsetY,
          left: container.scrollLeft + scrollOffsetX,
          behavior: "smooth"
        });

        setTimeout(() => {
          this._selectAnnotation(annotation, element);
          // Apply flash if requested (from sidebar click)
          if (shouldFlash) {
            element.classList.add("flashing");
            setTimeout(() => {
              element.classList.remove("flashing");
            }, 1500);
          }
        }, 300);
      }
    }
  }

  _attachAnnotationClickHandler(element, annotationId) {
    element.style.pointerEvents = "auto";
    element.addEventListener("click", (e) => {
      e.stopPropagation();
      const currentAnnotation = this.annotationManager.getAnnotation(annotationId);
      if (currentAnnotation) {
        this._selectAnnotation(currentAnnotation, element);
      }
    });
  }

  // Render highlight as SVG in the blend layer (for mix-blend-mode to work)
  // Uses unscaled PDF coordinates - SVG viewBox handles scaling
  _renderHighlightSvg(annotation, svgLayer) {
    if (annotation.annotation_type === "ink") {
      this._renderFreehandHighlightSvg(annotation, svgLayer);
      return
    }

    if (!annotation.quads || annotation.quads.length === 0) return

    // Parse color
    let color = annotation.color || ColorPicker.DEFAULT_HIGHLIGHT_COLOR;
    let opacity = annotation.opacity || 0.4;
    if (color.length === 9 && color.startsWith("#")) {
      const alphaHex = color.slice(7, 9);
      opacity = parseInt(alphaHex, 16) / 255;
      color = color.slice(0, 7);
    }

    // Create a rect for each quad (unscaled coordinates)
    for (const quad of annotation.quads) {
      const x = Math.min(quad.p1.x, quad.p3.x);
      const y = Math.min(quad.p1.y, quad.p2.y);
      const width = Math.abs(quad.p2.x - quad.p1.x);
      const height = Math.abs(quad.p3.y - quad.p1.y);

      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", y);
      rect.setAttribute("width", width);
      rect.setAttribute("height", height);
      rect.setAttribute("fill", color);
      rect.setAttribute("fill-opacity", opacity);
      rect.dataset.annotationId = annotation.id;
      svgLayer.appendChild(rect);
    }
  }

  // Render freehand highlight as SVG path (unscaled coordinates)
  _renderFreehandHighlightSvg(annotation, svgLayer) {
    const strokes = annotation.ink_strokes || [];
    if (strokes.length === 0) return

    const thickness = annotation.thickness || 12;

    // Parse color
    let color = annotation.color || ColorPicker.DEFAULT_HIGHLIGHT_COLOR;
    let opacity = 0.4;
    if (color.length === 9 && color.startsWith("#")) {
      const alphaHex = color.slice(7, 9);
      opacity = parseInt(alphaHex, 16) / 255;
      color = color.slice(0, 7);
    } else {
      opacity = annotation.opacity || 0.4;
    }

    for (const stroke of strokes) {
      const points = stroke.points || [];
      if (points.length < 2) continue

      // Build SVG path (unscaled coordinates)
      let d = `M ${points[0].x} ${points[0].y}`;
      for (let i = 1; i < points.length; i++) {
        d += ` L ${points[i].x} ${points[i].y}`;
      }

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", thickness);
      path.setAttribute("stroke-opacity", opacity);
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("fill", "none");
      path.dataset.annotationId = annotation.id;
      svgLayer.appendChild(path);
    }
  }

  // Render underline as SVG lines at the bottom of each quad (unscaled coordinates)
  _renderUnderlineSvg(annotation, svgLayer) {
    if (!annotation.quads || annotation.quads.length === 0) return

    // Parse color - ensure we have a valid color, defaulting to red
    let color = (annotation.color && annotation.color.length > 0) ? annotation.color : "#FF0000";
    if (color.length === 9 && color.startsWith("#")) {
      color = color.slice(0, 7); // Strip alpha from color
    }

    // Underline thickness in PDF coordinates
    const thickness = 1.5;

    // Create a line at the bottom of each quad
    for (const quad of annotation.quads) {
      // p3 is bottom-left, p4 is bottom-right
      const x1 = quad.p3.x;
      const y = quad.p3.y + 1; // Slightly below the text bottom
      const x2 = quad.p4.x;

      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", x1);
      line.setAttribute("y1", y);
      line.setAttribute("x2", x2);
      line.setAttribute("y2", y);
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-width", thickness);
      line.setAttribute("stroke-linecap", "round");
      line.dataset.annotationId = annotation.id;
      svgLayer.appendChild(line);
    }
  }

  // Create transparent interactive element for underline (for clicks/selection)
  _createUnderlineInteractive(annotation, pageWidth, pageHeight) {
    if (!annotation.quads || annotation.quads.length === 0) return null

    const container = document.createElement("div");
    container.className = "annotation annotation-underline";
    container.dataset.annotationId = annotation.id;

    // Calculate bounding box of all underlines (at bottom of quads)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const quad of annotation.quads) {
      const x1 = Math.min(quad.p3.x, quad.p4.x);
      const x2 = Math.max(quad.p3.x, quad.p4.x);
      const y = quad.p3.y;

      minX = Math.min(minX, x1);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x2);
      maxY = Math.max(maxY, y + 3); // Small padding for click area
    }

    container.style.cssText = `
      position: absolute;
      left: ${(minX / pageWidth) * 100}%;
      top: ${(minY / pageHeight) * 100}%;
      width: ${((maxX - minX) / pageWidth) * 100}%;
      height: ${((maxY - minY) / pageHeight) * 100}%;
    `;

    return container
  }

  // Create transparent interactive element for highlight (for clicks/selection)
  // Uses percentage-based positioning so it scales automatically with page size
  _createHighlightInteractive(annotation, pageWidth, pageHeight) {
    const container = document.createElement("div");
    container.className = "annotation annotation-highlight";
    container.dataset.annotationId = annotation.id;

    if (annotation.annotation_type === "ink") {
      // Freehand highlight bounds
      const strokes = annotation.ink_strokes || [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const stroke of strokes) {
        for (const point of stroke.points || []) {
          minX = Math.min(minX, point.x);
          minY = Math.min(minY, point.y);
          maxX = Math.max(maxX, point.x);
          maxY = Math.max(maxY, point.y);
        }
      }
      const thickness = annotation.thickness || 12;
      const padding = thickness / 2 + 2;

      container.style.cssText = `
        position: absolute;
        left: ${((minX - padding) / pageWidth) * 100}%;
        top: ${((minY - padding) / pageHeight) * 100}%;
        width: ${((maxX - minX + padding * 2) / pageWidth) * 100}%;
        height: ${((maxY - minY + padding * 2) / pageHeight) * 100}%;
      `;
    } else if (annotation.quads && annotation.quads.length > 0) {
      // Text highlight bounds
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const quad of annotation.quads) {
        minX = Math.min(minX, quad.p1.x, quad.p3.x);
        minY = Math.min(minY, quad.p1.y, quad.p2.y);
        maxX = Math.max(maxX, quad.p2.x, quad.p4.x);
        maxY = Math.max(maxY, quad.p3.y, quad.p4.y);
      }

      container.style.cssText = `
        position: absolute;
        left: ${(minX / pageWidth) * 100}%;
        top: ${(minY / pageHeight) * 100}%;
        width: ${((maxX - minX) / pageWidth) * 100}%;
        height: ${((maxY - minY) / pageHeight) * 100}%;
      `;
    }

    return container
  }

  _createAnnotationElement(annotation, pageWidth, pageHeight) {
    switch (annotation.annotation_type) {
      case "highlight":
        return this._createHighlightElement(annotation, pageWidth, pageHeight)
      case "note":
        return this._createNoteElement(annotation, pageWidth, pageHeight)
      case "ink":
        return this._createInkElement(annotation, pageWidth, pageHeight)
      default:
        return null
    }
  }

  _createHighlightElement(annotation, pageWidth, pageHeight) {
    const container = document.createElement("div");
    container.className = "annotation annotation-highlight";
    container.dataset.annotationId = annotation.id;

    if (annotation.quads && annotation.quads.length > 0) {
      // Calculate bounding box of all quads
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

      for (const quad of annotation.quads) {
        const x = Math.min(quad.p1.x, quad.p3.x);
        const y = Math.min(quad.p1.y, quad.p2.y);
        const x2 = Math.max(quad.p2.x, quad.p4.x);
        const y2 = Math.max(quad.p3.y, quad.p4.y);

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x2);
        maxY = Math.max(maxY, y2);
      }

      const containerWidth = maxX - minX;
      const containerHeight = maxY - minY;

      // Set container position and dimensions (percentage-based)
      container.style.cssText = `
        position: absolute;
        left: ${(minX / pageWidth) * 100}%;
        top: ${(minY / pageHeight) * 100}%;
        width: ${(containerWidth / pageWidth) * 100}%;
        height: ${(containerHeight / pageHeight) * 100}%;
      `;

      // Create child rects with positions relative to container (also percentage-based)
      for (const quad of annotation.quads) {
        const rect = document.createElement("div");
        rect.className = "highlight-rect";

        const x = Math.min(quad.p1.x, quad.p3.x);
        const y = Math.min(quad.p1.y, quad.p2.y);
        const width = Math.abs(quad.p2.x - quad.p1.x);
        const height = Math.abs(quad.p3.y - quad.p1.y);

        rect.style.cssText = `
          position: absolute;
          left: ${((x - minX) / containerWidth) * 100}%;
          top: ${((y - minY) / containerHeight) * 100}%;
          width: ${(width / containerWidth) * 100}%;
          height: ${(height / containerHeight) * 100}%;
          background-color: ${annotation.color || ColorPicker.DEFAULT_HIGHLIGHT_COLOR};
          opacity: ${annotation.opacity || 0.4};
          cursor: pointer;
        `;
        container.appendChild(rect);
      }
    }

    return container
  }


  _createNoteElement(annotation, pageWidth, pageHeight) {
    const icon = document.createElement("div");
    icon.className = "annotation annotation-note";
    icon.dataset.annotationId = annotation.id;

    // Note icon size in PDF coordinates (24px at 72 DPI = ~0.33 inches)
    const noteSize = 24;

    icon.style.cssText = `
      position: absolute;
      left: ${(annotation.rect[0] / pageWidth) * 100}%;
      top: ${(annotation.rect[1] / pageHeight) * 100}%;
      width: ${(noteSize / pageWidth) * 100}%;
      height: ${(noteSize / pageHeight) * 100}%;
      cursor: pointer;
    `;

    icon.innerHTML = `
      <svg viewBox="0 0 24 24" fill="${annotation.color || ColorPicker.DEFAULT_HIGHLIGHT_COLOR}" stroke="#000" stroke-width="1">
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
      </svg>
    `;

    return icon
  }

  _createInkElement(annotation, pageWidth, pageHeight) {
    // Validate ink_strokes exist
    const strokes = annotation.ink_strokes || [];
    if (strokes.length === 0) {
      return null
    }

    // Get stroke thickness (default 2 for regular ink, but free highlights use thicker)
    const thickness = annotation.thickness || 2;

    // Calculate bounds from strokes (in PDF coordinates)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasPoints = false;
    for (const stroke of strokes) {
      for (const point of stroke.points || []) {
        hasPoints = true;
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
    }

    // If no valid points, don't create element
    if (!hasPoints) {
      return null
    }

    // Padding needs to account for stroke thickness (in PDF coordinates)
    const padding = Math.max(5, thickness / 2 + 2);
    const inkWidth = maxX - minX + padding * 2;
    const inkHeight = maxY - minY + padding * 2;

    // Wrap canvas in a div container for consistent selection behavior
    const container = document.createElement("div");
    container.className = "annotation annotation-ink";
    container.dataset.annotationId = annotation.id;
    container.style.cssText = `
      position: absolute;
      left: ${((minX - padding) / pageWidth) * 100}%;
      top: ${((minY - padding) / pageHeight) * 100}%;
      width: ${(inkWidth / pageWidth) * 100}%;
      height: ${(inkHeight / pageHeight) * 100}%;
    `;

    const canvas = document.createElement("canvas");
    canvas.className = "ink-canvas";
    // Render at 4x for quality at various zoom levels
    const canvasScale = 4;
    canvas.width = inkWidth * canvasScale;
    canvas.height = inkHeight * canvasScale;
    canvas.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    `;

    const ctx = canvas.getContext("2d");
    ctx.scale(canvasScale, canvasScale);

    // Parse color - if it has alpha (8 chars), extract it and use for globalAlpha
    let color = annotation.color || ColorPicker.DEFAULT_INK_COLOR;
    let opacity = 1;
    if (color.length === 9 && color.startsWith("#")) {
      // Format: #RRGGBBAA - extract alpha
      const alphaHex = color.slice(7, 9);
      opacity = parseInt(alphaHex, 16) / 255;
      color = color.slice(0, 7); // Strip alpha from color
    } else {
      opacity = annotation.opacity || 1;
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = opacity;

    for (const stroke of strokes) {
      const points = stroke.points || [];
      if (points.length < 2) continue

      ctx.beginPath();
      ctx.moveTo(
        points[0].x - minX + padding,
        points[0].y - minY + padding
      );

      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(
          points[i].x - minX + padding,
          points[i].y - minY + padding
        );
      }
      ctx.stroke();
    }

    container.appendChild(canvas);
    return container
  }

  _selectAnnotation(annotation, element) {
    // Get page height for toolbar positioning
    const pageContainer = element.closest(".pdf-page");
    const pageHeight = pageContainer
      ? parseFloat(pageContainer.style.getPropertyValue("--page-height")) || 792
      : 792;

    // If clicking on the same annotation, just ensure toolbar is visible
    if (this.selectedAnnotation && this.selectedAnnotation.id === annotation.id) {
      // Update element reference in case it changed (after re-render)
      if (this.selectedAnnotationElement !== element) {
        this.selectedAnnotationElement = element;
        element.classList.add("selected");
        this.annotationEditToolbar.show(annotation, element, pageHeight);
      }
      return
    }

    // Deselect previous annotation if any
    this._deselectAnnotation();

    // Mark as selected
    this.selectedAnnotation = annotation;
    this.selectedAnnotationElement = element;
    element.classList.add("selected");

    // Show the edit toolbar below the annotation (includes note content for notes)
    this.annotationEditToolbar.show(annotation, element, pageHeight);

    this.container.dispatchEvent(new CustomEvent("pdf-viewer:annotation-selected", {
      bubbles: true,
      detail: { annotation }
    }));
  }

  _deselectAnnotation() {
    if (this.selectedAnnotationElement) {
      this.selectedAnnotationElement.classList.remove("selected");
    }
    this.selectedAnnotation = null;
    this.selectedAnnotationElement = null;

    // Hide the edit toolbar
    this.annotationEditToolbar.hide();
  }

  async _onAnnotationColorChange(annotation, color) {
    try {
      // Preserve the existing opacity when changing color (default to 0.4 for highlights/ink, 1 for others)
      const defaultOpacity = (annotation.annotation_type === "highlight" || annotation.annotation_type === "ink") ? 0.4 : 1;
      const opacity = annotation.opacity ?? defaultOpacity;

      // Encode opacity into color string as alpha channel (#RRGGBBAA)
      // The backend derives opacity from the color's alpha channel
      const alphaHex = Math.round(opacity * 255).toString(16).padStart(2, "0");
      const colorWithAlpha = color + alphaHex;

      await this.annotationManager.updateAnnotation(annotation.id, { color: colorWithAlpha });
    } catch (error) {
      console.error("Failed to update annotation color:", error);
    }
  }

  _scrollToAnnotation(annotationId) {
    const annotation = this.annotationManager.getAnnotation(annotationId);
    if (!annotation) return

    // Mark this annotation for selection when it's rendered
    this.pendingAnnotationSelection = annotationId;

    // Go to the page - the annotation will be selected in _renderAnnotationsForPage
    this.viewer.goToPage(annotation.page);
  }

  /**
   * Scroll to annotation and flash/highlight it.
   * Called from the annotation sidebar when clicking an annotation.
   */
  _scrollToAnnotationWithFlash(annotationId) {
    const annotation = this.annotationManager.getAnnotation(annotationId);
    if (!annotation) return

    // Mark this annotation for selection and flash when rendered
    this.pendingAnnotationSelection = annotationId;
    this.pendingAnnotationFlash = annotationId;

    // Go to the page first
    this.viewer.goToPage(annotation.page);

    // If the page is already rendered, we need to scroll to and flash the annotation manually
    const pageContainer = this.viewer.getPageContainer(annotation.page);
    if (pageContainer) {
      // Use .annotation class to avoid matching SVG elements
      const element = pageContainer.querySelector(`.annotation[data-annotation-id="${annotationId}"]`);
      if (element) {
        this._scrollToAndFlashAnnotation(annotation, element);
      }
    }

    // Update sidebar selection AFTER page scroll, without triggering another scroll
    // This prevents competing scrollIntoView calls that can lock scrolling
    this.annotationSidebar?.selectAnnotation(annotationId, { scroll: false });
  }

  /**
   * Scroll to annotation element and apply flash effect
   */
  _scrollToAndFlashAnnotation(annotation, element) {
    // Clear pending flags
    this.pendingAnnotationSelection = null;
    this.pendingAnnotationFlash = null;

    // Scroll annotation to center of the PDF container
    // Use manual scroll calculation instead of scrollIntoView() to avoid
    // scrolling ancestor containers (which can cause scroll lock issues)
    const container = this.viewer.container;
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();

    // Calculate where the element center is relative to the container viewport
    const elementCenterY = elementRect.top + elementRect.height / 2 - containerRect.top;
    const elementCenterX = elementRect.left + elementRect.width / 2 - containerRect.left;
    const containerCenterY = containerRect.height / 2;
    const containerCenterX = containerRect.width / 2;

    // Calculate the scroll offset needed to center the element
    const scrollOffsetY = elementCenterY - containerCenterY;
    const scrollOffsetX = elementCenterX - containerCenterX;

    container.scrollTo({
      top: container.scrollTop + scrollOffsetY,
      left: container.scrollLeft + scrollOffsetX,
      behavior: "smooth"
    });

    // Apply flash animation after scroll settles
    setTimeout(() => {
      // Re-query the element in case it was re-rendered
      // Use .annotation class to avoid matching SVG elements
      const pageContainer = this.viewer.getPageContainer(annotation.page);
      const freshElement = pageContainer?.querySelector(`.annotation[data-annotation-id="${annotation.id}"]`);
      if (!freshElement) return

      // Select the annotation
      this._selectAnnotation(annotation, freshElement);

      // Add flash class
      freshElement.classList.add("flashing");

      // Remove flash class after animation completes
      setTimeout(() => {
        freshElement.classList.remove("flashing");
      }, 1500); // 3 cycles * 0.5s = 1.5s
    }, 300);
  }

  // Time tracking
  _startTracking() {
    this._trackingStartTime = Date.now();
    this._trackingInterval = setInterval(() => {
      this._sendTrackingUpdate();
    }, 30000); // 30 second heartbeat
  }

  _pauseTracking() {
    if (this._trackingInterval) {
      this._sendTrackingUpdate();
    }
  }

  _resumeTracking() {
    this._trackingStartTime = Date.now();
  }

  _sendTrackingUpdate() {
    if (!this.trackingUrl) return

    const timeSpent = Math.floor((Date.now() - this._trackingStartTime) / 1000);
    this._trackingStartTime = Date.now();

    fetch(this.trackingUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content
      },
      body: JSON.stringify({ time_spent: timeSpent })
    }).catch(error => {
      console.error("Failed to send tracking update:", error);
    });
  }

  // Download with annotations
  async download() {
    try {
      await this.downloadManager.downloadWithAnnotations();
    } catch (error) {
      console.error("Failed to download PDF:", error);
      throw error
    }
  }

  // Cleanup
  destroy() {
    if (this._trackingInterval) {
      clearInterval(this._trackingInterval);
      this._sendTrackingUpdate();
    }

    this.viewer.destroy();
    this.annotationEditToolbar.destroy();
    this.undoBar.destroy();
    this.thumbnailSidebar?.destroy();
    this.annotationSidebar?.destroy();
    this.findController?.destroy();
    this.findBar?.destroy();

    Object.values(this.tools).forEach(tool => tool.destroy?.());

    // Clean up the shared announcer
    destroyAnnouncer();
  }
}

// Connects to data-controller="pdf-viewer"
class pdf_viewer_controller extends Controller {
  static targets = ["container", "zoomSelect", "pageInput", "pageCount", "prevBtn", "nextBtn", "colorPicker", "loadingOverlay", "overflowBtn", "overflowMenu", "overflowColorPicker", "overflowPageNum", "overflowPageCount"]
  static values = {
    documentUrl: String,
    documentName: String,
    organizationName: String,
    userName: String,
    annotationsUrl: String,
    documentId: String,
    trackingUrl: String,
    initialPage: Number,
    initialAnnotation: String,
    autoHeight: { type: Boolean, default: true }
  }

  initialize() {
    this.resizeObserver = new ResizeObserver(() => this.setViewportHeight());
    this.pdfViewer = null;
  }

  async connect() {
    this.resizeObserver.observe(this.containerTarget);

    // Create the PDF viewer instance
    this.pdfViewer = new PdfViewer(this.containerTarget, {
      documentUrl: this.documentUrlValue,
      documentName: this.documentNameValue,
      organizationName: this.organizationNameValue,
      annotationsUrl: this.annotationsUrlValue,
      trackingUrl: this.trackingUrlValue,
      userName: this.userNameValue,
      documentId: this.documentIdValue,
      initialPage: this.initialPageValue || 1,
      initialAnnotation: this.initialAnnotationValue
    });

    // Set up the toolbar
    this._setupToolbar();

    // Listen for error events from the PDF viewer
    this._setupErrorListener();

    // Load the PDF
    try {
      await this.pdfViewer.load();
    } catch (error) {
      console.error("Failed to load PDF:", error);
      this._showError("Failed to load PDF document");
    }
  }

  _setupErrorListener() {
    this._errorHandler = (e) => {
      const { message } = e.detail;
      this._showError(message, false);
    };
    this.containerTarget.addEventListener("pdf-viewer:user-error", this._errorHandler);
  }

  disconnect() {
    this.resizeObserver.unobserve(this.containerTarget);

    if (this._keydownHandler) {
      document.removeEventListener("keydown", this._keydownHandler);
    }

    if (this._errorHandler) {
      this.containerTarget.removeEventListener("pdf-viewer:user-error", this._errorHandler);
    }

    if (this._readyHandler) {
      this.containerTarget.removeEventListener("pdf-viewer:ready", this._readyHandler);
    }

    if (this._pageChangedHandler) {
      this.containerTarget.removeEventListener("pdf-viewer:page-changed", this._pageChangedHandler);
    }

    if (this._overflowMenuClickOutsideHandler) {
      document.removeEventListener("click", this._overflowMenuClickOutsideHandler);
    }

    if (this.pdfViewer) {
      this.pdfViewer.destroy();
      this.pdfViewer = null;
    }
  }

  _setupToolbar() {
    const toolbar = this.containerTarget.querySelector(".pdf-viewer-toolbar");
    if (!toolbar) return

    // Append color picker to existing container
    const colorPickerContainer = toolbar.querySelector(".pdf-toolbar-colors");
    if (colorPickerContainer && this.pdfViewer.colorPicker) {
      colorPickerContainer.appendChild(this.pdfViewer.colorPicker.element);
    }

    // Append color picker clone to overflow menu
    if (this.hasOverflowColorPickerTarget && this.pdfViewer.colorPicker) {
      this._setupOverflowColorPicker();
    }

    // Append find bar below toolbar
    if (this.pdfViewer.findBar) {
      toolbar.after(this.pdfViewer.findBar.element);
    }

    // Set up keyboard shortcuts for zoom and search
    this._setupKeyboardShortcuts();

    // Listen for page changes to update the page input
    this._setupPageNavigationListeners();
  }

  _setupOverflowColorPicker() {
    // Import the static COLORS from the ColorPicker class
    const colorPicker = this.pdfViewer.colorPicker;
    if (!colorPicker) return

    const container = this.overflowColorPickerTarget;

    // Get colors from the main color picker's dropdown buttons
    const mainColors = colorPicker.element.querySelectorAll(".color-picker-option");

    mainColors.forEach(mainBtn => {
      const colorValue = mainBtn.dataset.color;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "color-picker-option";
      btn.dataset.color = colorValue;
      btn.innerHTML = `<span class="color-picker-swatch" style="background-color: ${colorValue}"></span>`;

      // Sync with main color picker's current selection
      if (colorValue === colorPicker.currentColor) {
        btn.classList.add("selected");
      }

      btn.addEventListener("click", () => {
        // Update main color picker
        colorPicker.setColor(colorValue);
        // Update selection UI in overflow menu
        container.querySelectorAll(".color-picker-option").forEach(b => {
          b.classList.toggle("selected", b.dataset.color === colorValue);
        });
      });

      container.appendChild(btn);
    });

    // Store original onChange to chain our sync handler
    const originalOnChange = colorPicker.onChange;
    colorPicker.onChange = (color) => {
      // Call original handler
      if (originalOnChange) originalOnChange(color);
      // Sync overflow menu
      container.querySelectorAll(".color-picker-option").forEach(btn => {
        btn.classList.toggle("selected", btn.dataset.color === color);
      });
    };
  }

  _setupKeyboardShortcuts() {
    this._keydownHandler = (e) => {
      // Ctrl+F / Cmd+F for search (always handle, even in inputs within our container)
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        // Only handle if the event is within our container or globally when not in another input
        if (this.containerTarget.contains(e.target) || e.target.tagName !== "INPUT") {
          e.preventDefault();
          this.toggleSearch();
          return
        }
      }

      // Only handle zoom shortcuts if not in an input/textarea
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return

      if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) {
        e.preventDefault();
        this.zoomIn();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "-") {
        e.preventDefault();
        this.zoomOut();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        this._setZoomLevel(1);
      }
    };
    document.addEventListener("keydown", this._keydownHandler);
  }

  toggleSearch() {
    this._closeOverflowMenu();
    this.pdfViewer?.toggleFindBar();
  }

  toggleSidebar() {
    this._closeOverflowMenu();
    this.pdfViewer?.thumbnailSidebar?.toggle();
  }

  toggleAnnotationSidebar() {
    this._closeOverflowMenu();
    this.pdfViewer?.annotationSidebar?.toggle();
  }

  selectTool(event) {
    const button = event.currentTarget;
    const toolName = button.dataset.tool;
    this._activateTool(toolName);
  }

  selectToolFromOverflow(event) {
    const button = event.currentTarget;
    const toolName = button.dataset.tool;
    this._activateTool(toolName);
    // Close the overflow menu after selecting a tool
    this._closeOverflowMenu();
  }

  _activateTool(toolName) {
    // Tool map for name -> mode conversion
    const toolMap = {
      select: ToolMode.SELECT,
      highlight: ToolMode.HIGHLIGHT,
      underline: ToolMode.UNDERLINE,
      note: ToolMode.NOTE,
      ink: ToolMode.INK
    };

    // Toggle behavior: if clicking the already-active tool, switch back to Select
    // (except for Select itself, which should stay selected)
    const currentMode = this.pdfViewer?.currentMode;
    const clickedMode = toolMap[toolName];
    const targetTool = (clickedMode === currentMode && toolName !== "select")
      ? "select"
      : toolName;

    // Update active state on main toolbar tool buttons
    this.containerTarget.querySelectorAll(".pdf-tool-btn[data-tool]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tool === targetTool);
    });

    // Update active state on overflow menu tool buttons
    this.containerTarget.querySelectorAll(".pdf-overflow-tool-btn[data-tool]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tool === targetTool);
    });

    // Set the tool
    if (toolMap[targetTool]) {
      this.pdfViewer.setTool(toolMap[targetTool]);
    }
  }

  toggleOverflowMenu(event) {
    if (!this.hasOverflowMenuTarget || !this.hasOverflowBtnTarget) return

    const isOpen = this.overflowMenuTarget.classList.toggle("open");
    this.overflowBtnTarget.classList.toggle("active", isOpen);

    if (isOpen) {
      // Position the menu below the button
      const btnRect = this.overflowBtnTarget.getBoundingClientRect();
      this.overflowMenuTarget.style.top = `${btnRect.bottom + 4}px`;
      this.overflowMenuTarget.style.right = `${window.innerWidth - btnRect.right}px`;

      // Close menu when clicking outside
      this._overflowMenuClickOutsideHandler = (e) => {
        if (!this.overflowMenuTarget.contains(e.target) && !this.overflowBtnTarget.contains(e.target)) {
          this._closeOverflowMenu();
        }
      };
      // Delay to prevent immediate close from the current click
      setTimeout(() => {
        document.addEventListener("click", this._overflowMenuClickOutsideHandler);
      }, 0);
    } else {
      this._closeOverflowMenu();
    }
  }

  _closeOverflowMenu() {
    if (this.hasOverflowMenuTarget) {
      this.overflowMenuTarget.classList.remove("open");
    }
    if (this.hasOverflowBtnTarget) {
      this.overflowBtnTarget.classList.remove("active");
    }
    if (this._overflowMenuClickOutsideHandler) {
      document.removeEventListener("click", this._overflowMenuClickOutsideHandler);
      this._overflowMenuClickOutsideHandler = null;
    }
  }

  async download() {
    this._closeOverflowMenu();
    try {
      await this.pdfViewer.download();
    } catch (error) {
      console.error("Failed to download:", error);
      this._showError("Failed to download PDF");
    }
  }

  // Zoom controls
  zoomIn() {
    const currentScale = this.pdfViewer.getScale();
    const zoomLevels = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
    // Find next zoom level greater than current scale (with small tolerance for floating point)
    const nextLevel = zoomLevels.find(level => level > currentScale + 0.001) || zoomLevels[zoomLevels.length - 1];
    this._setZoomLevel(nextLevel);
  }

  zoomOut() {
    const currentScale = this.pdfViewer.getScale();
    const zoomLevels = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
    // Find previous zoom level less than current scale (with small tolerance for floating point)
    const prevLevel = [...zoomLevels].reverse().find(level => level < currentScale - 0.001) || zoomLevels[0];
    this._setZoomLevel(prevLevel);
  }

  setZoom(event) {
    const value = event.target.value;
    // Handle preset string values
    if (["auto", "page-width", "page-fit", "page-actual"].includes(value)) {
      this._setZoomPreset(value);
    } else {
      this._setZoomLevel(parseFloat(value));
    }
  }

  _setZoomPreset(preset) {
    // Map our preset names to ScaleValue constants
    const presetMap = {
      "auto": ScaleValue.AUTO,
      "page-width": ScaleValue.PAGE_WIDTH,
      "page-fit": ScaleValue.PAGE_FIT,
      "page-actual": 1.0  // Actual size is just 100%
    };

    const scaleValue = presetMap[preset];
    this.pdfViewer.viewer.setScale(scaleValue);

    // Store the current preset mode (for dropdown selection)
    this._currentScalePreset = preset;
  }

  _setZoomLevel(scale) {
    this.pdfViewer.viewer.setScale(scale);
    // Clear any preset mode since we're using a specific numeric scale
    this._currentScalePreset = null;
    // Update the dropdown to reflect the current zoom
    this._updateZoomSelect(scale);
  }

  _updateZoomSelect(scale) {
    if (!this.hasZoomSelectTarget) return

    // Try to find a matching option value
    const scaleStr = String(scale);
    const options = Array.from(this.zoomSelectTarget.options);
    const matchingOption = options.find(opt => opt.value === scaleStr);

    if (matchingOption) {
      this.zoomSelectTarget.value = scaleStr;
    }
    // If no match, leave the current selection (preset modes will show their label)
  }

  // Page navigation
  previousPage() {
    const currentPage = this.pdfViewer.getCurrentPage();
    if (currentPage > 1) {
      this.pdfViewer.goToPage(currentPage - 1);
    }
  }

  nextPage() {
    const currentPage = this.pdfViewer.getCurrentPage();
    const pageCount = this.pdfViewer.getPageCount();
    if (currentPage < pageCount) {
      this.pdfViewer.goToPage(currentPage + 1);
    }
  }

  goToPage(event) {
    const pageNumber = parseInt(event.target.value, 10);
    const pageCount = this.pdfViewer.getPageCount();
    if (pageNumber >= 1 && pageNumber <= pageCount) {
      this.pdfViewer.goToPage(pageNumber);
    } else {
      // Reset to current page if invalid
      event.target.value = this.pdfViewer.getCurrentPage();
    }
  }

  handlePageInputKey(event) {
    if (event.key === "Enter") {
      event.target.blur();
      this.goToPage(event);
    }
  }

  _setupPageNavigationListeners() {
    // Listen for ready event from PdfViewer
    this._readyHandler = (e) => {
      const { pageCount, currentPage } = e.detail;
      this._onViewerReady(pageCount, currentPage);
    };
    this.containerTarget.addEventListener("pdf-viewer:ready", this._readyHandler);

    // Listen for page change events from PdfViewer
    this._pageChangedHandler = (e) => {
      const { currentPage, pageCount } = e.detail;
      this._onPageChanged(currentPage, pageCount);
    };
    this.containerTarget.addEventListener("pdf-viewer:page-changed", this._pageChangedHandler);
  }

  _onViewerReady(pageCount, currentPage) {
    // Hide the loading overlay
    if (this.hasLoadingOverlayTarget) {
      this.loadingOverlayTarget.classList.add("hidden");
    }

    if (this.hasPageCountTarget) {
      this.pageCountTarget.textContent = pageCount;
    }
    if (this.hasPageInputTarget) {
      this.pageInputTarget.max = pageCount;
      this.pageInputTarget.value = currentPage;
    }
    // Update overflow menu page display
    if (this.hasOverflowPageCountTarget) {
      this.overflowPageCountTarget.textContent = pageCount;
    }
    if (this.hasOverflowPageNumTarget) {
      this.overflowPageNumTarget.textContent = currentPage;
    }
    this._updateNavigationButtons();

    // Set initial zoom to "auto" which fits the page width for portrait documents
    this._setZoomPreset("auto");
  }

  _onPageChanged(currentPage, pageCount) {
    if (this.hasPageInputTarget && document.activeElement !== this.pageInputTarget) {
      this.pageInputTarget.value = currentPage;
    }
    if (this.hasPageCountTarget) {
      this.pageCountTarget.textContent = pageCount;
    }
    // Update overflow menu page display
    if (this.hasOverflowPageNumTarget) {
      this.overflowPageNumTarget.textContent = currentPage;
    }
    if (this.hasOverflowPageCountTarget) {
      this.overflowPageCountTarget.textContent = pageCount;
    }
    this._updateNavigationButtons();
  }

  _updateNavigationButtons() {
    if (!this.pdfViewer?.viewer) return

    const currentPage = this.pdfViewer.getCurrentPage();
    const pageCount = this.pdfViewer.getPageCount();

    if (this.hasPrevBtnTarget) {
      this.prevBtnTarget.disabled = currentPage <= 1;
    }
    if (this.hasNextBtnTarget) {
      this.nextBtnTarget.disabled = currentPage >= pageCount;
    }
  }

  setViewportHeight() {
    requestAnimationFrame(() => {
      // Skip if autoHeight is disabled (container height managed by consuming application)
      if (!this.autoHeightValue) {
        return
      }

      const rect = this.containerTarget.getBoundingClientRect();
      this.containerTarget.style.position = "relative";
      this.containerTarget.style.overflow = "hidden";
      this.containerTarget.style.height = `${window.innerHeight - rect.top}px`;
    });
  }

  /**
   * Show an error message to the user.
   * @param {string} message - The error message
   * @param {boolean} persistent - If true, shows permanent error overlay. If false, shows auto-dismissing toast.
   */
  _showError(message, persistent = true) {
    if (persistent) {
      const errorDiv = document.createElement("div");
      errorDiv.className = "pdf-viewer-error";
      errorDiv.textContent = message;
      this.containerTarget.appendChild(errorDiv);
    } else {
      const toast = document.createElement("div");
      toast.className = "pdf-viewer-toast";
      toast.textContent = message;

      const body = this.containerTarget.querySelector(".pdf-viewer-body");
      if (body) {
        body.parentNode.insertBefore(toast, body);
      } else {
        this.containerTarget.appendChild(toast);
      }

      requestAnimationFrame(() => {
        toast.classList.add("visible");
      });

      setTimeout(() => {
        toast.classList.remove("visible");
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }
  }
}

// Simple controller to trigger PDF viewer download from outside the viewer's scope.
// Usage: data-controller="pdf-download" data-action="click->pdf-download#download"
class pdf_download_controller extends Controller {
  download(event) {
    event.preventDefault();

    // Find the pdf-viewer controller element and get its controller instance
    const pdfViewerElement = document.querySelector('[data-controller~="pdf-viewer"]');
    if (!pdfViewerElement) {
      console.warn("PDF viewer not found");
      return
    }

    // Get the Stimulus controller instance
    const pdfViewerController = this.application.getControllerForElementAndIdentifier(
      pdfViewerElement,
      "pdf-viewer"
    );

    if (pdfViewerController) {
      // Inject download bridge for native app support
      this._injectDownloadBridge(pdfViewerController);
      pdfViewerController.download();
    }
  }

  _injectDownloadBridge(pdfViewerController) {
    const bridgeElement = document.querySelector('[data-controller~="bridge--download"]');
    if (!bridgeElement) return

    const bridge = this.application.getControllerForElementAndIdentifier(
      bridgeElement,
      "bridge--download"
    );

    if (bridge && pdfViewerController.pdfViewer?.downloadManager) {
      pdfViewerController.pdfViewer.downloadManager.setDownloadBridge(bridge);
    }
  }
}

export { AnnotationStore, CoreViewer, MemoryAnnotationStore, pdf_download_controller as PdfDownloadController, PdfViewer, pdf_viewer_controller as PdfViewerController, RestAnnotationStore, ToolMode, ViewerEvents };
//# sourceMappingURL=stimulus-pdf-viewer.esm.js.map
