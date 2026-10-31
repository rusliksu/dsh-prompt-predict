// dsh-prompt-predict Host 插件入口.
import { registerPredictRoute } from './host-route.mjs';
import { prefetchSuggestion } from './prefetch.mjs';

const name = 'dsh-prompt-predict';
const inject = ['sessions', 'llm', 'agentDefaultModel', 'connection', 'webServer'];

export function apply(ctx, config = {}) {
  // cordis patch 的 config 作为部署默认；用户保存的设置（文件）在每次请求时再覆盖。
  // 内置兜底（provider/model/超时等）由 host-route 负责。
  const dispose = registerPredictRoute(ctx, config);

  // lokal prefetch: подсказка считается по завершении хода на хосте, а не в браузерном
  // таймере. `agent/status` -> `idle` — тот же сигнал конца хода, на котором висит
  // dsh-notify-on-complete. Субагентские сессии пропускаем: их подсказки не нужны.
  let offStatus = null;
  try {
    const onStatus = (payload) => {
      try {
        if (!payload || payload.status !== 'idle') return;
        const agent = payload.agent;
        const fromEvent = agent?.session;
        // Как в dsh-notify-on-complete: id агента и есть id сессии; header.id — запасной.
        const sessionId = typeof fromEvent?.header?.id === 'string'
          ? fromEvent.header.id
          : (typeof agent?.id === 'string' ? agent.id : fromEvent?.id);
        if (typeof sessionId !== 'string' || !sessionId) return;
        if (fromEvent?.header?.origin === 'subagent') return;
        const session = ctx?.sessions?.get?.(sessionId) ?? fromEvent;
        if (!session) return;
        const pending = prefetchSuggestion(ctx, session, config);
        if (pending && typeof pending.catch === 'function') pending.catch(() => { /* фоновая ошибка */ });
      } catch { /* предзагрузка не должна всплывать в агентский цикл */ }
    };
    offStatus = ctx.on?.('agent/status', onStatus) ?? null;
  } catch { offStatus = null; }

  ctx?.effect?.(() => () => {
    try { if (typeof offStatus === 'function') offStatus(); } catch { /* 忽略 */ }
    try { dispose?.(); } catch { /* 忽略 */ }
  }, 'dsh-prompt-predict: unregister HTTP route + prefetch');
}

export { name, inject };
