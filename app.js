const byId = (id) => document.getElementById(id);
const input = byId('files');
const zone = byId('drop-zone');
const queue = byId('queue');
const choose = byId('choose');
const run = byId('run');
const clear = byId('clear');
const status = byId('status');
const download = byId('download');
const skipPages = byId('skip-pages');
const tabs = [...document.querySelectorAll('[data-mode]')];

const modes = {
  photos: {
    files: [], min: 1, pattern: /\.(jpe?g|png|webp)$/i, accept: '.jpg,.jpeg,.png,.webp',
    title: '写真をPDFに変換', description: '写真1枚を1ページにして、一覧の順番でまとめます。',
    drop: '写真をここにドロップ', formats: 'JPG、PNG、WebPに対応',
    choose: '写真を選ぶ', action: 'PDFを作成', filename: 'photos.pdf',
  },
  merge: {
    files: [], min: 2, pattern: /\.pdf$/i, accept: '.pdf',
    title: '複数のPDFを結合', description: 'PDFを2つ以上選び、一覧の順番で1つのPDFにまとめます。',
    drop: 'PDFをここにドロップ', formats: 'パスワードで保護されたPDFは対象外',
    choose: 'PDFを選ぶ', action: 'PDFを結合', filename: 'merged.pdf',
  },
};

let mode = modes.photos;
let busy = false;
let resultUrl;
const pdfHashes = new WeakMap();

function report(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function removeResult() {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = undefined;
  download.hidden = true;
  download.removeAttribute('href');
  report('');
}

function render() {
  queue.replaceChildren();
  mode.files.forEach((file, index) => {
    const row = document.createElement('li');
    row.className = 'item';
    const name = document.createElement('span');
    name.className = 'filename';
    name.textContent = `${index + 1}. ${file.name}`;
    row.append(name);
    for (const [label, accessible, offset] of [['↑', '上へ移動', -1], ['↓', '下へ移動', 1], ['削除', '削除', 0]]) {
      const button = document.createElement('button');
      const destination = index + offset;
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('aria-label', `${file.name}を${accessible}`);
      button.disabled = busy || destination < 0 || destination >= mode.files.length;
      button.addEventListener('click', () => {
        mode.files.splice(index, 1);
        if (offset) mode.files.splice(destination, 0, file);
        removeResult();
        render();
        const nextRow = queue.children[Math.min(destination, mode.files.length - 1)];
        const nextButton = nextRow?.querySelectorAll('button')[offset === -1 ? 0 : offset === 1 ? 1 : 2];
        (nextButton && !nextButton.disabled ? nextButton : nextRow?.querySelector('button:not(:disabled)') ?? choose).focus();
      });
      row.append(button);
    }
    queue.append(row);
  });
  queue.hidden = mode.files.length === 0;
  clear.hidden = queue.hidden;
  clear.disabled = busy;
  choose.disabled = busy;
  byId('merge-options').hidden = mode !== modes.merge;
  skipPages.disabled = busy;
  run.disabled = busy || mode.files.length < mode.min || !window.PDFLib;
  for (const tab of tabs) tab.disabled = busy;
}

async function fingerprintPdf(source, indices) {
  const normalized = await PDFLib.PDFDocument.create({ updateMetadata: false });
  await copyPages(normalized, source, indices);
  if (indices.length === 1) normalizePageResources(normalized.getPage(0));
  const pageData = await normalized.save({ updateFieldAppearances: false });
  const digest = await crypto.subtle.digest('SHA-256', pageData);
  return new Uint8Array(digest).join(',');
}

function normalizePageResources(page) {
  const { PDFArray, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } = PDFLib;
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray)) return;
  const streams = contents.asArray().map((entry) => page.doc.context.lookup(entry));
  if (!streams.every((stream) => stream instanceof PDFRawStream)) return;

  let instructions;
  try {
    instructions = streams.map((stream) => {
      if (stream.dict.keys().some((key) => !['/Length', '/Filter', '/DecodeParms'].includes(key.toString()))) return null;
      const bytes = decodePDFRawStream(stream).decode();
      if (bytes.some((byte) => byte > 127)) return null;
      return new TextDecoder().decode(bytes);
    });
  } catch {
    return;
  }
  // Restrict rewriting to streams without literal strings, comments, or inline images.
  if (instructions.some((text) => text === null || /[()%]|(?:^|\s)BI(?=\s)/.test(text))) return;

  const resources = page.node.Resources();
  const mappings = new Map();
  for (const [category, operator] of [['Font', 'Tf'], ['XObject', 'Do'], ['ExtGState', 'gs']]) {
    const dictionary = resources?.lookup(PDFName.of(category));
    if (!(dictionary instanceof PDFDict)) continue;
    const entries = dictionary.entries();
    const names = new Map();
    for (const [index, [name]] of entries.entries()) {
      const replacement = PDFName.of(`Dedup${category}${index}`);
      names.set(name.toString(), replacement.toString());
      dictionary.delete(name);
    }
    for (const [index, [, value]] of entries.entries()) dictionary.set(PDFName.of(`Dedup${category}${index}`), value);
    mappings.set(operator, names);
  }
  if (!mappings.size) return;

  for (const [index, text] of instructions.entries()) {
    const rewritten = text.replace(
      /(\/[^\s<>\[\]{}\/]+)(\s+(?:[+-]?(?:\d*\.)?\d+\s+)?)(Tf|Do|gs)(?=\s|$)/g,
      (match, name, spacing, operator) => {
        const canonical = mappings.get(operator)?.get(name);
        return canonical ? `${canonical}${spacing}${operator}` : match;
      },
    );
    const ref = contents.get(index);
    const replacement = page.doc.context.flateStream(new TextEncoder().encode(rewritten));
    if (ref instanceof PDFLib.PDFRef) page.doc.context.assign(ref, replacement);
    else contents.set(index, replacement);
  }
}

async function addFiles(files) {
  if (busy || files.length === 0) return;
  const incoming = Array.from(files);
  if (mode === modes.photos) {
    const photos = incoming.filter((file) => file.size > 0 && mode.pattern.test(file.name));
    if (photos.length) removeResult();
    mode.files.push(...photos);
    render();
    if (photos.length < incoming.length) {
      report(`対応形式以外、または空のファイルを${incoming.length - photos.length}件スキップしました。`, true);
    }
    return;
  }

  if (!window.PDFLib) return;
  busy = true;
  render();
  report('PDFの重複を確認中…');
  const existing = new Set(mode.files.map((file) => pdfHashes.get(file)));
  let rejected = 0;
  let duplicates = 0;
  let unreadable = 0;
  const accepted = [];
  try {
    for (const file of incoming) {
      if (file.size === 0 || !mode.pattern.test(file.name)) {
        rejected++;
        continue;
      }
      try {
        const source = await loadPdf(file);
        const hash = await fingerprintPdf(source, source.getPageIndices());
        if (existing.has(hash)) {
          duplicates++;
          continue;
        }
        existing.add(hash);
        pdfHashes.set(file, hash);
        accepted.push(file);
      } catch {
        unreadable++;
      }
    }
    if (accepted.length) {
      removeResult();
      mode.files.push(...accepted);
    }
    const messages = [];
    if (duplicates) messages.push(`同じ内容のPDFを${duplicates}件スキップしました。`);
    if (rejected) messages.push(`対応形式以外、または空のファイルを${rejected}件スキップしました。`);
    if (unreadable) messages.push(`読み込めなかったPDFを${unreadable}件スキップしました。PDFが開けるか、パスワードで保護されていないか確認してください。`);
    report(messages.join(' '), rejected + unreadable > 0);
  } finally {
    busy = false;
    render();
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    const selected = modes[tab.dataset.mode];
    if (selected === mode) return;
    removeResult();
    mode = selected;
    for (const option of tabs) option.setAttribute('aria-pressed', String(option === tab));
    byId('mode-title').textContent = mode.title;
    byId('mode-description').textContent = mode.description;
    byId('drop-label').textContent = mode.drop;
    byId('formats').textContent = mode.formats;
    choose.textContent = mode.choose;
    run.textContent = mode.action;
    input.accept = mode.accept;
    render();
  });
}

choose.addEventListener('click', () => input.click());
skipPages.addEventListener('change', removeResult);
input.addEventListener('change', () => {
  addFiles(input.files);
  input.value = '';
});
clear.addEventListener('click', () => {
  mode.files.length = 0;
  removeResult();
  render();
  choose.focus();
});
window.addEventListener('dragover', (event) => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});
window.addEventListener('drop', (event) => {
  if (event.dataTransfer.files.length) event.preventDefault();
});
zone.addEventListener('dragover', (event) => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
  zone.classList.toggle('dragging', !busy);
});
zone.addEventListener('dragleave', (event) => {
  if (!zone.contains(event.relatedTarget)) zone.classList.remove('dragging');
});
zone.addEventListener('drop', (event) => {
  event.preventDefault();
  zone.classList.remove('dragging');
  addFiles(event.dataTransfer.files);
});

async function addPhoto(pdf, file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  try {
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('画像を保存できません。')), 'image/jpeg', 0.92);
    });
    const image = await pdf.embedJpg(await jpeg.arrayBuffer());
    const [pageWidth, pageHeight] = bitmap.width > bitmap.height ? [841.89, 595.28] : [595.28, 841.89];
    const page = pdf.addPage([pageWidth, pageHeight]);
    const { width, height } = image.scaleToFit(pageWidth - 48, pageHeight - 48);
    page.drawImage(image, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height });
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}

async function loadPdf(file) {
  const source = await PDFLib.PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
  if (!source.getPageCount()) throw new Error('PDFにページがありません。');
  return source;
}

async function copyPages(output, source, indices) {
  const pages = await output.copyPages(source, indices);
  for (const page of pages) output.addPage(page);
}

async function appendPdf(output, file, seenPages) {
  const source = await loadPdf(file);
  const indices = source.getPageIndices();
  if (!seenPages) {
    await copyPages(output, source, indices);
    return 0;
  }
  const unique = [];
  for (const index of indices) {
    const hash = await fingerprintPdf(source, [index]);
    if (seenPages.has(hash)) continue;
    seenPages.add(hash);
    unique.push(index);
  }
  if (unique.length) await copyPages(output, source, unique);
  return indices.length - unique.length;
}

run.addEventListener('click', async () => {
  if (busy || mode.files.length < mode.min) return;
  removeResult();
  busy = true;
  render();
  let currentFile;
  try {
    const pdf = await PDFLib.PDFDocument.create();
    const seenPages = mode === modes.merge && skipPages.checked ? new Set() : undefined;
    let skipped = 0;
    for (const [index, file] of mode.files.entries()) {
      currentFile = file;
      report(`処理中… ${index + 1} / ${mode.files.length}`);
      if (mode === modes.photos) await addPhoto(pdf, file);
      else skipped += await appendPdf(pdf, file, seenPages);
    }
    currentFile = undefined;
    const bytes = await pdf.save();
    resultUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    download.href = resultUrl;
    download.download = mode.filename;
    download.hidden = false;
    const duplicateMessage = skipped ? ` 重複ページを${skipped}枚除きました。` : '';
    report(`PDFができました（${pdf.getPageCount()}ページ）。${duplicateMessage}`);
    download.click();
  } catch {
    const hint = mode === modes.photos ? '画像が開けるか確認してください。' : 'PDFが開けるか、パスワードで保護されていないか確認してください。';
    report(currentFile ? `「${currentFile.name}」を処理できませんでした。 ${hint}` : 'PDFを保存できませんでした。', true);
  } finally {
    busy = false;
    render();
  }
});

render();
if (!window.PDFLib) report('PDF処理ライブラリを読み込めませんでした。ページを再読み込みしてください。', true);
