/**
 * Performance monitoring and tracking utilities
 * Provides lightweight performance measurement capabilities for hot paths
 */

import { performance } from 'node:perf_hooks';

/**
 * Request performance tracker for monitoring individual request phases
 */
export class RequestTracker {
  constructor() {
    this.metrics = new Map();
    this.startTime = performance.now();
    this.metadata = {};
  }

  /**
   * Start measuring a specific phase of the request
   * @param {string} name - Phase name (e.g., 'routing', 'db', 'translation')
   */
  startPhase(name) {
    this.metrics.set(name, performance.now());
  }

  /**
   * End measuring a phase and return duration in milliseconds
   * @param {string} name - Phase name to end
   * @returns {number} Duration in milliseconds, or null if phase wasn't started
   */
  endPhase(name) {
    const startTime = this.metrics.get(name);
    if (startTime === undefined) return null;

    const duration = performance.now() - startTime;
    this.metrics.delete(name);
    return duration;
  }

  /**
   * Set metadata for this request (for correlation and debugging)
   * @param {string} key - Metadata key
   * @param {any} value - Metadata value
   */
  setMetadata(key, value) {
    this.metadata[key] = value;
  }

  /**
   * Get a summary of all completed phases and total duration
   * @returns {Object} Performance summary with phase timings
   */
  getSummary() {
    const totalDuration = performance.now() - this.startTime;

    return {
      totalMs: totalDuration.toFixed(2),
      phases: Object.fromEntries(this.metadata),
      // Extract individual phase timings if needed for detailed analysis
      _rawMetrics: Object.fromEntries(this.metrics),
    };
  }

  /**
   * Get the total duration so far
   * @returns {number} Total duration in milliseconds
   */
  getTotalDuration() {
    return performance.now() - this.startTime;
  }
}

/**
 * Lightweight performance measurement wrapper
 * Automatically tracks execution time of async functions
 * @param {string} phaseName - Name of the phase to measure
 * @param {Function} fn - Async function to measure
 * @returns {Promise} Result of the function with performance data attached
 */
export async function measurePhase(phaseName, fn) {
  const startTime = performance.now();
  try {
    const result = await fn();
    const duration = performance.now() - startTime;

    // Attach performance data to result if it's an object
    if (result && typeof result === 'object') {
      result._perf = {
        phase: phaseName,
        durationMs: duration.toFixed(2),
        timestamp: new Date().toISOString()
      };
    }

    return result;
  } catch (error) {
    const duration = performance.now() - startTime;
    // Attach performance data even to errors
    if (error && typeof error === 'object') {
      error._perf = {
        phase: phaseName,
        durationMs: duration.toFixed(2),
        timestamp: new Date().toISOString(),
        error: true
      };
    }
    throw error;
  }
}

/**
 * Global performance utilities
 */
export const perf = {
  /**
   * Get current timestamp with high resolution
   * @returns {number} Current timestamp in milliseconds
   */
  now: () => performance.now(),

  /**
   * Format milliseconds to human-readable string
   * @param {number} ms - Duration in milliseconds
   * @returns {string} Formatted duration string
   */
  formatMs: (ms) => {
    if (ms < 1) return `${ms.toFixed(2)}ms`;
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  },

  /**
   * Create a scoped performance measurement
   * @param {string} name - Measurement name
   * @returns {Function} Function to call when measurement ends
   */
  measure: (name) => {
    const start = performance.now();
    return () => {
      const duration = performance.now() - start;
      // Log slow operations (> 100ms) for debugging
      if (duration > 100) {
        console.log(`⚠️  Slow operation: ${name} took ${perf.formatMs(duration)}`);
      }
      return duration;
    };
  }
};

/**
 * Request-level performance context (passed through request chain)
 */
export class RequestContext {
  constructor(options = {}) {
    this.tracker = new RequestTracker();
    this.options = options;
    this.requestId = options.requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Add phase timing to context
   */
  addPhaseTiming(phaseName, duration) {
    if (!this.options.detailed) return; // Skip detailed tracking unless requested

    if (!this.phaseTimings) {
      this.phaseTimings = {};
    }

    this.phaseTimings[phaseName] = duration;
  }

  /**
   * Get performance summary for logging
   */
  getPerfSummary() {
    const summary = this.tracker.getSummary();
    return {
      requestId: this.requestId,
      totalMs: summary.totalMs,
      phases: this.phaseTimings || {},
      metadata: summary.phases
    };
  }
}
