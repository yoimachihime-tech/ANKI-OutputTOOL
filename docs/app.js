// app.js
// ---------------------------------------------------------------------------
// ANKI出力ツール Web版のUI。デスクトップ版(tts_gui.py)の各入力元タブに
// 相当する画面をまとめて持つ(現状: 単語 / AIに質問)。
//
// 【設計方針】
// タブごとにitemの形・重複判定キー・カード定義が異なるため、デスクトップ版
// (tts_gui.pyがrefresh_word_stock_view/refresh_ai_ask_stock_view等を別々に
// 持つ)と同じく、汎用化しすぎずタブごとに並行した関数を持たせてある。
// 共通化しているのはAPI呼び出し(lib/gemini.js)・apkg組み立て(lib/apkg.js)・
// guid計算(lib/guid.js)・ローディング表示のヘルパー(showLoading/hideLoading)
// のみ。

import { generateVocabCard, generateGrammarMultiItems, listModels, GeminiError } from './lib/gemini.js';
import { buildApkg, fieldsFromItem } from './lib/apkg.js';

const STORAGE = {
  apiKey: 'anki_tool_gemini_api_key',
  model: 'anki_tool_gemini_model',
  wordStock: 'anki_tool_word_stock',
  aiAskStock: 'anki_tool_ai_ask_stock',
};

const $ = (id) => document.getElementById(id);

/** 共有アセット(プロンプト・カード定義・スキーマ)。起動時に読み込む。 */
const shared = { wordPrompt: null, grammarMultiPrompt: null, cardDefs: null, ankiSchema: null };

let wordStock = loadJson(STORAGE.wordStock);
let aiAskStock = loadJson(STORAGE.aiAskStock);

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

init().catch((e) => {
  setStatus($('word-generate-status'), `初期化に失敗しました: ${e.message}`, true);
});

async function init() {
  bindEvents();
  $('api-key').value = localStorage.getItem(STORAGE.apiKey) || '';
  $('model').value = localStorage.getItem(STORAGE.model) || 'gemini-2.0-flash';
  renderWordStock();
  renderAiAskStock();

  const [wordPrompt, grammarMultiPrompt, cardDefsJson, ankiSchema] = await Promise.all([
    fetchText('./shared/word_card_prompt.txt'),
    fetchText('./shared/grammar_multi_prompt.txt'),
    fetchJson('./shared/card_defs.json'),
    fetchJson('./shared/anki_schema.json'),
  ]);
  shared.wordPrompt = wordPrompt;
  shared.grammarMultiPrompt = grammarMultiPrompt;
  shared.cardDefs = cardDefsJson.defs;
  shared.ankiSchema = ankiSchema;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} を読み込めませんでした (HTTP ${res.status})`);
  return res.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function loadJson(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function bindEvents() {
  // タブ切り替え
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 設定(全タブ共通)
  $('settings-toggle').addEventListener('click', () => {
    $('settings').hidden = !$('settings').hidden;
  });
  $('toggle-key').addEventListener('click', () => {
    const el = $('api-key');
    el.type = el.type === 'password' ? 'text' : 'password';
  });
  $('api-key').addEventListener('change', (e) => {
    localStorage.setItem(STORAGE.apiKey, e.target.value.trim());
  });
  $('model').addEventListener('change', (e) => {
    localStorage.setItem(STORAGE.model, e.target.value.trim());
  });
  $('clear-key').addEventListener('click', onClearKey);
  $('fetch-models').addEventListener('click', onFetchModels);

  // 単語タブ
  $('word-generate').addEventListener('click', onWordGenerate);
  $('word-delete-selected').addEventListener('click', () => onDeleteSelected('word'));
  $('word-clear-stock').addEventListener('click', () => onClearStock('word'));
  $('word-export').addEventListener('click', () => onExport('word'));

  // AIに質問タブ
  $('ai-ask-generate').addEventListener('click', onAiAskGenerate);
  $('ai-ask-delete-selected').addEventListener('click', () => onDeleteSelected('ai_ask'));
  $('ai-ask-clear-stock').addEventListener('click', () => onClearStock('ai_ask'));
  $('ai-ask-export').addEventListener('click', () => onExport('ai_ask'));

  // プレビュー(共通)
  $('preview-close').addEventListener('click', () => $('preview-dialog').close());
}

function switchTab(key) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const active = btn.dataset.tab === key;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.id !== `tab-${key}`;
  });
}

// ---------------------------------------------------------------------------
// ローディング表示(2026-07-28追加)
// AI生成中であることが分かりにくいという指摘を受け、ボタンを無効化して
// 文言を変えるだけでなく、はっきり分かるスピナー付きの状態表示にした。
// ---------------------------------------------------------------------------

function showLoading(statusEl, message) {
  statusEl.classList.remove('error');
  statusEl.classList.add('loading');
  statusEl.textContent = '';
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = message;
  statusEl.append(spinner, text);
}

function hideLoading(statusEl) {
  statusEl.classList.remove('loading');
}

// ---------------------------------------------------------------------------
// 設定(APIキー・モデル)
// ---------------------------------------------------------------------------

function onClearKey() {
  if (!confirm('保存したAPIキーをこのブラウザから消去します。よろしいですか？')) return;
  localStorage.removeItem(STORAGE.apiKey);
  $('api-key').value = '';
}

async function onFetchModels() {
  const apiKey = $('api-key').value.trim();
  if (!apiKey) {
    alert('先にGemini APIキーを入力してください。');
    return;
  }
  const btn = $('fetch-models');
  btn.disabled = true;
  try {
    const names = await listModels(apiKey);
    const dl = $('model-list');
    dl.textContent = '';
    names.forEach((n) => {
      const opt = document.createElement('option');
      opt.value = n;
      dl.appendChild(opt);
    });
    alert(`${names.length} 件のモデルを取得しました。モデル欄の候補から選べます。`);
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 単語タブ
// ---------------------------------------------------------------------------

/** 正規化した単語をキーに、重複している要素の index を返す(表示用)。 */
function wordDuplicateIndices() {
  const counts = new Map();
  wordStock.forEach((item) => {
    const key = (item.word || '').trim().toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const dup = new Set();
  wordStock.forEach((item, i) => {
    if (counts.get((item.word || '').trim().toLowerCase()) > 1) dup.add(i);
  });
  return dup;
}

function renderWordStock() {
  const list = $('word-stock-list');
  const dup = wordDuplicateIndices();
  list.textContent = '';

  wordStock.forEach((item, i) => {
    const li = buildStockRow({
      isDuplicate: dup.has(i),
      title: item.word,
      subtitle: item.meaning || '(意味なし)',
      onPreview: () => showPreview('word', item),
    });
    list.appendChild(li);
  });

  $('word-stock-empty').hidden = wordStock.length > 0;
  $('word-stock-count').textContent = wordStock.length ? `(${wordStock.length} 件)` : '';
}

/** 「単語 | 文脈」形式の複数行入力をパースする(_parse_word_pairs と同じ)。 */
function parseWordPairs(text) {
  return text.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf('|');
      return idx === -1
        ? { word: line, context: '' }
        : { word: line.slice(0, idx).trim(), context: line.slice(idx + 1).trim() };
    })
    .filter((p) => p.word);
}

async function onWordGenerate() {
  const status = $('word-generate-status');
  const apiKey = $('api-key').value.trim();
  if (!apiKey) {
    setStatus(status, 'Gemini APIキーを設定してください(⚙ 設定)。', true);
    $('settings').hidden = false;
    return;
  }
  if (!shared.wordPrompt) {
    setStatus(status, '共有プロンプトの読み込みが完了していません。少し待って再試行してください。', true);
    return;
  }

  const pairs = parseWordPairs($('word-input').value);
  if (pairs.length === 0) {
    setStatus(status, '単語を入力してください。', true);
    return;
  }

  const btn = $('word-generate');
  btn.disabled = true;
  const model = $('model').value.trim() || 'gemini-2.0-flash';
  const generated = [];
  const failed = [];

  try {
    // デスクトップ版と同じく1件ずつ直列で呼ぶ(レート制限に配慮)。
    for (let i = 0; i < pairs.length; i += 1) {
      const { word, context } = pairs[i];
      showLoading(status, `生成中... (${i + 1}/${pairs.length}) ${word}`);
      try {
        generated.push(await generateVocabCard({
          word,
          contextSentence: context,
          apiKey,
          model,
          promptTemplate: shared.wordPrompt,
        }));
      } catch (e) {
        failed.push(`${word}: ${e.message}`);
        if (e instanceof GeminiError && (e.message.includes('1日あたり') || e.message.includes('前払いクレジット'))) break;
      }
    }

    if (generated.length > 0) {
      wordStock = wordStock.concat(generated);
      localStorage.setItem(STORAGE.wordStock, JSON.stringify(wordStock));
      renderWordStock();
    }

    hideLoading(status);
    // 全件成功したときだけ入力欄を空にする(失敗した行を片桐が確認できるように)。
    if (failed.length === 0) {
      $('word-input').value = '';
      setStatus(status, `${generated.length} 件のカードを生成しました。`);
    } else {
      setStatus(
        status,
        `${generated.length} 件成功 / ${failed.length} 件失敗\n${failed.join('\n')}`,
        generated.length === 0,
      );
    }
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// AIに質問タブ(Grammar Multi)
// ---------------------------------------------------------------------------

/** topic_key::note_index をキーに、重複している要素の index を返す(表示用)。
 * デスクトップ版のgrammar_multi_stock._item_key()と同じ考え方。 */
function aiAskDuplicateIndices() {
  const keyOf = (item) => `${item.topic_key || ''}::${item.note_index ?? ''}`;
  const counts = new Map();
  aiAskStock.forEach((item) => {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const dup = new Set();
  aiAskStock.forEach((item, i) => {
    if (counts.get(keyOf(item)) > 1) dup.add(i);
  });
  return dup;
}

function renderAiAskStock() {
  const list = $('ai-ask-stock-list');
  const dup = aiAskDuplicateIndices();
  list.textContent = '';

  aiAskStock.forEach((item, i) => {
    const questionPreview = htmlToPlainText(item.question).slice(0, 40);
    const li = buildStockRow({
      isDuplicate: dup.has(i),
      title: item.pattern || '(形式未設定)',
      subtitle: questionPreview,
      onPreview: () => showPreview('ai_ask', item),
    });
    list.appendChild(li);
  });

  $('ai-ask-stock-empty').hidden = aiAskStock.length > 0;
  $('ai-ask-stock-count').textContent = aiAskStock.length ? `(${aiAskStock.length} 件)` : '';
}

function htmlToPlainText(html) {
  return (html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').trim();
}

async function onAiAskGenerate() {
  const status = $('ai-ask-generate-status');
  const apiKey = $('api-key').value.trim();
  if (!apiKey) {
    setStatus(status, 'Gemini APIキーを設定してください(⚙ 設定)。', true);
    $('settings').hidden = false;
    return;
  }
  if (!shared.grammarMultiPrompt) {
    setStatus(status, '共有プロンプトの読み込みが完了していません。少し待って再試行してください。', true);
    return;
  }

  const question = $('ai-ask-input').value.trim();
  if (!question) {
    setStatus(status, '質問・お題を入力してください。', true);
    return;
  }

  const btn = $('ai-ask-generate');
  btn.disabled = true;
  const model = $('model').value.trim() || 'gemini-2.0-flash';

  try {
    showLoading(status, 'AIに質問中...(3問生成には数十秒かかることがあります)');
    const items = await generateGrammarMultiItems({
      question,
      apiKey,
      model,
      promptTemplate: shared.grammarMultiPrompt,
    });
    aiAskStock = aiAskStock.concat(items);
    localStorage.setItem(STORAGE.aiAskStock, JSON.stringify(aiAskStock));
    renderAiAskStock();
    hideLoading(status);
    $('ai-ask-input').value = '';
    setStatus(status, `${items.length} 件のカードを生成しました。`);
  } catch (e) {
    hideLoading(status);
    setStatus(status, e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 共通: 一覧の行・削除・出力
// ---------------------------------------------------------------------------

function buildStockRow({ isDuplicate, title, subtitle, onPreview }) {
  const li = document.createElement('li');
  if (isDuplicate) li.className = 'duplicate';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.setAttribute('aria-label', `${title} を選択`);

  const body = document.createElement('div');
  body.className = 'body';

  const titleEl = document.createElement('div');
  titleEl.className = 'title';
  titleEl.textContent = title;
  if (isDuplicate) {
    const tag = document.createElement('span');
    tag.className = 'dup-tag';
    tag.textContent = ' ⚠ 重複';
    titleEl.appendChild(tag);
  }

  const subtitleEl = document.createElement('div');
  subtitleEl.className = 'subtitle';
  subtitleEl.textContent = subtitle;

  body.append(titleEl, subtitleEl);

  const preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'ghost';
  preview.textContent = '🔍';
  preview.title = 'カードをプレビュー';
  preview.addEventListener('click', onPreview);

  li.append(cb, body, preview);
  return li;
}

const TAB_CONFIG = {
  word: {
    get stock() { return wordStock; },
    setStock: (v) => { wordStock = v; localStorage.setItem(STORAGE.wordStock, JSON.stringify(wordStock)); },
    listEl: 'word-stock-list',
    render: renderWordStock,
    label: (item) => item.word,
    cardDefKey: 'word',
  },
  ai_ask: {
    get stock() { return aiAskStock; },
    setStock: (v) => { aiAskStock = v; localStorage.setItem(STORAGE.aiAskStock, JSON.stringify(aiAskStock)); },
    listEl: 'ai-ask-stock-list',
    render: renderAiAskStock,
    label: (item) => `[${item.pattern || '形式未設定'}] ${htmlToPlainText(item.question).slice(0, 20)}`,
    cardDefKey: 'grammar_multi',
  },
};

function checkedIndicesOf(listElId) {
  const checkboxes = [...document.querySelectorAll(`#${listElId} input[type="checkbox"]`)];
  const indices = [];
  checkboxes.forEach((cb, i) => { if (cb.checked) indices.push(i); });
  return indices;
}

function onDeleteSelected(tabKey) {
  const cfg = TAB_CONFIG[tabKey];
  const indices = checkedIndicesOf(cfg.listEl);
  if (indices.length === 0) {
    alert('削除する項目を選択してください。');
    return;
  }
  if (!confirm(`選択した ${indices.length} 件を削除します。よろしいですか？`)) return;
  const remove = new Set(indices);
  cfg.setStock(cfg.stock.filter((_, i) => !remove.has(i)));
  cfg.render();
}

function onClearStock(tabKey) {
  const cfg = TAB_CONFIG[tabKey];
  if (cfg.stock.length === 0) {
    alert('カードがありません。');
    return;
  }
  if (!confirm(`${cfg.stock.length} 件すべてを削除します。よろしいですか？(取り消せません)`)) return;
  cfg.setStock([]);
  cfg.render();
}

async function onExport(tabKey) {
  const cfg = TAB_CONFIG[tabKey];
  const statusId = tabKey === 'word' ? 'word-export-status' : 'ai-ask-export-status';
  const status = $(statusId);

  if (cfg.stock.length === 0) {
    setStatus(status, '出力するカードがありません。', true);
    return;
  }
  const cardDef = shared.cardDefs?.[cfg.cardDefKey];
  if (!cardDef || !shared.ankiSchema) {
    setStatus(status, 'カード定義の読み込みが完了していません。少し待って再試行してください。', true);
    return;
  }

  const btnId = tabKey === 'word' ? 'word-export' : 'ai-ask-export';
  const btn = $(btnId);
  btn.disabled = true;
  try {
    setStatus(status, '.apkg を生成中...');
    const blob = await buildApkg({
      cardDef,
      ankiSchema: shared.ankiSchema,
      items: cfg.stock,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `${tabKey}_${stamp}.apkg`);
    setStatus(
      status,
      `${cfg.stock.length} 件を書き出しました。ダウンロードした .apkg を Anki で開いてください。`,
    );
  } catch (e) {
    setStatus(status, `.apkg の生成に失敗しました: ${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // iOS Safari では即座に revoke するとダウンロードが中断されることがある
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------------------------------------------------------------------
// カードプレビュー(実際のテンプレート + CSS でレンダリング)
// ---------------------------------------------------------------------------

function showPreview(tabKey, item) {
  const cardDefKey = TAB_CONFIG[tabKey].cardDefKey;
  const def = shared.cardDefs?.[cardDefKey];
  if (!def) {
    alert('カード定義の読み込みが完了していません。');
    return;
  }
  const fields = fieldsFromItem(def, item);
  const values = {};
  def.fields.forEach((f, i) => { values[f.anki_name] = fields[i]; });

  const tmpl = def.anki_model.tmpls[0];
  const front = renderTemplate(tmpl.qfmt, values);
  const back = renderTemplate(tmpl.afmt, values, front);

  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${def.anki_model.css}
hr.preview-sep{border:0;border-top:2px dashed #bbb;margin:24px 0}</style></head>
<body><div class="card">${front}<hr class="preview-sep">${back}</div></body></html>`;

  $('preview-title').textContent = `プレビュー: ${TAB_CONFIG[tabKey].label(item)}`;
  $('preview-frame').srcdoc = doc;
  $('preview-dialog').showModal();
}

/**
 * Anki のカードテンプレート(mustache 風)を簡易展開する。
 * デスクトップ版の tts_core.render_card_preview_html と同じ近似で、
 * {{Field}} / {{#Field}}...{{/Field}} / {{^Field}}...{{/Field}} /
 * {{FrontSide}} に対応する(条件の入れ子までは厳密に扱わない)。
 */
function renderTemplate(template, values, frontSide = '') {
  let out = template;
  out = out.replace(/\{\{FrontSide\}\}/g, frontSide);

  // 条件セクション: 値が空なら中身ごと削除、非空なら中身だけ残す
  for (const [name, value] of Object.entries(values)) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filled = value !== '';
    out = out.replace(new RegExp(`\\{\\{#${esc}\\}\\}([\\s\\S]*?)\\{\\{/${esc}\\}\\}`, 'g'),
      filled ? '$1' : '');
    out = out.replace(new RegExp(`\\{\\{\\^${esc}\\}\\}([\\s\\S]*?)\\{\\{/${esc}\\}\\}`, 'g'),
      filled ? '' : '$1');
  }

  // 単純な置換({{Field}} と、読み上げ等の修飾子付き {{xxx:Field}})
  out = out.replace(/\{\{([^#^/}][^}]*)\}\}/g, (match, expr) => {
    const name = expr.includes(':') ? expr.slice(expr.lastIndexOf(':') + 1) : expr;
    return Object.prototype.hasOwnProperty.call(values, name.trim()) ? values[name.trim()] : '';
  });
  return out;
}

function setStatus(el, message, isError = false) {
  el.classList.remove('loading');
  el.textContent = message;
  el.classList.toggle('error', isError);
}
