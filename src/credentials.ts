export interface SecretRef {
  source: 'env' | 'file' | 'exec';
  provider: string;
  id: string;
}

export type TwilioCredentialInput = string | SecretRef;

export interface TwilioCredentialConfig {
  accountSid?: TwilioCredentialInput;
  authToken?: TwilioCredentialInput;
}

export type TwilioCredentialPairInspection =
  | { source: 'account'; complete: true }
  | { source: 'global'; complete: true }
  | { source: 'partial-account'; complete: false; missing: 'accountSid' | 'authToken' }
  | { source: 'missing'; complete: false };

export interface ResolvedTwilioCredentials {
  accountSid: string;
  authToken: string;
  source: 'account' | 'global';
}

function isSecretRef(value: unknown): value is SecretRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<SecretRef>;
  return (
    (candidate.source === 'env' || candidate.source === 'file' || candidate.source === 'exec') &&
    typeof candidate.provider === 'string' &&
    typeof candidate.id === 'string'
  );
}

export function hasConfiguredCredentialInput(value: unknown): boolean {
  return (typeof value === 'string' && value.trim().length > 0) || isSecretRef(value);
}

export function inspectTwilioCredentialPair(
  config: TwilioCredentialConfig,
  env: NodeJS.ProcessEnv = process.env,
): TwilioCredentialPairInspection {
  const hasAccountSid = hasConfiguredCredentialInput(config.accountSid);
  const hasAuthToken = hasConfiguredCredentialInput(config.authToken);
  if (hasAccountSid !== hasAuthToken) {
    return {
      source: 'partial-account',
      complete: false,
      missing: hasAccountSid ? 'authToken' : 'accountSid',
    };
  }
  if (hasAccountSid && hasAuthToken) {
    return { source: 'account', complete: true };
  }
  if (env.TWILIO_ACCOUNT_SID?.trim() && env.TWILIO_AUTH_TOKEN?.trim()) {
    return { source: 'global', complete: true };
  }
  return { source: 'missing', complete: false };
}

export function credentialConfigurationHint(
  accountId: string,
  config: TwilioCredentialConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const inspection = inspectTwilioCredentialPair(config, env);
  if (inspection.complete) return undefined;
  if (inspection.source === 'partial-account') {
    return (
      `Account "${accountId}" has incomplete account-scoped Twilio credentials; set both ` +
      `channels.twilio-whatsapp.accounts.${accountId}.accountSid and ` +
      `channels.twilio-whatsapp.accounts.${accountId}.authToken`
    );
  }
  return (
    `Account "${accountId}" needs both account-scoped Twilio credentials, or the ` +
    `TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN compatibility fallback`
  );
}

export function resolveTwilioCredentials(
  accountId: string,
  config: TwilioCredentialConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTwilioCredentials | null {
  const inspection = inspectTwilioCredentialPair(config, env);
  if (!inspection.complete) {
    if (inspection.source === 'partial-account') {
      throw new Error(credentialConfigurationHint(accountId, config, env));
    }
    return null;
  }

  if (inspection.source === 'global') {
    return {
      accountSid: env.TWILIO_ACCOUNT_SID!.trim(),
      authToken: env.TWILIO_AUTH_TOKEN!.trim(),
      source: 'global',
    };
  }

  if (typeof config.accountSid !== 'string' || typeof config.authToken !== 'string') {
    throw new Error(
      `Twilio WhatsApp account "${accountId}" credentials are configured but unavailable in this runtime`,
    );
  }

  return {
    accountSid: config.accountSid.trim(),
    authToken: config.authToken.trim(),
    source: 'account',
  };
}
