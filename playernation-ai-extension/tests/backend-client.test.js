import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalBackendClient } from '../detector/backend-client.js';

test('LocalBackendClient instantiates with correct default options', () => {
  const client = new LocalBackendClient();
  assert.equal(client.serverUrl, 'http://127.0.0.1:8000');
  assert.equal(client.isOnline, false);
  assert.equal(client.serverInfo, null);
});

test('LocalBackendClient handles unreachable server without throwing', async () => {
  const client = new LocalBackendClient({ serverUrl: 'http://127.0.0.1:9999', timeoutMs: 200 });
  const isOnline = await client.checkHealth();
  assert.equal(isOnline, false);
  assert.equal(client.isOnline, false);
});

test('LocalBackendClient detect rejects when image is missing', async () => {
  const client = new LocalBackendClient();
  await assert.rejects(async () => {
    await client.detect('');
  }, /Image data missing/);
});

test('LocalBackendClient forwards ball-tracking hints to the local detector', async () => {
  const client = new LocalBackendClient();
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ success: true }) };
  };

  try {
    await client.detect('data:image/jpeg;base64,AA==', {
      hint_x: 0.34,
      hint_y: 0.47
    });
    assert.equal(requestBody.hint_x, 0.34);
    assert.equal(requestBody.hint_y, 0.47);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LocalBackendClient updates the minimum training threshold', async () => {
  const client = new LocalBackendClient();
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8000/training-config');
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ success: true }) };
  };

  try {
    const result = await client.setTrainingConfig(40);
    assert.deepEqual(requestBody, { minimum_samples: 40 });
    assert.equal(result.success, true);
    await assert.rejects(client.setTrainingConfig(9), /between 10 and 10000/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LocalBackendClient uploads manually labeled football frames', async () => {
  const client = new LocalBackendClient();
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8000/training-samples');
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ success: true, training: { status: 'collecting' } })
    };
  };

  try {
    const sample = {
      id: 'sample-1',
      image: 'data:image/jpeg;base64,AA==',
      annotations: [{
        category: 'football',
        bbox: { x: 0.5, y: 0.5, width: 0.02, height: 0.02 }
      }]
    };
    const result = await client.uploadTrainingSample(sample, 20);
    assert.equal(requestBody.id, 'sample-1');
    assert.equal(requestBody.minimum_samples, 20);
    assert.equal(requestBody.annotation.category, 'football');
    assert.equal(result.training.status, 'collecting');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
