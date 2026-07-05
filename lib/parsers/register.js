// lib/parsers/register.js
import { registerParser, getAllParsers } from './index.js';
import { ClaudeParser } from './claude.js';
import { CodexParser } from './codex.js';
import { OpencodeParser } from './opencode.js';
import { GeminiParser } from './gemini.js';
import { QwenParser } from './qwen.js';
import { GooseParser } from './goose.js';
import { AmpParser } from './amp.js';
import { HermesParser } from './hermes.js';
import { OpenclawParser } from './openclaw.js';
import { KimiParser } from './kimi.js';
import { CodebuffParser } from './codebuff.js';
import { DroidParser } from './droid.js';
import { PiParser } from './pi.js';
import { KiloParser } from './kilo.js';
import { CopilotParser } from './copilot.js';

const ALL_PARSERS = [
  ClaudeParser, CodexParser, OpencodeParser,
  GeminiParser, QwenParser, GooseParser, AmpParser,
  HermesParser, OpenclawParser, KimiParser, CodebuffParser, DroidParser,
  PiParser, KiloParser, CopilotParser,
];

/**
 * 统一注册全部 parser。幂等：重复调用不会重复注册同名 parser。
 */
export function registerAllParsers() {
  const seen = new Set(getAllParsers().map(p => p.getInfo().name));
  for (const P of ALL_PARSERS) {
    const name = new P().getInfo().name;
    if (seen.has(name)) continue;
    registerParser(P);
    seen.add(name);
  }
}
