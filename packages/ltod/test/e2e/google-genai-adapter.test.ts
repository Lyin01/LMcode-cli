import type { Message, StreamedMessagePart, ToolCall } from '#/message';
import { GoogleGenAIChatProvider } from '#/providers/google-genai';
import type { Tool } from '#/tool';
import type { TokenUsage } from '#/usage';
import { GoogleGenAI } from '@google/genai';
import { describe, expect, it } from 'vitest';

import { createFakeProviderHarness } from './fake-provider-harness';

async function collectParts(
  streamedMessage: AsyncIterable<StreamedMessagePart>,
): Promise<StreamedMessagePart[]> {
  const parts: StreamedMessagePart[] = [];
  for await (const part of streamedMessage) {
    parts.push(part);
  }
  return parts;
}

const ADD_TOOL: Tool = {
  name: 'add',
  description: 'Add two integers.',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'integer', description: 'First number' },
      b: { type: 'integer', description: 'Second number' },
    },
    required: ['a', 'b'],
  },
};

const MUL_TOOL: Tool = {
  name: 'multiply',
  description: 'Multiply two integers.',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'integer', description: 'First number' },
      b: { type: 'integer', description: 'Second number' },
    },
    required: ['a', 'b'],
  },
};

describe('e2e: Google GenAI adapter bridge', () => {
  it('sends the adapter request body, sorts tool responses, and parses streamed chunks', async () => {
    const harness = await createFakeProviderHarness();
    try {
      harness.route(
        'POST',
        '/v1beta/models/gemini-2.5-flash:streamGenerateContent',
        async (request, reply) => {
          const body = request.bodyJson as Record<string, unknown>;
          expect(request.pathname).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent');
          expect(request.search).toBe('?alt=sse');
          expect(request.headers['x-goog-api-key']).toBe('test-key');
          expect(body['generationConfig']).toEqual({});
          expect(body['systemInstruction']).toEqual({
            role: 'user',
            parts: [{ text: 'You are a calculator.' }],
          });
          expect(body['tools']).toEqual([
            {
              functionDeclarations: [
                {
                  name: ADD_TOOL.name,
                  description: ADD_TOOL.description,
                  parametersJsonSchema: ADD_TOOL.parameters,
                },
              ],
            },
            {
              functionDeclarations: [
                {
                  name: MUL_TOOL.name,
                  description: MUL_TOOL.description,
                  parametersJsonSchema: MUL_TOOL.parameters,
                },
              ],
            },
          ]);
          expect(body['contents']).toEqual([
            { role: 'user', parts: [{ text: 'Add and multiply these numbers.' }] },
            {
              role: 'model',
              parts: [
                { text: 'I will calculate both.' },
                {
                  functionCall: {
                    id: 'provider-add',
                    name: 'add',
                    args: { a: 2, b: 3 },
                  },
                },
                {
                  functionCall: {
                    id: 'provider-multiply',
                    name: 'multiply',
                    args: { a: 4, b: 5 },
                  },
                },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 'provider-add',
                    name: 'add',
                    response: { output: '5' },
                    parts: [],
                  },
                },
                {
                  functionResponse: {
                    id: 'provider-multiply',
                    name: 'multiply',
                    response: { output: '20' },
                    parts: [],
                  },
                },
              ],
            },
          ]);

          await reply.sseLines(200, [
            `data: ${JSON.stringify({
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: 'Done.' }],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 30,
                candidatesTokenCount: 4,
                cachedContentTokenCount: 1,
              },
              responseId: 'resp-1',
            })}`,
            '',
            `data: ${JSON.stringify({
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: {
                          name: 'notify',
                          id: 'call-1',
                          args: { ok: true },
                        },
                        thoughtSignature: 'sig-1',
                      },
                    ],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 30,
                candidatesTokenCount: 9,
                cachedContentTokenCount: 1,
                toolUsePromptTokenCount: 3,
                thoughtsTokenCount: 4,
              },
              responseId: 'resp-1',
            })}`,
            '',
            '',
          ]);
        },
      );

      const client = new GoogleGenAI({
        apiKey: 'test-key',
        httpOptions: {
          baseUrl: harness.baseUrl,
          apiVersion: 'v1beta',
        },
      });
      const provider = new GoogleGenAIChatProvider({
        model: 'gemini-2.5-flash',
        apiKey: 'test-key',
        stream: true,
        clientFactory: () => client,
      });

      const history: Message[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Add and multiply these numbers.' }],
          toolCalls: [],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'I will calculate both.' }],
          toolCalls: [
            {
              type: 'function',
              id: 'call_add',
              name: 'add', arguments: '{"a":2,"b":3}',
              extras: { google_function_call_id: 'provider-add' },
            },
            {
              type: 'function',
              id: 'call_mul',
              name: 'multiply', arguments: '{"a":4,"b":5}',
              extras: { google_function_call_id: 'provider-multiply' },
            },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: '20' }],
          toolCallId: 'call_mul',
          toolCalls: [],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: '5' }],
          toolCallId: 'call_add',
          toolCalls: [],
        },
      ];

      const stream = await provider.generate(
        'You are a calculator.',
        [ADD_TOOL, MUL_TOOL],
        history,
      );
      const parts = await collectParts(stream);

      expect(parts).toEqual([
        { type: 'text', text: 'Done.' },
        {
          type: 'function',
          id: 'notify_call-1',
          name: 'notify', arguments: '{"ok":true}',
          extras: {
            google_function_call_id: 'call-1',
            thought_signature_b64: 'sig-1',
          },
        } satisfies ToolCall,
      ]);

      expect(stream.id).toBe('resp-1');
      expect(stream.usage).toEqual({
        inputOther: 32,
        output: 13,
        inputCacheRead: 1,
        inputCacheCreation: 0,
      } satisfies TokenUsage);

      expect(harness.requests).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it('preserves adapter fields through the real SDK request serializer', async () => {
    const harness = await createFakeProviderHarness();
    try {
      harness.route(
        'POST',
        '/v1beta/models/gemini-2.5-flash:generateContent',
        async (_request, reply) => {
          await reply.json(200, {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    { text: 'Five.' },
                    {
                      functionCall: {
                        id: 'provider-follow-up',
                        name: 'add',
                        args: { a: 5, b: 1 },
                      },
                      thoughtSignature: 'cmVzcG9uc2Utc2lnbmF0dXJl',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 12,
              candidatesTokenCount: 4,
              cachedContentTokenCount: 2,
              toolUsePromptTokenCount: 3,
              thoughtsTokenCount: 5,
            },
            responseId: 'resp-nonstream-1',
          });
        },
      );

      const client = new GoogleGenAI({
        apiKey: 'test-key',
        httpOptions: {
          baseUrl: harness.baseUrl,
          apiVersion: 'v1beta',
        },
      });
      const provider = new GoogleGenAIChatProvider({
        model: 'gemini-2.5-flash',
        apiKey: 'test-key',
        stream: false,
        clientFactory: () => client,
      })
        .withThinking('low')
        .withMaxCompletionTokens(512)
        .withGenerationKwargs({ temperature: 0.2, topK: 20, topP: 0.8 });

      const history: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Add two and three from this image.' },
            {
              type: 'image_url',
              imageUrl: { url: 'data:image/png;base64,dXNlci1pbWFnZQ==' },
            },
          ],
          toolCalls: [],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'I will calculate it.' }],
          toolCalls: [
            {
              type: 'function',
              id: 'call_add',
              name: 'add',
              arguments: '{"a":2,"b":3}',
              extras: {
                google_function_call_id: 'provider-add',
                thought_signature_b64: 'c2lnbmF0dXJl',
              },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: '5' },
            {
              type: 'image_url',
              imageUrl: { url: 'data:image/png;base64,dG9vbC1pbWFnZQ==' },
            },
          ],
          toolCallId: 'call_add',
          toolCalls: [],
        },
      ];

      const stream = await provider.generate('You are a precise calculator.', [ADD_TOOL], history);
      expect(await collectParts(stream)).toEqual([
        { type: 'text', text: 'Five.' },
        {
          type: 'function',
          id: 'add_provider-follow-up',
          name: 'add',
          arguments: '{"a":5,"b":1}',
          extras: {
            google_function_call_id: 'provider-follow-up',
            thought_signature_b64: 'cmVzcG9uc2Utc2lnbmF0dXJl',
          },
        } satisfies ToolCall,
      ]);
      expect(stream.id).toBe('resp-nonstream-1');
      expect(stream.usage).toEqual({
        inputOther: 13,
        output: 9,
        inputCacheRead: 2,
        inputCacheCreation: 0,
      } satisfies TokenUsage);

      expect(harness.requests).toHaveLength(1);
      const request = harness.requests[0];
      expect(request?.pathname).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
      expect(request?.bodyJson).toEqual({
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'Add two and three from this image.' },
              { inlineData: { mimeType: 'image/png', data: 'dXNlci1pbWFnZQ==' } },
            ],
          },
          {
            role: 'model',
            parts: [
              { text: 'I will calculate it.' },
              {
                functionCall: {
                  id: 'provider-add',
                  name: 'add',
                  args: { a: 2, b: 3 },
                },
                thoughtSignature: 'c2lnbmF0dXJl',
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'provider-add',
                  name: 'add',
                  response: { output: '5' },
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: 'dG9vbC1pbWFnZQ==' } },
                  ],
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          topP: 0.8,
          topK: 20,
          maxOutputTokens: 512,
          thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 },
        },
        systemInstruction: {
          role: 'user',
          parts: [{ text: 'You are a precise calculator.' }],
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'add',
                description: 'Add two integers.',
                parametersJsonSchema: ADD_TOOL.parameters,
              },
            ],
          },
        ],
      });
    } finally {
      await harness.close();
    }
  });
});
