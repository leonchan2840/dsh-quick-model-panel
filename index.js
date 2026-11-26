import z from '@deepseek-ai/schemastery';
import defaults from './src/startup-defaults.cjs';

export const inject = ['llm', 'agentTeams', 'agents', 'sessions', 'sessionProjections'];
export const Config = z.object({
  newSessionTeam: z.union(['inherit', 'on', 'off']).default('inherit').volatile(),
  defaultEffort: z.string().default('').volatile(),
});

export function apply(ctx, config) {
  const applier = defaults.createDefaultApplier(ctx, config);
  // 原生创建时在首条输入前应用；设置保存后补齐会被“新建会话”复用的空白草稿。
  ctx.on('session/event', applier.onEvent);
  ctx.on('agent/created', applier.onCreated);
  ctx.on('loader/volatile-update', applier.onSaved);
  // 插件热重载时，已有的可复用空白草稿不会重新触发 agent/created。
  applier.onSaved([['newSessionTeam'], ['defaultEffort']]);
}
