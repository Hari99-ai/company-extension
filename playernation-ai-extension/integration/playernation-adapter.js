/**
 * PlayerNation Web Interface Adapter
 * Bridges AI event detections with the live PlayerNation logging buttons and keyboard shortcuts.
 */

export class PlayerNationAdapter {
  constructor(options = {}) {
    this.autoLoggingEnabled = !!options.autoLoggingEnabled;
    this.minAutoConfidence = options.minAutoConfidence || 0.80;
    this.auditLog = [];
    this.lastSubmissionTime = -Infinity;
    this.submissionCooldownMs = 1200; // Prevent double-triggering

    // Map internal event IDs to PlayerNation DOM button IDs
    this.buttonMap = {
      'shot': 'shotBtn',
      'short-pass': 'short-passBtn',
      'long-pass': 'long-passBtn',
      'pass': 'short-passBtn',
      'goal': 'goalBtn',
      'defensive-action': 'defensive-actionBtn',
      'clearance': 'clearanceBtn',
      'own-goal': 'own-goalBtn',
      'save': 'saveBtn',
      'foul': 'free-kickBtn',
      'corner': 'cornerBtn',
      'penalty': 'penaltyBtn'
    };
  }

  /**
   * Locate target action button by ID, data attributes, class names, or text content.
   * Ensures compatibility with React/Vite builds on playernation.app.
   * @param {string} eventType
   * @returns {HTMLElement|null}
   */
  findButton(eventType) {
    const doc = typeof document !== 'undefined' ? document : (typeof globalThis !== 'undefined' && globalThis.document ? globalThis.document : null);
    if (!doc) return null;

    const targetBtnId = this.buttonMap[eventType];
    if (targetBtnId && doc.getElementById) {
      const byId = doc.getElementById(targetBtnId);
      if (byId) return byId;
    }

    // Try standard data attributes & classes
    const candidates = [
      targetBtnId ? `button#${targetBtnId}` : null,
      `[data-action="${eventType}"]`,
      `[data-event="${eventType}"]`,
      `[data-event-type="${eventType}"]`,
      `[data-testid="${eventType}Btn"]`,
      `[data-testid="${eventType}-btn"]`,
      `button.${eventType}-btn`,
      `button.${eventType}`
    ].filter(Boolean);

    for (const selector of candidates) {
      try {
        if (doc.querySelector) {
          const found = doc.querySelector(selector);
          if (found) return found;
        }
      } catch (e) {}
    }

    // Try finding by button text or aria-label
    if (doc.querySelectorAll) {
      const cleanType = eventType.replace(/-/g, ' ').toLowerCase();
      const buttons = Array.from(doc.querySelectorAll('button, [role="button"]') || []);
      const matched = buttons.find(b => {
        const text = (b.textContent || '').trim().toLowerCase();
        const aria = (b.getAttribute && b.getAttribute('aria-label') || '').toLowerCase();
        return text.includes(cleanType) || aria.includes(cleanType);
      });
      if (matched) return matched;
    }

    return null;
  }

  /**
   * Check if the PlayerNation logging panel is visible and ready in the DOM.
   * @returns {boolean}
   */
  isPanelAvailable() {
    const doc = typeof document !== 'undefined' ? document : (typeof globalThis !== 'undefined' && globalThis.document ? globalThis.document : null);
    if (!doc) return false;
    return !!(
      (doc.getElementById && doc.getElementById('shotBtn')) ||
      (doc.getElementById && doc.getElementById('short-passBtn')) ||
      (doc.querySelector && doc.querySelector('.action-section')) ||
      (doc.querySelector && doc.querySelector('[data-testid="event-logger"]')) ||
      (doc.querySelector && doc.querySelector('[data-section="match-actions"]')) ||
      (doc.querySelector && doc.querySelector('button[data-action]'))
    );
  }

  /**
   * Submit an event to the PlayerNation interface.
   * Dispatches simulated click and keyboard events with React synthetic event compatibility.
   * @param {object} event - { eventType, matchTimestamp, team, playerId, confidence }
   * @param {boolean} [force=false] - If true, bypasses autoLogging check (Assisted confirmation)
   * @returns {object} { success: boolean, method: string, error?: string }
   */
  submitEvent(event, force = false) {
    if (!force && !this.autoLoggingEnabled) {
      return { success: false, reason: 'Assisted logging mode requires user confirmation' };
    }

    if (!force && event.confidence < this.minAutoConfidence) {
      return { success: false, reason: `Confidence (${Math.round(event.confidence * 100)}%) below auto threshold (${Math.round(this.minAutoConfidence * 100)}%)` };
    }

    const now = performance.now();
    if (this.lastSubmissionTime > 0 && (now - this.lastSubmissionTime < this.submissionCooldownMs)) {
      return { success: false, reason: 'Submission throttled by cooldown' };
    }

    const btn = this.findButton(event.eventType);
    const targetBtnId = this.buttonMap[event.eventType] || event.eventType;

    if (btn) {
      // If button is currently disabled, log reason
      if (btn.disabled) {
        return {
          success: false,
          reason: `Button for ${event.eventType} is currently disabled in PlayerNation (select player first)`
        };
      }

      // Simulate human click with full mouse event sequence
      this._simulateClick(btn);
      this.lastSubmissionTime = now;

      const auditEntry = {
        timestamp: new Date().toISOString(),
        matchTimestamp: event.matchTimestamp,
        eventType: event.eventType,
        buttonId: btn.id || targetBtnId,
        team: event.team,
        status: 'submitted'
      };
      this.auditLog.push(auditEntry);
      console.log('[PlayerNation Adapter] Event submitted successfully:', auditEntry);

      return { success: true, method: 'dom_button_click', buttonId: btn.id || targetBtnId };
    }

    return {
      success: false,
      reason: `Button for event '${event.eventType}' not found in DOM.`
    };
  }

  _simulateClick(element) {
    if (element.focus) element.focus();
    if (typeof MouseEvent !== 'undefined') {
      const eventOptions = { bubbles: true, cancelable: true, view: typeof window !== 'undefined' ? window : null };
      element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
      element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
      element.dispatchEvent(new MouseEvent('click', eventOptions));
    } else if (element.dispatchEvent) {
      element.dispatchEvent({ type: 'mousedown', bubbles: true });
      element.dispatchEvent({ type: 'mouseup', bubbles: true });
      element.dispatchEvent({ type: 'click', bubbles: true });
    } else if (element.click) {
      element.click();
    }
  }

  setAutoLogging(enabled) {
    this.autoLoggingEnabled = !!enabled;
  }

  getAuditLog() {
    return this.auditLog;
  }
}
