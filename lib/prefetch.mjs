// lokal prefetch: подсказка считается на хосте сразу по завершении хода.
//
// Зачем: клиентский триггер живёт в браузерном таймере, а Chromium замораживает
// таймеры в скрытом/свёрнутом окне. Пользователь возвращался в DSH и ждал модель
// 2–9 секунд. Здесь ход завершается по `agent/status` -> `idle`, результат кладётся
// в suggestions.json, а роут отдаёт его клиенту из кэша почти мгновенно.
import { predictNextPrompt, resolveRoute, DEFAULT_SYSTEM } from './predict.mjs';
import { readCachedSuggestion, saveCachedSuggestion, fingerprintOf, appendPredictionLog } from './suggestion-store.mjs';
import { readSettings } from './config.mjs';
import { makeT } from './messages.mjs';

// Зеркало builtinDefaults из host-route.mjs: prefetch живёт вне замыкания роута.
// Меняешь дефолт там — поменяй и здесь (наборы сверяются тестом healthcheck-а вручную).
const BUILTIN = {
  enabled: true,
  provider: 'auto',
  model: 'auto',
  timeoutMs: 12000,
  outputChars: 120,
  multilineSuggestions: true,
  maxMessages: 8,
  maxChars: 10000,
  reasoningEffort: 'off',
  suggestionLanguage: 'auto',
};

const T = makeT('en');
const inflight = new Map();   // sessionId -> { key, promise }
const clientSeen = new Map(); // sessionId -> время последнего запроса клиента
const SEEN_TTL_MS = 12 * 60 * 60 * 1000;

/** Клиент открывал эту сессию (status/suggest) — только для таких и считаем заранее. */
export function noteClientSeen(sessionId) {
  if (typeof sessionId === 'string' && sessionId) clientSeen.set(sessionId, Date.now());
}

/** Действующие настройки: дефолты + cordis patch + config.json пользователя. */
export function effectiveSettings(deploy = {}) {
  const settings = { ...BUILTIN, ...deploy };
  try { Object.assign(settings, readSettings()); } catch { /* нет файла — дефолты */ }
  if (settings.outputChars === undefined || settings.outputChars === null) {
    const legacy = Number(settings.maxTokens) || 256;
    settings.outputChars = Math.min(400, Math.max(20, Math.round(legacy * 0.6)));
  }
  settings.outputChars = Math.min(400, Math.max(20, Number(settings.outputChars) || 120));
  settings.multilineSuggestions = settings.multilineSuggestions !== false;
  return settings;
}

/** Короткий хеш своего промпта: его смена тоже делает кэш невалидным. */
function promptSignature(settings) {
  const text = String(settings.systemPrompt ?? '') + '\u0000' + String(settings.extraInstructions ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** Подпись настроек: кэш, посчитанный по другим настройкам, не отдаём. */
export function signatureOf(settings) {
  const language = settings.suggestionLanguage || 'auto';
  return [
    language,
    settings.multilineSuggestions !== false ? 'm' : 's',
    Number(settings.outputChars) || 120,
    Number(settings.maxMessages) || 8,
    Number(settings.maxChars) || 10000,
    promptSignature(settings),
  ].join('|');
}

/** Идущая предзагрузка для этого состояния сессии: роут переиспользует её. */
export function sharedPrediction(sessionId, fingerprint) {
  const item = inflight.get(sessionId);
  if (!item) return null;
  if (fingerprint && item.key !== fingerprint) return null;
  return item.promise;
}

function logPrefetch(sessionId, mode, fp, startedAt) {
  try { appendPredictionLog({ sessionId, cause: 'prefetch', mode, fp, ms: Date.now() - startedAt }); } catch { /* лог не критичен */ }
}

function routeKeyOf(route) {
  return route && route.provider && route.model ? route.provider + '/' + route.model : '';
}

/**
 * Запустить предзагрузку.
 * @returns Promise<{ suggestion, route }> | null — null значит «делать нечего».
 */
export function prefetchSuggestion(ctx, session, deploy = {}) {
  const eff = effectiveSettings(deploy);
  if (eff.enabled === false) return null;
  const sid = session?.id;
  if (typeof sid !== 'string' || !sid) return null;
  if (session?.header?.origin === 'subagent') return null;
  const seen = clientSeen.get(sid);
  if (!seen || Date.now() - seen > SEEN_TTL_MS) return null;
  let fp = '';
  try { fp = fingerprintOf(session); } catch { return null; }
  // Сессия ещё не спроецирована: ни предсказывать, ни кэшировать нечего.
  if (!fp || fp.startsWith('0:')) return null;

  let route = {};
  try { route = resolveRoute(ctx, session) ?? {}; } catch { route = {}; }
  const routeKey = routeKeyOf(route);
  const sig = signatureOf(eff);
  if (routeKey) {
    try { if (readCachedSuggestion(session, routeKey, sig)) return null; } catch { /* кэша нет */ }
  }
  const running = inflight.get(sid);
  if (running && running.key === fp) return running.promise;

  const startedAt = Date.now();
  const controller = new AbortController();
  const limit = Number(eff.timeoutMs) || 12000;
  const timer = setTimeout(() => { try { controller.abort(new Error('prefetch timeout')); } catch { controller.abort(); } }, limit);
  const base = {
    signal: controller.signal,
    system: (typeof eff.systemPrompt === 'string' && eff.systemPrompt.trim() && eff.systemPrompt.trim() !== DEFAULT_SYSTEM)
      ? eff.systemPrompt.trim()
      : undefined,
    extra: typeof eff.extraInstructions === 'string' ? eff.extraInstructions.trim() : '',
    outputChars: Number(eff.outputChars) || 120,
    maxMessages: Number(eff.maxMessages) || 8,
    maxChars: Number(eff.maxChars) || 10000,
    language: eff.suggestionLanguage || 'auto',
    multiline: eff.multilineSuggestions !== false,
    route: routeKey ? { provider: route.provider, model: route.model } : undefined,
    t: T,
  };
  const effort = typeof eff.reasoningEffort === 'string' && eff.reasoningEffort !== 'auto' ? eff.reasoningEffort : undefined;

  const promise = (async () => {
    try {
      let result;
      try {
        result = await predictNextPrompt(ctx, session, { ...base, reasoningEffort: effort });
      } catch (error) {
        if (!effort) throw error;
        // Тот же запасной путь, что в роуте: уровень размышления не подошёл модели.
        result = await predictNextPrompt(ctx, session, base);
      }
      const key = routeKey || routeKeyOf(result.route);
      // Пока модель думала, сессия могла уйти вперёд: такой текст уже не про текущее
      // состояние и под новый отпечаток его класть нельзя.
      let fresh = false;
      try { fresh = fingerprintOf(session) === fp; } catch { fresh = false; }
      if (fresh && result.suggestion) saveCachedSuggestion(session, result.suggestion, key, sig);
      logPrefetch(sid, fresh ? 'model' : 'stale', fp, startedAt);
      return result;
    } catch (error) {
      logPrefetch(sid, 'fail', fp, startedAt);
      throw error;
    } finally {
      clearTimeout(timer);
      const current = inflight.get(sid);
      if (current && current.key === fp) inflight.delete(sid);
    }
  })();
  inflight.set(sid, { key: fp, promise });
  promise.catch(() => { /* фоновая ошибка не должна всплывать как unhandled */ });
  return promise;
}
