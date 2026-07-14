import type { ModelCapability } from '#/capability';
import {
  APIConnectionError,
  APITimeoutError,
  ChatProviderError,
  normalizeAPIStatusError,
} from '#/errors';
import type { Message, StreamedMessagePart, ToolCall } from '#/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  ProviderRequestAuth,
  StreamedMessage,
  ThinkingEffort,
} from '#/provider';
import type { Tool } from '#/tool';
import type { TokenUsage } from '#/usage';
import {
  ApiError as GoogleApiError,
  GoogleGenAI as GenAIClient,
  ThinkingLevel as GoogleThinkingLevel,
  type Content as GoogleSdkContent,
  type FunctionResponsePart as GoogleFunctionResponsePart,
  type GenerateContentConfig as GoogleGenerateContentConfig,
  type GenerateContentParameters as GoogleGenerateContentParameters,
  type Part as GooglePart,
  type ThinkingConfig as GoogleThinkingConfig,
  type Tool as GoogleTool,
} from '@google/genai';

import { getGoogleGenAIModelCapability } from './capability-registry';
import { requireProviderApiKey, resolveAuthBackedClient } from './request-auth';

const GOOGLE_FUNCTION_CALL_ID_EXTRA = 'google_function_call_id';
const GOOGLE_THOUGHT_SIGNATURE_EXTRA = 'thought_signature_b64';

/**
 * Normalize a Google GenAI (Gemini) `finishReason` value to the unified
 * {@link FinishReason} enum.
 *
 * Source: `candidates[0].finishReason` (works for both stream and
 * non-stream — the SDK normalizes them). Gemini does not emit a
 * `tool_calls`-style reason; tool calls come via `parts[].functionCall`
 * and `finishReason` stays `'completed'` even when the model produces
 * function calls.
 */
function normalizeGoogleGenAIFinishReason(raw: unknown): {
  finishReason: FinishReason | null;
  rawFinishReason: string | null;
} {
  if (raw === null || raw === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  // The SDK normally hands us a plain string but older builds wrap it in
  // an enum-like object. Accept both shapes and uppercase to match the
  // documented constants. Anything else collapses to "no signal" so we
  // never emit a junk `[object Object]` raw value.
  let rawString: string;
  if (typeof raw === 'string') {
    rawString = raw.toUpperCase();
  } else if (typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'boolean') {
    rawString = String(raw).toUpperCase();
  } else {
    return { finishReason: null, rawFinishReason: null };
  }
  if (rawString === 'FINISH_REASON_UNSPECIFIED' || rawString === '') {
    return { finishReason: null, rawFinishReason: null };
  }
  switch (rawString) {
    case 'STOP':
      return { finishReason: 'completed', rawFinishReason: rawString };
    case 'MAX_TOKENS':
      return { finishReason: 'truncated', rawFinishReason: rawString };
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
    case 'IMAGE_PROHIBITED_CONTENT':
    case 'IMAGE_RECITATION':
      return { finishReason: 'filtered', rawFinishReason: rawString };
    case 'MALFORMED_FUNCTION_CALL':
    case 'OTHER':
    case 'LANGUAGE':
      return { finishReason: 'other', rawFinishReason: rawString };
    default:
      return { finishReason: 'other', rawFinishReason: rawString };
  }
}
export interface GoogleGenAIOptions {
  apiKey?: string | undefined;
  model: string;
  vertexai?: boolean | undefined;
  project?: string | undefined;
  location?: string | undefined;
  stream?: boolean | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => GenAIClient;
}

export type GoogleGenAIGenerationKwargs = Omit<
  GoogleGenerateContentConfig,
  'abortSignal' | 'systemInstruction' | 'tools'
>;

interface GoogleContent extends GoogleSdkContent {
  role: 'model' | 'user';
  parts: GooglePart[];
}

function toolToGoogleGenAI(tool: Tool): GoogleTool {
  return {
    functionDeclarations: [
      {
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      },
    ],
  };
}

interface GoogleToolCallMetadata {
  readonly name: string;
  readonly functionCallId?: string | undefined;
}

function providerFunctionCallId(toolCall: ToolCall): string | undefined {
  const value = toolCall.extras?.[GOOGLE_FUNCTION_CALL_ID_EXTRA];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toolCallIdToName(
  toolCallId: string,
  toolMetadataById: Map<string, GoogleToolCallMetadata>,
): string {
  const metadata = toolMetadataById.get(toolCallId);
  if (metadata !== undefined) return metadata.name;
  // Fallback: ids produced by this provider follow the format
  // "{tool_name}_{id_suffix}" where `tool_name` may itself contain
  // underscores (e.g. `fetch_image`) and `id_suffix` is a single trailing
  // token without underscores (e.g. a random hex / UUID fragment). We strip
  // the last "_<suffix>" segment by matching it explicitly — splitting on
  // the first underscore would truncate multi-word tool names like
  // `fetch_image_<id>` to just `fetch`.
  const match = /^(.+)_[^_]+$/.exec(toolCallId);
  return match?.[1] ?? toolCallId;
}

/**
 * Convert a data URL or HTTP URL to a Google GenAI inline/file data part.
 * - data: URLs are parsed into { inlineData: { mimeType, data } }
 * - http(s): URLs use { fileData: { fileUri, mimeType } }
 */
function convertMediaUrl(
  url: string,
  fallbackMimeType: string,
):
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { fileUri: string; mimeType: string } } {
  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    if (commaIndex === -1) {
      return { fileData: { fileUri: url, mimeType: fallbackMimeType } };
    }
    const meta = url.slice(0, commaIndex);
    const data = url.slice(commaIndex + 1);
    const colonIndex = meta.indexOf(':');
    const semiIndex = meta.indexOf(';');
    const mimeType =
      colonIndex !== -1 && semiIndex !== -1
        ? meta.slice(colonIndex + 1, semiIndex)
        : fallbackMimeType;
    return { inlineData: { mimeType, data } };
  }
  // For HTTP(S) URLs, try to guess mime type from extension
  let mimeType = fallbackMimeType;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.png')) mimeType = 'image/png';
    else if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) mimeType = 'image/jpeg';
    else if (pathname.endsWith('.gif')) mimeType = 'image/gif';
    else if (pathname.endsWith('.webp')) mimeType = 'image/webp';
    else if (pathname.endsWith('.mp3') || pathname.endsWith('.mpeg')) mimeType = 'audio/mpeg';
    else if (pathname.endsWith('.wav')) mimeType = 'audio/wav';
    else if (pathname.endsWith('.ogg')) mimeType = 'audio/ogg';
  } catch {
    // URL parsing failed, use fallback
  }
  return { fileData: { fileUri: url, mimeType } };
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function abortPromise(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) {
    return new Promise(() => {
      // Intentionally never settles when no signal is provided.
    });
  }
  if (signal.aborted) {
    throw createAbortError();
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(createAbortError());
      },
      { once: true },
    );
  });
}

function messageToGoogleGenAI(message: Message): GoogleContent {
  if (message.role === 'tool') {
    throw new ChatProviderError(
      'Tool messages must be converted via messagesToGoogleGenAIContents.',
    );
  }
  if (message.role === 'system') {
    throw new ChatProviderError(
      'System messages must be converted via messagesToGoogleGenAIContents.',
    );
  }

  // GoogleGenAI uses "model" instead of "assistant"
  const role = message.role === 'assistant' ? 'model' : 'user';
  const parts: GooglePart[] = [];

  // Handle content parts
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        parts.push({ text: part.text });
        break;
      case 'think':
        // Skip think parts (synthetic)
        break;
      case 'image_url':
        parts.push(convertMediaUrl(part.imageUrl.url, 'image/jpeg'));
        break;
      case 'audio_url':
        parts.push(convertMediaUrl(part.audioUrl.url, 'audio/mpeg'));
        break;
      case 'video_url':
        parts.push(convertMediaUrl(part.videoUrl.url, 'video/mp4'));
        break;
    }
  }

  // Handle tool calls
  for (const toolCall of message.toolCalls) {
    let args: Record<string, unknown> = {};
    if (toolCall.arguments) {
      try {
        const parsed: unknown = JSON.parse(toolCall.arguments);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        } else {
          throw new ChatProviderError('Tool call arguments must be a JSON object.');
        }
      } catch (error) {
        if (error instanceof ChatProviderError) throw error;
        throw new ChatProviderError('Tool call arguments must be valid JSON.');
      }
    }

    const functionCallPart: GooglePart = {
      functionCall: {
        id: providerFunctionCallId(toolCall),
        name: toolCall.name,
        args,
      },
    };

    // Restore the SDK thoughtSignature if the normalized tool call retained it.
    const thoughtSignature = toolCall.extras?.[GOOGLE_THOUGHT_SIGNATURE_EXTRA];
    if (typeof thoughtSignature === 'string' && thoughtSignature.length > 0) {
      functionCallPart.thoughtSignature = thoughtSignature;
    }

    parts.push(functionCallPart);
  }

  return { role, parts };
}

/**
 * Convert a tool message into a list of Google GenAI parts.
 *
 * Returns one `functionResponse` part carrying both the text output and any
 * image/audio/video response parts. Keeping media inside `functionResponse.parts`
 * preserves its association with the function call in the Google SDK protocol.
 */
function toolMessageToFunctionResponseParts(
  message: Message,
  toolMetadataById: Map<string, GoogleToolCallMetadata>,
): GooglePart[] {
  if (message.role !== 'tool') {
    throw new ChatProviderError('Expected a tool message.');
  }
  if (message.toolCallId === undefined) {
    throw new ChatProviderError('Tool response is missing `toolCallId`.');
  }

  // Separate text output from media parts
  let textOutput = '';
  const mediaParts: GoogleFunctionResponsePart[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        if (part.text) textOutput += part.text;
        break;
      case 'image_url':
        mediaParts.push(convertMediaUrl(part.imageUrl.url, 'image/jpeg'));
        break;
      case 'audio_url':
        mediaParts.push(convertMediaUrl(part.audioUrl.url, 'audio/mpeg'));
        break;
      case 'video_url':
        mediaParts.push(convertMediaUrl(part.videoUrl.url, 'video/mp4'));
        break;
      case 'think':
        // Skip — handled separately via reasoning channel.
        break;
    }
  }

  const functionResponsePart: GooglePart = {
    functionResponse: {
      id: toolMetadataById.get(message.toolCallId)?.functionCallId,
      name: toolCallIdToName(message.toolCallId, toolMetadataById),
      response: { output: textOutput },
      parts: mediaParts,
    },
  };

  return [functionResponsePart];
}

export function messagesToGoogleGenAIContents(messages: Message[]): GoogleContent[] {
  const contents: GoogleContent[] = [];
  const toolMetadataById = new Map<string, GoogleToolCallMetadata>();

  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message === undefined) break;

    if (message.role === 'system') {
      // Google GenAI's `Content.role` only accepts "user" or "model", so a
      // system message in the history (e.g. from session restore or
      // cross-provider migration) would be rejected by the API. Preserve
      // the content by wrapping it in a `<system>` tag and attaching it as
      // a user turn — mirrors the Anthropic provider's behavior. The
      // dedicated top-level `systemPrompt` still flows into
      // `systemInstruction` separately; only historical system messages
      // come through here.
      const text = message.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      if (text.length > 0) {
        contents.push({
          role: 'user',
          parts: [{ text: `<system>${text}</system>` }],
        });
      }
      i += 1;
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      contents.push(messageToGoogleGenAI(message));
      const expectedToolCallIds: string[] = [];
      for (const toolCall of message.toolCalls) {
        toolMetadataById.set(toolCall.id, {
          name: toolCall.name,
          functionCallId: providerFunctionCallId(toolCall),
        });
        expectedToolCallIds.push(toolCall.id);
      }

      // Collect consecutive tool messages
      let j = i + 1;
      const toolMessages: Message[] = [];
      while (j < messages.length) {
        const toolMsg = messages[j];
        if (toolMsg === undefined || toolMsg.role !== 'tool') break;
        toolMessages.push(toolMsg);
        j += 1;
      }

      if (toolMessages.length > 0) {
        // Sort tool results to match the order of tool calls in the assistant
        // message, and reject incomplete / duplicated / unexpected results.
        // Gemini/Vertex expects the next user turn to contain a matching set of
        // function responses for the preceding function calls.
        const toolMsgById = new Map<string, Message>();
        const seenToolCallIds = new Set<string>();
        for (const toolMsg of toolMessages) {
          if (toolMsg.toolCallId === undefined) {
            throw new ChatProviderError('Tool response is missing `toolCallId`.');
          }
          if (seenToolCallIds.has(toolMsg.toolCallId)) {
            throw new ChatProviderError(`Duplicate tool response for id: ${toolMsg.toolCallId}`);
          }
          seenToolCallIds.add(toolMsg.toolCallId);
          toolMsgById.set(toolMsg.toolCallId, toolMsg);
        }

        const sortedToolMessages: Message[] = [];
        for (const expectedId of expectedToolCallIds) {
          const msg = toolMsgById.get(expectedId);
          if (msg === undefined) {
            throw new ChatProviderError(`Missing tool responses for ids: ${expectedId}`);
          }
          sortedToolMessages.push(msg);
          toolMsgById.delete(expectedId);
        }
        if (toolMsgById.size > 0) {
          throw new ChatProviderError(
            `Unexpected tool responses for ids: ${JSON.stringify([...toolMsgById.keys()])}`,
          );
        }

        // Pack all tool results into a single user Content. Media outputs stay
        // nested in each functionResponse so their call association is retained.
        const parts: GooglePart[] = [];
        for (const toolMsg of sortedToolMessages) {
          parts.push(...toolMessageToFunctionResponseParts(toolMsg, toolMetadataById));
        }
        contents.push({ role: 'user', parts });
        i = j;
        continue;
      }

      i += 1;
      continue;
    }

    if (message.role === 'tool') {
      // Tool message without preceding assistant message
      const parts: GooglePart[] = toolMessageToFunctionResponseParts(message, toolMetadataById);
      contents.push({ role: 'user', parts });
      i += 1;
      continue;
    }

    contents.push(messageToGoogleGenAI(message));
    i += 1;
  }

  return contents;
}
export class GoogleGenAIStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(
    response: AsyncIterable<Record<string, unknown>> | Record<string, unknown>,
    isStream: boolean,
    signal?: AbortSignal,
  ) {
    if (isStream) {
      this._iter = this._convertStreamResponse(
        response as AsyncIterable<Record<string, unknown>>,
        signal,
      );
    } else {
      this._iter = this._convertNonStreamResponse(response as Record<string, unknown>, signal);
    }
  }

  get id(): string | null {
    return this._id;
  }

  get usage(): TokenUsage | null {
    return this._usage;
  }

  get finishReason(): FinishReason | null {
    return this._finishReason;
  }

  get rawFinishReason(): string | null {
    return this._rawFinishReason;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }

  private _captureFinishReason(response: Record<string, unknown>): void {
    const candidates = response['candidates'] as unknown[] | undefined;
    if (!candidates || candidates.length === 0) {
      return;
    }
    const first = candidates[0] as Record<string, unknown> | undefined;
    if (first === undefined) {
      return;
    }
    const raw = first['finishReason'] ?? first['finish_reason'];
    if (raw === undefined) {
      return;
    }
    const normalized = normalizeGoogleGenAIFinishReason(raw);
    // Only overwrite when we got a definitive signal — early stream
    // chunks may contain `FINISH_REASON_UNSPECIFIED` while the model is
    // still generating, and we treat those as "not yet known".
    if (normalized.finishReason !== null || normalized.rawFinishReason !== null) {
      this._finishReason = normalized.finishReason;
      this._rawFinishReason = normalized.rawFinishReason;
    }
  }

  /** Yield parts from a single (non-streamed) GenerateContentResponse. */
  private _extractChunkParts(response: Record<string, unknown>): StreamedMessagePart[] {
    const parts: StreamedMessagePart[] = [];

    const candidates = response['candidates'] as unknown[] | undefined;
    for (const candidate of candidates ?? []) {
      const cand = candidate as Record<string, unknown>;
      const content = cand['content'] as Record<string, unknown> | undefined;
      const contentParts = content?.['parts'] as unknown[] | undefined;
      if (!contentParts) continue;

      for (const part of contentParts) {
        const p = part as Record<string, unknown>;
        if (p['thought'] === true && p['text']) {
          parts.push({ type: 'think', think: p['text'] as string });
        } else if (p['text']) {
          parts.push({ type: 'text', text: p['text'] as string });
        } else if (p['functionCall'] || p['function_call']) {
          const fc = (p['functionCall'] ?? p['function_call']) as Record<string, unknown>;
          const name = fc['name'] as string;
          if (!name) continue;
          const providerCallId = typeof fc['id'] === 'string' && fc['id'].length > 0
            ? fc['id']
            : undefined;
          const id_ = providerCallId ?? crypto.randomUUID();
          const toolCallId = `${name}_${id_}`;
          const thoughtSigB64 = p['thoughtSignature'] ?? p['thought_signature'];
          const extras: Record<string, unknown> = {};
          if (providerCallId !== undefined) {
            extras[GOOGLE_FUNCTION_CALL_ID_EXTRA] = providerCallId;
          }
          if (typeof thoughtSigB64 === 'string' && thoughtSigB64.length > 0) {
            extras[GOOGLE_THOUGHT_SIGNATURE_EXTRA] = thoughtSigB64;
          }
          parts.push({
            type: 'function',
            id: toolCallId,
            name,
            arguments: fc['args'] ? JSON.stringify(fc['args']) : '{}',
            ...(Object.keys(extras).length > 0 ? { extras } : {}),
          } satisfies ToolCall);
        }
      }
    }

    return parts;
  }

  /** Extract usage metadata from a response chunk. */
  private _extractUsage(response: Record<string, unknown>): void {
    const usageMetadata = response['usageMetadata'] as Record<string, unknown> | undefined;
    if (usageMetadata) {
      const promptTokenCount =
        typeof usageMetadata['promptTokenCount'] === 'number'
          ? usageMetadata['promptTokenCount']
          : 0;
      const cachedContentTokenCount =
        typeof usageMetadata['cachedContentTokenCount'] === 'number'
          ? usageMetadata['cachedContentTokenCount']
          : 0;
      const toolUsePromptTokenCount =
        typeof usageMetadata['toolUsePromptTokenCount'] === 'number'
          ? usageMetadata['toolUsePromptTokenCount']
          : 0;
      const responseTokenCount =
        typeof usageMetadata['responseTokenCount'] === 'number'
          ? usageMetadata['responseTokenCount']
          : typeof usageMetadata['candidatesTokenCount'] === 'number'
            ? usageMetadata['candidatesTokenCount']
            : 0;
      const thoughtsTokenCount =
        typeof usageMetadata['thoughtsTokenCount'] === 'number'
          ? usageMetadata['thoughtsTokenCount']
          : 0;
      this._usage = {
        inputOther:
          Math.max(promptTokenCount - cachedContentTokenCount, 0) + toolUsePromptTokenCount,
        output: responseTokenCount + thoughtsTokenCount,
        inputCacheRead: cachedContentTokenCount,
        inputCacheCreation: 0,
      };
    }
  }

  /** Extract response ID from a response chunk. */
  private _extractId(response: Record<string, unknown>): void {
    if (response['responseId'] !== undefined) {
      this._id = response['responseId'] as string;
    }
  }

  private _throwIfAborted(signal: AbortSignal | undefined): void {
    // Helper kept small so TypeScript's control-flow narrowing does not
    // collapse `signal.aborted` to `false | undefined` at call sites that
    // check the signal repeatedly between async steps.
    if (signal !== undefined && signal.aborted) {
      throw createAbortError();
    }
  }

  private async *_convertNonStreamResponse(
    response: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamedMessagePart> {
    this._throwIfAborted(signal);
    this._extractUsage(response);
    this._extractId(response);
    this._captureFinishReason(response);
    for (const part of this._extractChunkParts(response)) {
      this._throwIfAborted(signal);
      yield part;
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamedMessagePart> {
    try {
      for await (const chunk of response) {
        // Check at each chunk boundary as a backstop for custom clients that
        // do not honor the config abortSignal while an iterator is active.
        this._throwIfAborted(signal);
        this._extractUsage(chunk);
        this._extractId(chunk);
        this._captureFinishReason(chunk);
        for (const part of this._extractChunkParts(chunk)) {
          this._throwIfAborted(signal);
          yield part;
        }
      }
    } catch (error: unknown) {
      // Preserve AbortError identity so the retry/generate loop can
      // distinguish it from transient provider errors.
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw convertGoogleGenAIError(error);
    }
  }
}
const NETWORK_RE = /network|connection|connect|disconnect|fetch failed/i;
const TIMEOUT_RE = /timed?\s*out|timeout|deadline/i;

/**
 * Convert a Google GenAI SDK error (or raw Error) to a ltod `ChatProviderError`.
 */
export function convertGoogleGenAIError(error: unknown): ChatProviderError {
  // Google SDK's exported ApiError carries an HTTP status code
  if (error instanceof GoogleApiError) {
    return normalizeAPIStatusError(error.status, error.message);
  }
  if (error instanceof Error) {
    const msg = error.message;
    // Timeout takes priority over network (a timeout is also a connection issue)
    if (TIMEOUT_RE.test(msg)) {
      return new APITimeoutError(msg);
    }
    // Network / fetch errors (e.g. TypeError: fetch failed)
    if (NETWORK_RE.test(msg) || (error instanceof TypeError && msg.includes('fetch'))) {
      return new APIConnectionError(msg);
    }
    // Try to extract status code from unknown error shapes
    const statusCode = (error as { code?: number }).code;
    if (typeof statusCode === 'number') {
      return normalizeAPIStatusError(statusCode, msg);
    }
    return new ChatProviderError(`GoogleGenAI error: ${msg}`);
  }
  return new ChatProviderError(`GoogleGenAI error: ${String(error)}`);
}
export class GoogleGenAIChatProvider implements ChatProvider {
  readonly name: string = 'google_genai';

  private _model: string;
  private _client: GenAIClient | undefined;
  private _generationKwargs: GoogleGenAIGenerationKwargs;
  private _vertexai: boolean;
  private _stream: boolean;
  private _apiKey: string | undefined;
  private _project: string | undefined;
  private _location: string | undefined;
  private _clientFactory: ((auth: ProviderRequestAuth) => GenAIClient) | undefined;

  constructor(options: GoogleGenAIOptions) {
    this._model = options.model;
    this._vertexai = options.vertexai ?? false;
    this._stream = options.stream ?? true;
    this._generationKwargs = {};

    const apiKey = options.apiKey ?? process.env['GOOGLE_API_KEY'];
    this._apiKey = apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._project = options.project;
    this._location = options.location;
    this._clientFactory = options.clientFactory;
    this._client =
      this._vertexai || this._apiKey !== undefined ? this._buildClient(this._apiKey) : undefined;
  }

  private _buildClient(apiKey: string | undefined): GenAIClient {
    return new GenAIClient({
      apiKey,
      ...(this._vertexai
        ? {
            vertexai: true,
            project: this._project,
            location: this._location,
          }
        : {}),
    });
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    const thinkingConfig = this._generationKwargs.thinkingConfig;
    if (thinkingConfig === undefined) return null;

    // For gemini-3 models that use thinkingLevel
    if (thinkingConfig.thinkingLevel !== undefined) {
      switch (thinkingConfig.thinkingLevel) {
        case GoogleThinkingLevel.MINIMAL:
          // MINIMAL + suppressed thoughts is how 'off' is encoded for Gemini 3,
          // which has no true "disabled" level.
          return thinkingConfig.includeThoughts === false ? 'off' : 'low';
        case GoogleThinkingLevel.LOW:
          return 'low';
        case GoogleThinkingLevel.MEDIUM:
          return 'medium';
        case GoogleThinkingLevel.HIGH:
          return 'high';
        default:
          return null;
      }
    }

    // For other models that use thinkingBudget
    if (thinkingConfig.thinkingBudget !== undefined) {
      if (thinkingConfig.thinkingBudget === 0) return 'off';
      if (thinkingConfig.thinkingBudget <= 1024) return 'low';
      if (thinkingConfig.thinkingBudget <= 4096) return 'medium';
      return 'high';
    }

    return null;
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      ...this._generationKwargs,
    };
  }

  getCapability(model?: string): ModelCapability {
    return getGoogleGenAIModelCapability(model ?? this._model);
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    // Short-circuit if the caller has already aborted — the Google GenAI
    // SDK will not honor the signal natively, so we must check manually.
    if (options?.signal?.aborted === true) {
      throw createAbortError();
    }

    const contents = messagesToGoogleGenAIContents(history);

    const config: GoogleGenerateContentConfig = {
      ...this._generationKwargs,
      abortSignal: options?.signal,
      systemInstruction: systemPrompt,
      ...(tools.length > 0 ? { tools: tools.map((t) => toolToGoogleGenAI(t)) } : {}),
    };

    try {
      const client = this._createClient(options?.auth);
      const params: GoogleGenerateContentParameters = { model: this._model, contents, config };

      // Keep the explicit race in addition to the SDK's abortSignal support so
      // custom client implementations cannot delay cancellation while creating
      // the response/stream. The wrapper also checks at each chunk boundary.
      if (this._stream) {
        const stream = await Promise.race([
          client.models.generateContentStream(params),
          abortPromise(options?.signal),
        ]);
        return new GoogleGenAIStreamedMessage(
          stream as AsyncIterable<Record<string, unknown>>,
          true,
          options?.signal,
        );
      }

      const response = await Promise.race([
        client.models.generateContent(params),
        abortPromise(options?.signal),
      ]);
      return new GoogleGenAIStreamedMessage(
        response as unknown as Record<string, unknown>,
        false,
        options?.signal,
      );
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw convertGoogleGenAIError(error);
    }
  }

  private _createClient(auth: ProviderRequestAuth | undefined): GenAIClient {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) => {
        // Vertex AI auth flows through google-auth-library service credentials,
        // not a request-scoped apiKey, and the @google/genai SDK has no
        // perRequest header channel — so neither `auth.apiKey` nor
        // `auth.headers` is propagated in vertexai mode. Callers that need
        // request-scoped credentials should instead point their service
        // account at the right principal.
        if (this._vertexai) return this._buildClient(this._apiKey);
        return this._buildClient(requireProviderApiKey('GoogleGenAIChatProvider', a, this._apiKey));
      },
    );
  }

  withThinking(effort: ThinkingEffort): GoogleGenAIChatProvider {
    const thinkingConfig: GoogleThinkingConfig = { includeThoughts: true };

    if (this._model.includes('gemini-3')) {
      // Gemini 3 models use thinkingLevel (MINIMAL/LOW/MEDIUM/HIGH). The SDK
      // does not expose a "disabled" level, so 'off' maps to MINIMAL with
      // thought output suppressed — the lowest thinking intensity available.
      switch (effort) {
        case 'off':
          thinkingConfig.thinkingLevel = GoogleThinkingLevel.MINIMAL;
          thinkingConfig.includeThoughts = false;
          break;
        case 'low':
          thinkingConfig.thinkingLevel = GoogleThinkingLevel.LOW;
          break;
        case 'medium':
          thinkingConfig.thinkingLevel = GoogleThinkingLevel.MEDIUM;
          break;
        case 'high':
        case 'xhigh':
        case 'max':
          thinkingConfig.thinkingLevel = GoogleThinkingLevel.HIGH;
          break;
      }
    } else {
      switch (effort) {
        case 'off':
          thinkingConfig.thinkingBudget = 0;
          thinkingConfig.includeThoughts = false;
          break;
        case 'low':
          thinkingConfig.thinkingBudget = 1024;
          thinkingConfig.includeThoughts = true;
          break;
        case 'medium':
          thinkingConfig.thinkingBudget = 4096;
          thinkingConfig.includeThoughts = true;
          break;
        case 'high':
        case 'xhigh':
        case 'max':
          thinkingConfig.thinkingBudget = 32_000;
          thinkingConfig.includeThoughts = true;
          break;
      }
    }

    return this.withGenerationKwargs({ thinkingConfig });
  }

  withMaxCompletionTokens(maxCompletionTokens: number): GoogleGenAIChatProvider {
    const currentMax = this._generationKwargs.maxOutputTokens;
    const clamped = currentMax !== undefined
      ? Math.min(maxCompletionTokens, currentMax)
      : Math.min(maxCompletionTokens, 8192);
    return this.withGenerationKwargs({ maxOutputTokens: clamped });
  }

  withGenerationKwargs(kwargs: GoogleGenAIGenerationKwargs): GoogleGenAIChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  private _clone(): GoogleGenAIChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as GoogleGenAIChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    return clone;
  }
}
