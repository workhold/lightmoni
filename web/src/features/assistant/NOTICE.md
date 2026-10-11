# Doca reference and license

LightMoni's assistant event/tool/session architecture and timeline presentation were ported from the Doca AI skeleton. Doca is a TypeScript/Fastify host; the LightMoni provider and runner are implemented in Go. No Doca credentials, runtime database, document editors, image workflows, or private settings were copied.

Reference files inspected read-only on 2026-10-10:

- `packages/ai-host/src/{host,events,tools,registry}.ts`
- `apps/server/src/routes/ai.ts`
- `apps/server/src/services/ai/{runner,model}.ts`
- `apps/web/src/features/ai/{ai-chat,ai-timeline,ai-session-ux}.ts(x)`
- `apps/web/src/features/ai/ai-markdown.tsx` (safe streaming Markdown renderer adapted to monitoring SQL)

MIT License

Copyright (c) 2026 smartdoca

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
