import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(fs.readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
const schema = manifest.channelConfigs['twilio-whatsapp'].schema;

function validate(schemaNode, value, path = '$') {
  const errors = [];
  const fail = (message) => errors.push(`${path} ${message}`);

  if (schemaNode.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('must be object');
      return errors;
    }
    for (const key of schemaNode.required || []) {
      if (!(key in value)) errors.push(`${path}.${key} is required`);
    }
    const properties = schemaNode.properties || {};
    for (const [key, childValue] of Object.entries(value)) {
      const childSchema = properties[key] || schemaNode.additionalProperties;
      if (!childSchema || childSchema === false) {
        errors.push(`${path} must not have additional property ${key}`);
        continue;
      }
      if (childSchema === true) continue;
      errors.push(...validate(childSchema, childValue, `${path}.${key}`));
    }
    return errors;
  }

  if (schemaNode.type === 'array') {
    if (!Array.isArray(value)) {
      fail('must be array');
      return errors;
    }
    value.forEach((entry, index) => {
      errors.push(...validate(schemaNode.items || {}, entry, `${path}[${index}]`));
    });
    return errors;
  }

  if (schemaNode.type === 'string') {
    if (typeof value !== 'string') {
      fail('must be string');
      return errors;
    }
    if (schemaNode.enum && !schemaNode.enum.includes(value)) {
      fail(`must be one of ${schemaNode.enum.join(', ')}`);
    }
    if (schemaNode.pattern && !new RegExp(schemaNode.pattern).test(value)) {
      fail(`must match ${schemaNode.pattern}`);
    }
    if (schemaNode.format === 'uri') {
      try {
        new URL(value);
      } catch {
        fail('must be a URI');
      }
    }
    return errors;
  }

  if (schemaNode.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail('must be number');
      return errors;
    }
    if (schemaNode.minimum !== undefined && value < schemaNode.minimum) fail(`must be >= ${schemaNode.minimum}`);
    if (schemaNode.maximum !== undefined && value > schemaNode.maximum) fail(`must be <= ${schemaNode.maximum}`);
    return errors;
  }

  if (schemaNode.type === 'integer') {
    if (!Number.isInteger(value)) {
      fail('must be integer');
      return errors;
    }
    if (schemaNode.minimum !== undefined && value < schemaNode.minimum) fail(`must be >= ${schemaNode.minimum}`);
    if (schemaNode.maximum !== undefined && value > schemaNode.maximum) fail(`must be <= ${schemaNode.maximum}`);
    return errors;
  }

  if (schemaNode.type === 'boolean' && typeof value !== 'boolean') {
    fail('must be boolean');
  }

  return errors;
}

test('channel schema accepts multi-account prod-shaped config with group and delivery keys', () => {
  const errors = validate(schema, {
    enabled: true,
    webhookUrl: 'https://twilio.example.test',
    statusCallbackUrl: 'https://twilio.example.test/webhook/twilio-whatsapp/status',
    sendTimeoutMs: 20000,
    sendRetries: 3,
    textChunkLimit: 1600,
    mediaMaxMb: 25,
    typingIndicators: false,
    typingTimeoutMs: 5000,
    processingAckText: '',
    processingAckDelayMs: 10000,
    dmHistoryLimit: 2,
    accounts: {
      vinalia: {
        dmPolicy: 'allowlist',
        allowFrom: ['+14155551234', '+14155555678'],
        groupPolicy: 'disabled',
        groupAllowFrom: ['+14155551234', 'accessGroup:operators'],
        groups: {
          '*': {
            enabled: false,
            requireMention: true,
            allowFrom: ['+14155551234'],
            groupPolicy: 'disabled',
            systemPrompt: 'ignored by the Twilio WhatsApp channel',
            tools: ['ignored-tool'],
            toolsBySender: {
              '+14155551234': ['ignored-tool'],
            },
          },
        },
        fromNumber: '+14155550000',
      },
      mkps: {
        dmPolicy: 'open',
        fromNumber: '+447427807929',
        mediaMaxMb: 10,
      },
    },
  });

  assert.deepEqual(errors, []);
});

test('channel schema rejects legacy top-level sender config keys', () => {
  const errors = validate(schema, {
    enabled: true,
    fromNumber: '+14155550000',
    webhookUrl: 'https://twilio.example.test',
    accounts: {},
  });

  assert.ok(errors.some((error) => error.includes('additional property fromNumber')));
});

test('channel schema still rejects unknown channel config keys', () => {
  const errors = validate(schema, {
    enabled: true,
    webhookUrl: 'https://twilio.example.test',
    accounts: {
      vinalia: {
        fromNumber: '+14155550000',
      },
    },
    unexpected: true,
  });

  assert.ok(errors.some((error) => error.includes('additional property unexpected')));
});
