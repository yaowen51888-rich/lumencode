// public/tool-meta.js

// 工具元信息表：name -> { displayName, color(CSS var), subName }
export const TOOL_META = {
  claude:   { displayName: 'Claude Code',  color: 'var(--claude)',   subName: 'ANTHROPIC' },
  codex:    { displayName: 'OpenAI Codex', color: 'var(--codex)',    subName: 'OPENAI' },
  opencode: { displayName: 'OpenCode',     color: 'var(--opencode)', subName: 'OSS' },
  gemini:   { displayName: 'Gemini CLI',   color: 'var(--gemini)',   subName: 'GOOGLE' },
  qwen:     { displayName: 'Qwen Code',    color: 'var(--qwen)',     subName: 'ALIBABA' },
  goose:    { displayName: 'Goose',        color: 'var(--goose)',    subName: 'BLOCK' },
  amp:      { displayName: 'Amp',          color: 'var(--amp)',      subName: 'SOURCEGRAPH' },
  hermes:   { displayName: 'Hermes Agent', color: 'var(--hermes)',   subName: 'NOUS' },
  openclaw: { displayName: 'OpenClaw',     color: 'var(--openclaw)', subName: 'OSS' },
  kimi:     { displayName: 'Kimi CLI',     color: 'var(--kimi)',     subName: 'MOONSHOT' },
  codebuff: { displayName: 'Codebuff',     color: 'var(--codebuff)', subName: 'CODEBUFF' },
  droid:    { displayName: 'Droid',        color: 'var(--droid)',    subName: 'FACTORY' },
  pi:       { displayName: 'pi-agent',       color: '#9b59b6',       subName: 'PI' },
  kilo:     { displayName: 'Kilo',         color: '#1abc9c',         subName: 'OSS' },
  copilot:  { displayName: 'GitHub Copilot', color: '#3498db',       subName: 'GITHUB' },
};

// 兜底调色板（未知工具按 name hash 取色）
const PALETTE = ['#a26049','#347876','#4a5d8a','#b5832c','#6b4e8c','#2c7d5b','#a04b6e','#4a6b8a','#8a5c2c','#5b6b8a','#7c4a4a','#4a7c7c'];

export function toolMeta(name) {
  if (TOOL_META[name]) return TOOL_META[name];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { displayName: name, color: PALETTE[h % PALETTE.length], subName: name.toUpperCase() };
}
export const toolColor = (name) => toolMeta(name).color;
export const toolDisplayName = (name) => toolMeta(name).displayName;
export const toolSubName = (name) => toolMeta(name).subName;

// 派生 map（兼容 app.js 现有 this.toolColors[name] 用法）
export const TOOL_COLORS = Object.fromEntries(Object.entries(TOOL_META).map(([k, v]) => [k, v.color]));
export const TOOL_SUB_NAMES = Object.fromEntries(Object.entries(TOOL_META).map(([k, v]) => [k, v.subName]));
