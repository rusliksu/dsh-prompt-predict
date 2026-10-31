// Кэш «следующей подсказки» на хосте: по сессии храним одну запись в suggestions.json.
//
// Зачем: подсказка теперь считается сразу по концу хода (prefetch), а клиент лишь
// достаёт её из кэша, когда окно снова активно. Без кэша на диске после перезапуска
// DSH готовое предсказание терялось бы, и пользователь ждал модель заново.
//
// Запись валидна, только пока не изменилось состояние диалога: отпечаток = число
// сообщений + хеш последних трёх. Плюс подпись настроек (язык/многострочность/длина),
// чтобы смена настроек не показывала подсказку, посчитанную по-другому.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { messageText } from './predict.mjs';

const STORE_MAX = 200;
const STORE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function suggestionsFilePath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-prompt-predict', 'suggestions.json');
}

function readStore() {
  try {
    const raw = JSON.parse(readFileSync(suggestionsFilePath(), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function writeStore(store) {
  try {
    mkdirSync(dirname(suggestionsFilePath()), { recursive: true, mode: 0o700 });
    writeFileSync(suggestionsFilePath(), JSON.stringify(store), { mode: 0o600 });
  } catch { /* не смогли записать — подсказка всё равно уйдёт клиенту */ }
}

function pruneStore(store) {
  const now = Date.now();
  return Object.fromEntries(Object.entries(store)
    .filter(([, value]) => value && typeof value.text === 'string' && Number.isFinite(value.at) && now - value.at < STORE_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, STORE_MAX));
}

/** Отпечаток состояния сессии: число сообщений + хвост из трёх. */
export function fingerprintOf(session) {
  try {
    const messages = session?.deriveMessages?.() ?? [];
    const tail = messages.slice(-3).map((message) => (message?.role ?? '') + ':' + messageText(message)).join('\u0000');
    return messages.length + ':' + createHash('sha1').update(tail).digest('hex');
  } catch { return ''; }
}

function messageCountOf(session) {
  try { return (session?.deriveMessages?.() ?? []).length; } catch { return 0; }
}

export function saveCachedSuggestion(session, text, route, sig) {
  if (!session?.id || !text) return;
  if (messageCountOf(session) === 0) return;
  const store = readStore();
  store[session.id] = {
    text,
    at: Date.now(),
    fp: fingerprintOf(session),
    ...(route ? { route } : {}),
    ...(sig ? { sig } : {}),
  };
  writeStore(pruneStore(store));
}

export function readCachedSuggestion(session, route, sig) {
  if (!session?.id) return null;
  const fp = fingerprintOf(session);
  if (!fp) return null;
  const store = readStore();
  const hit = store[session.id];
  if (!hit || typeof hit.text !== 'string' || hit.fp !== fp) {
    // Сессия ещё проецируется (сообщений нет) — запись не трогаем, пригодится позже.
    if (hit && messageCountOf(session) > 0) { delete store[session.id]; writeStore(store); }
    return null;
  }
  // Другая модель или другие настройки — это другая подсказка, кэш не отдаём.
  if (route && hit.route && hit.route !== route) return null;
  if (sig && hit.sig && hit.sig !== sig) return null;
  return hit;
}

export function cachedSuggestionState(session, route, sig) {
  if (!session?.id) return { kind: 'miss' };
  const hit = readCachedSuggestion(session, route, sig);
  if (hit) return { kind: 'hit', hit };
  if (messageCountOf(session) === 0) {
    const stored = readStore()[session.id];
    if (stored && typeof stored.text === 'string') return { kind: 'pending' };
  }
  return { kind: 'miss' };
}

/** Строка в predict.log: без содержимого, только причина/режим/время. */
export function appendPredictionLog({ sessionId, cause, mode, fp, ms }) {
  try {
    const file = join(dirname(suggestionsFilePath()), 'predict.log');
    const line = [
      new Date().toISOString(),
      'sid=' + createHash('sha1').update(String(sessionId ?? '')).digest('hex').slice(0, 8),
      'cause=' + String(cause ?? '').slice(0, 16),
      'mode=' + String(mode ?? ''),
      'fp=' + String(fp ?? '').slice(0, 12),
      'ms=' + String(ms ?? ''),
    ].join(' ') + '\n';
    appendFileSync(file, line, { mode: 0o600 });
    if (statSync(file).size > 262144) renameSync(file, file + '.1');
  } catch { /* диагностика не должна ломать предсказание */ }
}

export function forgetCachedSuggestion(sessionId) {
  if (!sessionId) return;
  const store = readStore();
  if (!(sessionId in store)) return;
  delete store[sessionId];
  writeStore(store);
}
