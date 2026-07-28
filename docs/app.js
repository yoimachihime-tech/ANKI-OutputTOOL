// app.js
// ---------------------------------------------------------------------------
// ANKI出力ツール Web版のUI。デスクトップ版(tts_gui.py)の「単語」タブに相当する。
//
// 【デスクトップ版との対応】
//   単語入力(word | 文脈 の複数行) → AI生成 → ストック一覧 → apkg出力
// という流れは tts_gui.py の単語タブと同じ。ストックの実体は
// word_stock.json ではなく localStorage になる。
//
// 【重複の扱い】
// デスクトップ版と同じく「重複していても常に追加し、一覧で警告表示して
// 手動で間引く」方式にしてある(黙ってスキップすると『生成成功なのに
// 増えない』という分かりにくい状態になるため)。

import { generateVocabCard, listModels, GeminiError } from './lib/gemini.js';
import { buildApkg, fieldsFromItem } from './lib/apkg.js';

const STORAGE = {
  apiKey: 'anki_tool_gemini_api_key',
  model: 'anki_tool_gemini_model',
  stock: 'anki_tool_word_stock',
};

const $ = (id) => document.getElementById(id);

/** 共有アセット(プロンプト・カード定義・スキーマ)。起動時に読み込む。 */
const shared = { prompt: null, cardDef: null, ankiSchema: null };

let stock = loadStock();

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

init().catch((e) => {
  setStatus($('generate-status'), `初期化に失敗しました: ${e.message}`, true);
});

async function init() {
  bindEvents();
  $('api-key').value = localStorage.getItem(STORAGE.apiKey) || '';
  $('model').value = localStorage.getItem(STORAGE.model) || 'gemini-2.0-flash';
  renderStock();

  const [prompt, cardDefs, ankiSchema] = await Promise.all([
    fetchText('./shared/word_card_prompt.txt'),
    fetchJson('./shared/card_defs.json'),
    fetchJson('./shared/anki_schema.json'),
  ]);
  shared.prompt = prompt;
  shared.cardDef = cardDefs.defs.word;
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

function bindEvents() {
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
  $('generate').addEventListener('click', onGenerate);
  $('delete-selected').addEventListener('click', onDeleteSelected);
  $('clear-stock').addEventListener('click', onClearStock);
  $('export').addEventListener('click', onExport);
  $('preview-close').addEventListener('click', () => $('preview-dialog').close());
}

// ---------------------------------------------------------------------------
// ストック(localStorage)
// ---------------------------------------------------------------------------

function loadStock() {
  try {
    const raw = localStorage.getItem(STORAGE.stock);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveStock() {
  localStorage.setItem(STORAGE.stock, JSON.stringify(stock));
}

/** 正規化した単語をキーに、重複している要素の index を返す(表示用)。 */
function duplicateIndices() {
  const counts = new Map();
  stock.forEach((item) => {
    const key = (item.word || '').trim().toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const dup = new Set();
  stock.forEach((item, i) => {
    if (counts.get((item.word || '').trim().toLowerCase()) > 1) dup.add(i);
  });
  return dup;
}

function renderStock() {
  const list = $('stock-list');
  const dup = duplicateIndices();
  list.textContent = '';

  stock.forEach((item, i) => {
    const li = document.createElement('li');
    if (dup.has(i)) li.className = 'duplicate';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.index = String(i);
    cb.setAttribute('aria-label', `${item.word} を選択`);

    const body = document.createElement('div');
    body.className = 'body';

    const word = document.createElement('div');
    word.className = 'word';
    word.textContent = item.word;
    if (dup.has(i)) {
      const tag = document.createElement('span');
      tag.className = 'dup-tag';
      tag.textContent = ' ⚠ 重複';
      word.appendChild(tag);
    }

    const meaning = document.createElement('div');
    meaning.className = 'meaning';
    meaning.textContent = item.meaning || '(意味なし)';

    body.append(word, meaning);

    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'ghost';
    preview.textContent = '🔍';
    preview.title = 'カードをプレビュー';
    preview.addEventListener('click', () => showPreview(item));

    li.append(cb, body, preview);
    list.appendChild(li);
  });

  $('stock-empty').hidden = stock.length > 0;
  $('stock-count').textContent = stock.length ? `(${stock.length} 件)` : '';
}

// ---------------------------------------------------------------------------
// 各種操作
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

async function onGenerate() {
  const status = $('generate-status');
  const apiKey = $('api-key').value.trim();
  if (!apiKey) {
    setStatus(status, 'Gemini APIキーを設定してください(⚙ 設定)。', true);
    $('settings').hidden = false;
    return;
  }
  if (!shared.prompt) {
    setStatus(status, '共有プロンプトの読み込みが完了していません。少し待って再試行してください。', true);
    return;
  }

  const pairs = parseWordPairs($('word-input').value);
  if (pairs.length === 0) {
    setStatus(status, '単語を入力してください。', true);
    return;
  }

  const btn = $('generate');
  btn.disabled = true;
  const model = $('model').value.trim() || 'gemini-2.0-flash';
  const generated = [];
  const failed = [];

  try {
    // デスクトップ版と同じく1件ずつ直列で呼ぶ(レート制限に配慮)。
    for (let i = 0; i < pairs.length; i += 1) {
      const { word, context } = pairs[i];
      setStatus(status, `生成中... (${i + 1}/${pairs.length}) ${word}`);
      try {
        generated.push(await generateVocabCard({
          word,
          contextSentence: context,
          apiKey,
          model,
          promptTemplate: shared.prompt,
        }));
      } catch (e) {
        failed.push(`${word}: ${e.message}`);
        if (e instanceof GeminiError && e.message.includes('1日あたり')) break;
      }
    }

    if (generated.length > 0) {
      stock = stock.concat(generated);
      saveStock();
      renderStock();
    }

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

function selectedIndices() {
  return [...document.querySelectorAll('#stock-list input[type="checkbox"]:checked')]
    .map((cb) => Number(cb.dataset.index));
}

function onDeleteSelected() {
  const indices = selectedIndices();
  if (indices.length === 0) {
    alert('削除する項目を選択してください。');
    return;
  }
  if (!confirm(`選択した ${indices.length} 件を削除します。よろしいですか？`)) return;
  const remove = new Set(indices);
  stock = stock.filter((_, i) => !remove.has(i));
  saveStock();
  renderStock();
}

function onClearStock() {
  if (stock.length === 0) {
    alert('カードがありません。');
    return;
  }
  if (!confirm(`${stock.length} 件すべてを削除します。よろしいですか？(取り消せません)`)) return;
  stock = [];
  saveStock();
  renderStock();
}

async function onExport() {
  const status = $('export-status');
  if (stock.length === 0) {
    setStatus(status, '出力するカードがありません。', true);
    return;
  }
  if (!shared.cardDef || !shared.ankiSchema) {
    setStatus(status, 'カード定義の読み込みが完了していません。少し待って再試行してください。', true);
    return;
  }

  const btn = $('export');
  btn.disabled = true;
  try {
    setStatus(status, '.apkg を生成中...');
    const blob = await buildApkg({
      cardDef: shared.cardDef,
      ankiSchema: shared.ankiSchema,
      items: stock,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `word_${stamp}.apkg`);
    setStatus(
      status,
      `${stock.length} 件を書き出しました。ダウンロードした .apkg を Anki で開いてください。`,
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

function showPreview(item) {
  const def = shared.cardDef;
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

  $('preview-title').textContent = `プレビュー: ${item.word}`;
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
  el.textContent = message;
  el.classList.toggle('error', isError);
}
