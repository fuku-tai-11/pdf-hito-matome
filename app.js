const byId = (id) => document.getElementById(id);
const input = byId('files');
const zone = byId('drop-zone');
const queue = byId('queue');
const choose = byId('choose');
const run = byId('run');
const clear = byId('clear');
const status = byId('status');
const download = byId('download');
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
  run.disabled = busy || mode.files.length < mode.min || !window.PDFLib;
  for (const tab of tabs) tab.disabled = busy;
}

function addFiles(files) {
  if (busy || files.length === 0) return;
  removeResult();
  let rejected = 0;
  for (const file of files) {
    if (file.size > 0 && mode.pattern.test(file.name)) mode.files.push(file);
    else rejected++;
  }
  render();
  if (rejected) report(`対応形式以外、または空のファイルを${rejected}件スキップしました。`, true);
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

async function appendPdf(output, file) {
  const source = await PDFLib.PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
  if (!source.getPageCount()) throw new Error('PDFにページがありません。');
  const pages = await output.copyPages(source, source.getPageIndices());
  for (const page of pages) output.addPage(page);
}

run.addEventListener('click', async () => {
  if (busy || mode.files.length < mode.min) return;
  removeResult();
  busy = true;
  render();
  let currentFile;
  try {
    const pdf = await PDFLib.PDFDocument.create();
    const append = mode === modes.photos ? addPhoto : appendPdf;
    for (const [index, file] of mode.files.entries()) {
      currentFile = file;
      report(`処理中… ${index + 1} / ${mode.files.length}`);
      await append(pdf, file);
    }
    currentFile = undefined;
    const bytes = await pdf.save();
    resultUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    download.href = resultUrl;
    download.download = mode.filename;
    download.hidden = false;
    report(`PDFができました（${pdf.getPageCount()}ページ）。`);
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
