import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(fs.readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
const schema = manifest.channelConfigs['twilio-whatsapp'].schema;

function jsonBlockAfter(fileName, heading) {
  const markdown = fs.readFileSync(new URL(`../${fileName}`, import.meta.url), 'utf8');
  const headingIndex = markdown.indexOf(heading);
  assert.notEqual(headingIndex, -1, `${fileName} must contain ${heading}`);
  const fenceStart = markdown.indexOf('```json\n', headingIndex);
  assert.notEqual(fenceStart, -1, `${fileName} must contain a JSON block after ${heading}`);
  const jsonStart = fenceStart + '```json\n'.length;
  const fenceEnd = markdown.indexOf('\n```', jsonStart);
  assert.notEqual(fenceEnd, -1, `${fileName} JSON block must have a closing fence`);
  return JSON.parse(markdown.slice(jsonStart, fenceEnd));
}

function validate(schemaNode, value, path = '$') {
  if (schemaNode.$ref) {
    const segments = schemaNode.$ref.replace(/^#\//, '').split('/');
    const resolved = segments.reduce((current, segment) => current?.[segment], schema);
    return resolved ? validate(resolved, value, path) : [`${path} has unresolved schema ref ${schemaNode.$ref}`];
  }
  if (schemaNode.anyOf) {
    const results = schemaNode.anyOf.map((candidate) => validate(candidate, value, path));
    return results.some((candidateErrors) => candidateErrors.length === 0)
      ? []
      : results.flat();
  }
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
    if (schemaNode.minLength !== undefined && value.length < schemaNode.minLength) {
      fail(`must have length >= ${schemaNode.minLength}`);
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
      sales: {
        accountSid: { source: 'env', provider: 'default', id: 'TWILIO_SALES_ACCOUNT_SID' },
        authToken: { source: 'env', provider: 'default', id: 'TWILIO_SALES_AUTH_TOKEN' },
        dmPolicy: 'allowlist',
        allowFrom: ['+14155550123', '+14155550124'],
        groupPolicy: 'disabled',
        groupAllowFrom: ['+14155550123', 'accessGroup:operators'],
        groups: {
          '*': {
            enabled: false,
            requireMention: true,
            allowFrom: ['+14155550123'],
            groupPolicy: 'disabled',
            systemPrompt: 'ignored by the Twilio WhatsApp channel',
            tools: ['ignored-tool'],
            toolsBySender: {
              '+14155550123': ['ignored-tool'],
            },
          },
        },
        fromNumber: '+14155550100',
      },
      support: {
        dmPolicy: 'open',
        allowFrom: ['*'],
        fromNumber: '+14155550101',
        mediaMaxMb: 10,
      },
    },
  });

  assert.deepEqual(errors, []);
});

test('README version 3 upgrade example parses and matches the plugin schema', () => {
  const example = jsonBlockAfter('README.md', '### Upgrade from version 2');
  const channel = example.channels?.['twilio-whatsapp'];

  assert.deepEqual(validate(schema, channel), []);
  assert.deepEqual(
    example.bindings.map((binding) => binding.match?.accountId),
    Object.keys(channel.accounts),
  );
});

test('agent installation example parses and matches the plugin schema', () => {
  const example = jsonBlockAfter('AGENT_INSTRUCTIONS.md', '## Step 2: configure `openclaw.json`');
  const channel = example.channels?.['twilio-whatsapp'];

  assert.deepEqual(validate(schema, channel), []);
  assert.deepEqual(
    example.bindings.map((binding) => binding.match?.accountId),
    Object.keys(channel.accounts),
  );
  assert.ok(example.plugins.allow.includes('twilio-whatsapp'));
  assert.equal(example.plugins.entries['twilio-whatsapp'].enabled, true);
});

test('channel schema rejects legacy top-level sender config keys', () => {
  const errors = validate(schema, {
    enabled: true,
    fromNumber: '+14155550100',
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
      sales: {
        fromNumber: '+14155550100',
      },
    },
    unexpected: true,
  });

  assert.ok(errors.some((error) => error.includes('additional property unexpected')));
});

test('channel schema rejects incomplete or malformed credential refs', () => {
  const errors = validate(schema, {
    enabled: true,
    webhookUrl: 'https://twilio.example.test',
    accounts: {
      sales: {
        accountSid: { source: 'env', provider: 'INVALID PROVIDER', id: '' },
        authToken: { source: 'env', provider: 'default' },
        fromNumber: '+14155550100',
      },
    },
  });

  assert.ok(errors.some((error) => error.includes('provider must match')));
  assert.ok(errors.some((error) => error.includes('id is required')));
});
