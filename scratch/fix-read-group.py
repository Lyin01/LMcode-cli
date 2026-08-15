import sys

READ = 'packages/agent-core/src/tools/builtin/file/read.ts'
READ_GROUP = 'packages/agent-core/src/tools/builtin/file/read-group.ts'


def crlf(text: str) -> bytes:
    return text.replace('\n', '\r\n').encode('utf-8')


def apply(path: str, old_text: str, new_text: str) -> None:
    data = open(path, 'rb').read()
    old = crlf(old_text)
    count = data.count(old)
    if count != 1:
        print(f'FAIL: block found {count} times in {path}', file=sys.stderr)
        sys.exit(1)
    open(path, 'wb').write(data.replace(old, crlf(new_text)))
    print(f'ok {path}')


apply(
    READ,
    "const PositiveLineOffsetSchema = z.number().int().min(1);\n"
    "const TailLineOffsetSchema = z.number().int().min(-MAX_LINES).max(-1);\n",
    "const PositiveLineOffsetSchema = z.number().int().min(1);\n"
    "const TailLineOffsetSchema = z.number().int().min(-MAX_LINES).max(-1);\n"
    "\n"
    "/**\n"
    " * Shared `line_offset` contract for Read-family tools: a 1-based start\n"
    " * line, or a negative tail read whose absolute value is bounded by\n"
    " * MAX_LINES. ReadGroup reuses this so both tools accept the same range.\n"
    " */\n"
    "export const ReadLineOffsetSchema = z.union([PositiveLineOffsetSchema, TailLineOffsetSchema]);\n",
)

apply(
    READ,
    "  line_offset: z\n"
    "    .union([PositiveLineOffsetSchema, TailLineOffsetSchema])\n"
    "    .optional()\n",
    "  line_offset: ReadLineOffsetSchema\n"
    "    .optional()\n",
)

apply(
    READ_GROUP,
    "  line_offset: z\n"
    "    .number()\n"
    "    .int()\n"
    "    .optional()\n"
    "    .describe('Starting line number applied to every file.'),\n",
    "  line_offset: ReadLineOffsetSchema\n"
    "    .optional()\n"
    "    .describe(\n"
    "      'Starting line number applied to every file. Negative values read from the end of each file.',\n"
    "    ),\n",
)

apply(
    READ_GROUP,
    "import { ReadTool } from './read';\n",
    "import { ReadLineOffsetSchema, ReadTool } from './read';\n",
)
