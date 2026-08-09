import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HEALTH_WEBHOOK_PATH,
  INBOUND_WEBHOOK_PATHS,
  MEDIA_WEBHOOK_PATH,
  STATUS_WEBHOOK_PATH,
  createSharedTwilioRouteLifecycle,
} from '../dist/shared-routes.js';

test('shared inbound, status, media, and health routes survive individual account stops', () => {
  const registered = [];
  const unregistered = [];
  const lifecycle = createSharedTwilioRouteLifecycle((route) => {
    registered.push(route);
    return () => unregistered.push(route.path);
  });
  const handlers = {
    inbound: () => {},
    status: () => {},
    media: () => {},
    health: () => {},
  };

  const stopAccountA = lifecycle.acquire(handlers);
  const stopAccountB = lifecycle.acquire(handlers);

  assert.equal(lifecycle.activeLeases(), 2);
  assert.deepEqual(
    registered.map((route) => route.path),
    [
      ...INBOUND_WEBHOOK_PATHS,
      STATUS_WEBHOOK_PATH,
      MEDIA_WEBHOOK_PATH,
      HEALTH_WEBHOOK_PATH,
    ],
  );
  assert.ok(registered.every((route) => route.accountId === undefined));

  stopAccountA();
  assert.equal(lifecycle.activeLeases(), 1);
  assert.deepEqual(unregistered, []);
  assert.equal(registered.length, 5);

  stopAccountB();
  assert.equal(lifecycle.activeLeases(), 0);
  assert.deepEqual(unregistered, [
    ...INBOUND_WEBHOOK_PATHS,
    STATUS_WEBHOOK_PATH,
    MEDIA_WEBHOOK_PATH,
    HEALTH_WEBHOOK_PATH,
  ]);
});

test('shared route release is idempotent and a later account can register a fresh owner', () => {
  let registerCount = 0;
  let unregisterCount = 0;
  const lifecycle = createSharedTwilioRouteLifecycle(() => {
    registerCount += 1;
    return () => {
      unregisterCount += 1;
    };
  });
  const handlers = {
    inbound: () => {},
    status: () => {},
    media: () => {},
    health: () => {},
  };

  const stopFirst = lifecycle.acquire(handlers);
  stopFirst();
  stopFirst();
  const stopSecond = lifecycle.acquire(handlers);

  assert.equal(registerCount, 10);
  assert.equal(unregisterCount, 5);
  assert.equal(lifecycle.activeLeases(), 1);

  stopSecond();
  assert.equal(unregisterCount, 10);
});

test('partial shared route registration is rolled back', () => {
  const unregistered = [];
  let registrations = 0;
  const lifecycle = createSharedTwilioRouteLifecycle((route) => {
    registrations += 1;
    if (registrations === 3) throw new Error('route registry unavailable');
    return () => unregistered.push(route.path);
  });
  const handlers = {
    inbound: () => {},
    status: () => {},
    media: () => {},
    health: () => {},
  };

  assert.throws(() => lifecycle.acquire(handlers), /route registry unavailable/);
  assert.equal(lifecycle.activeLeases(), 0);
  assert.deepEqual(unregistered, [...INBOUND_WEBHOOK_PATHS]);
});
