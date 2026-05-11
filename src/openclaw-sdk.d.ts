declare module 'openclaw/plugin-sdk/channel-core' {
  export function defineChannelPluginEntry(params: {
    id: string;
    name?: string;
    description?: string;
    plugin: any;
    configSchema?: any;
    setRuntime?: (runtime: any) => void;
    registerCliMetadata?: any;
    registerFull?: any;
  }): any;

  export function defineSetupPluginEntry(params: {
    id: string;
    channel: {
      id: string;
      inspectAccount: (params: { cfg: any; accountId?: string }) => {
        enabled: boolean;
        configured: boolean;
        hint?: string;
      };
    };
  }): any;

  export function createChatChannelPlugin<TAccount = any>(params: {
    base: {
      id: string;
      resolveAccount?: (params: { cfg: any; accountId?: string }) => TAccount | null;
      security?: any;
      messaging?: {
        normalizeTarget?: (target: string) => string | undefined;
        resolveInboundConversation?: any;
        transformReplyPayload?: any;
        targetResolver?: {
          looksLikeId: (id: string | undefined) => boolean;
          hint: string;
        };
      };
      setup?: {
        resolveChannelSetupStatus?: (params: { cfg: any }) => { status: string; hint?: string };
      };
      status?: {
        resolveAccountStatus?: (params: { account: TAccount }) => Promise<any>;
        resolveAccountState?: (params: { configured: boolean }) => string;
      };
      gateway?: {
        startAccount?: (ctx: {
          account: TAccount;
          cfg: any;
          runtime: any;
          channelRuntime?: any;
          abortSignal?: AbortSignal;
          log?: { info: (msg: string) => void; debug?: (msg: string) => void; error?: (msg: string) => void };
          accountId: string;
          setStatus?: (status: any) => void;
        }) => Promise<(() => void) | void>;
      };
      agentPrompt?: {
        messageToolHints?: () => string[];
      };
      [key: string]: any;
    };
    outbound?: any;
    security?: any;
    pairing?: any;
    threading?: any;
  }): any;
}

declare module 'openclaw/plugin-sdk/channel-policy' {
  export function createRestrictSendersChannelSecurity<TAccount = any>(params: {
    channelKey: string;
    resolveDmPolicy: (account: TAccount) => string | undefined;
    resolveDmAllowFrom: (account: TAccount) => string[] | undefined;
    resolveGroupPolicy?: (account: TAccount) => string | undefined;
    surface: string;
    openScope: string;
    groupPolicyPath?: string;
    groupAllowFromPath?: string;
    mentionGated: boolean;
    policyPathSuffix: string;
    approveHint: string;
    normalizeDmEntry: (raw: string) => string;
  }): any;
}

declare module 'openclaw/plugin-sdk/channel-send-result' {
  export function createAttachedChannelResultAdapter(params: {
    channel: string;
    sendText?: (ctx: {
      cfg: any;
      to: string;
      text: string;
      accountId?: string;
      deps?: any;
      gifPlayback?: boolean;
      replyToId?: string;
      formatting?: any;
    }) => Promise<{ messageId: string }>;
    sendMedia?: (ctx: {
      cfg: any;
      to: string;
      text?: string;
      mediaUrl?: string;
      mediaAccess?: any;
      mediaLocalRoots?: readonly string[];
      mediaReadFile?: (filePath: string) => Promise<Buffer>;
      audioAsVoice?: boolean;
      accountId?: string;
      deps?: any;
      gifPlayback?: boolean;
      replyToId?: string;
    }) => Promise<{ messageId: string }>;
    sendPoll?: (ctx: any) => Promise<any>;
  }): {
    sendText?: (ctx: any) => Promise<any>;
    sendMedia?: (ctx: any) => Promise<any>;
    sendPoll?: (ctx: any) => Promise<any>;
  };
}

declare module 'openclaw/plugin-sdk/reply-chunking' {
  export function chunkText(text: string, limit: number, ctx?: any): string[];
}

declare module 'openclaw/plugin-sdk/webhook-ingress' {
  export function registerPluginHttpRoute(params: {
    path: string;
    auth: string;
    match?: string;
    replaceExisting?: boolean;
    pluginId: string;
    accountId?: string;
    log?: (msg: string) => void;
    handler: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void | Promise<void>;
  }): () => void;

  export function normalizePluginHttpPath(path: string | undefined, fallback: string): string | null;
}

declare module 'openclaw/plugin-sdk/state-paths' {
  export function resolveStateDir(env?: NodeJS.ProcessEnv): string;
}

declare module 'openclaw/plugin-sdk/runtime-store' {
  export function createPluginRuntimeStore(options: {
    pluginId: string;
    errorMessage: string;
  }): {
    setRuntime: (runtime: any) => void;
    clearRuntime: () => void;
    tryGetRuntime: () => any;
    getRuntime: () => any;
  };
}

declare module 'openclaw/plugin-sdk/command-auth' {
  export function shouldComputeCommandAuthorized(text?: string, cfg?: any, options?: any): boolean;
  export function hasControlCommand(text?: string, cfg?: any, options?: any): boolean;
  export function hasInlineCommandTokens(text?: string): boolean;
  export function isControlCommandMessage(text?: string, cfg?: any, options?: any): boolean;
}

declare module 'openclaw/plugin-sdk/channel-inbound' {
  export function dispatchInboundDirectDmWithRuntime(params: {
    cfg: any;
    channel: string;
    accountId: string;
    peer: { kind: string; id: string };
    runtime: any;
    channelLabel: string;
    conversationLabel: string;
    rawBody: string;
    bodyForAgent?: string;
    commandBody?: string;
    senderAddress: string;
    recipientAddress: string;
    senderId: string;
    messageId: string;
    provider?: string;
    surface?: string;
    timestamp?: number;
    commandAuthorized?: boolean;
    originatingChannel?: string;
    originatingTo?: string;
    extraContext?: Record<string, any>;
    deliver: (payload: any, info?: any) => Promise<any>;
    onRecordError?: (err: any) => void;
    onDispatchError?: (err: any) => void;
    replyOptions?: any;
  }): Promise<{ route: any; storePath: string; ctxPayload: any }>;
}
