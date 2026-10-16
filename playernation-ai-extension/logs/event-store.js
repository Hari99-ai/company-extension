/**
 * Event Store for Match Logging
 * Manages event lifecycle, persistence in chrome.storage.local, and query filtering.
 */

import { isDuplicateEvent } from '../utils/timestamps.js';

export class MatchEventStore {
  constructor(storageKey = 'eventLogs') {
    this.storageKey = storageKey;
    this.events = [];
  }

  async init() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      return new Promise((resolve) => {
        chrome.storage.local.get(this.storageKey, (data) => {
          if (Array.isArray(data[this.storageKey])) {
            this.events = data[this.storageKey];
          }
          resolve(this.events);
        });
      });
    }
    return this.events;
  }

  addEvent(event) {
    const result = this.addEvents([event]);
    return result.added[0] || null;
  }

  addEvents(events) {
    const added = [];
    let duplicates = 0;

    events.forEach(event => {
      const playerIdentity = event.pid || event.playerId || event.playerName || event.manualId;
      const isDuplicate = this.events.some(existing => {
        if (!isDuplicateEvent(event, [existing])) return false;
        const existingIdentity = existing.pid || existing.playerId || existing.playerName || existing.manualId;
        return !playerIdentity || !existingIdentity || playerIdentity === existingIdentity;
      });
      if (isDuplicate) {
        duplicates += 1;
        return;
      }

      const record = {
        id: event.id || `evt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        matchTimestamp: event.matchTimestamp,
        eventType: event.eventType,
        eventLabel: event.eventLabel || null,
        team: event.team || 'Unknown',
        playerId: event.playerId || event.pid || event.playerName || null,
        playerName: event.playerName || '',
        pid: event.pid || event.playerId || '',
        jersey: event.jersey || '',
        manualId: event.manualId || '',
        confidence: event.confidence || 0.7,
        status: event.status || 'needs_review',
        source: event.source || 'detection',
        evidence: Array.isArray(event.evidence) ? event.evidence : [],
        createdAt: new Date().toISOString()
      };

      this.events.unshift(record);
      added.push(record);
    });

    if (added.length > 0) this.persist();
    return { added, duplicates };
  }

  updateEvent(id, updates) {
    const item = this.events.find(e => e.id === id);
    if (item) {
      Object.assign(item, updates);
      this.persist();
      return item;
    }
    return null;
  }

  deleteEvent(id) {
    const idx = this.events.findIndex(e => e.id === id);
    if (idx !== -1) {
      this.events.splice(idx, 1);
      this.persist();
      return true;
    }
    return false;
  }

  clear() {
    this.events = [];
    this.persist();
  }

  persist() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const payload = {};
      payload[this.storageKey] = this.events;
      chrome.storage.local.set(payload);
    }
  }

  getAll() {
    return this.events;
  }
}
