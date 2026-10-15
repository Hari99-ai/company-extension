/**
 * PlayerNation Web Interface Adapter
 * Bridges AI event detections with the live PlayerNation logging buttons and keyboard shortcuts.
 */

export class PlayerNationAdapter {
  constructor(options = {}) {
    this.autoLoggingEnabled = !!options.autoLoggingEnabled;
    this.minAutoConfidence = options.minAutoConfidence || 0.80;
    this.auditLog = [];
    this.lastSubmissionTime = 0;
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
   * Check if the PlayerNation logging panel is visible and ready in the DOM.
   * @returns {boolean}
   */
  isPanelAvailable() {
    return !!(
      document.getElementById('shotBtn') ||
      document.getElementById('short-passBtn') ||
      document.querySelector('.action-section')
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
    if (now - this.lastSubmissionTime < this.submissionCooldownMs) {
      return { success: false, reason: 'Submission throttled by cooldown' };
    }

    const targetBtnId = this.buttonMap[event.eventType];
    if (!targetBtnId) {
      return { success: false, reason: `No button mapped for event type '${event.eventType}'` };
    }

    const btn = document.getElementById(targetBtnId);

    if (btn) {
      // If button is currently disabled, log reason
      if (btn.disabled) {
        return {
          success: false,
          reason: `Button #${targetBtnId} is currently disabled in PlayerNation (select player first)`
        };
      }

      // Simulate human click with full mouse event sequence
      this._simulateClick(btn);
      this.lastSubmissionTime = now;

      const auditEntry = {
        timestamp: new Date().toISOString(),
        matchTimestamp: event.matchTimestamp,
        eventType: event.eventType,
        buttonId: targetBtnId,
        team: event.team,
        status: 'submitted'
      };
      this.auditLog.push(auditEntry);
      console.log('[PlayerNation Adapter] Event submitted successfully:', auditEntry);

      return { success: true, method: 'dom_button_click', buttonId: targetBtnId };
    }

    return {
      success: false,
      reason: `Button #${targetBtnId} not found in DOM.`
    };
  }

  _simulateClick(element) {
    element.focus();
    const eventOptions = { bubbles: true, cancelable: true, view: window };
    element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
    element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
    element.dispatchEvent(new MouseEvent('click', eventOptions));
  }

  setAutoLogging(enabled) {
    this.autoLoggingEnabled = !!enabled;
  }

  getAuditLog() {
    return this.auditLog;
  }
}
