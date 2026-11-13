pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  'vendor/pdf.worker.min.js',
);

const fileInput = document.getElementById('pdfFile');
const rulesInput = document.getElementById('rules');
const status = document.getElementById('status');
const processButton = document.getElementById('process');

const BMW_POLISH_REPLACEMENTS = [
  [/³/g, 'ł'],
  [/ê/g, 'ę'],
  [/¿/g, 'ż'],
  [/¹/g, 'ą'],
  [/œ/g, 'ś'],
  [/æ/g, 'ć'],
  [/¼/g, 'ź'],
  [/¥/g, 'Ą'],
  [/£/g, 'Ł'],
  [/Œ/g, 'Ś'],
  [/ñ/g, 'ń'],
  [/Ê/g, 'Ę'],
  [/Æ/g, 'Ć'],
  [/Ñ/g, 'Ń'],
];

function repairPolishText(text) {
  if (typeof text !== 'string' || !text) {
    return text;
  }

  let result = text;

  for (const [pattern, replacement] of BMW_POLISH_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

function fixText(text, rules) {
  let result = repairPolishText(text);

  for (const [wrong, correct] of Object.entries(rules)) {
    if (!wrong) continue;

    result = result.split(wrong).join(String(correct));
  }

  return result;
}

function setStatus(message) {
  status.textContent = message;
}

/**
 * Dopasowanie tekstu do oryginalnej szerokości.
 */
function fitFontSize(ctx, text, width, height) {
  let size = height;

  ctx.font = `${size}px Arial`;

  const measured = ctx.measureText(text).width;

  if (measured > width && measured > 0 && width > 0) {
    size *= width / measured;
  }

  return Math.max(1, size);
}

/**
 * Obliczanie obszaru zakrywania tekstu.
 */

function getTextBounds(item, viewport, quality, styles = {}) {
  const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);

  const x = transform[4];
  const y = transform[5];

  const fontHeight = Math.max(8, Math.hypot(transform[2], transform[3]));

  const width = Math.abs(item.width * quality);

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    width <= 0
  ) {
    return null;
  }

  // Pobranie rzeczywistych parametrów czcionki.
  const style = styles[item.fontName] || {};

  const ascent = Number.isFinite(style.ascent) ? style.ascent : 0.85;

  const descent = Number.isFinite(style.descent) ? style.descent : -0.25;

  // Rzeczywisty obszar liter.
  const paddingX = Math.max(3, fontHeight * 0.18);
  const paddingY = Math.max(2, fontHeight * 0.12);

  const left = Math.max(0, x - paddingX);

  const top = Math.max(0, y - fontHeight * ascent - paddingY);

  const right = Math.min(viewport.width, x + width + paddingX);

  const bottom = Math.min(viewport.height, y - fontHeight * descent + paddingY);

  if (right <= left || bottom <= top) {
    return null;
  }

  return {
    x,
    y,
    width,
    fontHeight,
    left,
    top,
    right,
    bottom,
    coverWidth: right - left,
    coverHeight: bottom - top,
  };
}

/**
 * Zbieranie wszystkich tekstów wymagających poprawy.
 */
function collectTextReplacements(content, viewport, rules, quality) {
  const replacements = [];

  for (const item of content.items) {
    if (!item.str || !item.str.trim()) {
      continue;
    }

    const corrected = fixText(item.str, rules);

    if (corrected === item.str) {
      continue;
    }

    const bounds = getTextBounds(item, viewport, quality, content.styles);

    if (!bounds) {
      continue;
    }

    replacements.push({
      original: item.str,
      corrected,
      bounds,
    });
  }

  return replacements;
}

/**
 * ETAP 1:
 * Zakrywanie wszystkich starych tekstów.
 */
function coverOldText(ctx, replacements) {
  ctx.save();

  ctx.fillStyle = '#ffffff';

  for (const replacement of replacements) {
    const b = replacement.bounds;

    ctx.fillRect(b.left, b.top, b.coverWidth, b.coverHeight);
  }

  ctx.restore();
}

/**
 * ETAP 2:
 * Rysowanie wszystkich poprawionych tekstów.
 */
function drawCorrectedText(ctx, replacements) {
  ctx.save();

  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  for (const replacement of replacements) {
    const { corrected, bounds } = replacement;

    const fontSize = fitFontSize(
      ctx,
      corrected,
      bounds.width,
      bounds.fontHeight,
    );

    ctx.font = `${fontSize}px Arial`;

    ctx.fillText(corrected, bounds.x, bounds.y, bounds.width);
  }

  ctx.restore();
}

/**
 * Przetwarzanie PDF.
 */
async function processPDF(file, rules, quality) {
  const bytes = await file.arrayBuffer();

  const source = await pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
  }).promise;

  const output = await PDFLib.PDFDocument.create();

  let changedItems = 0;

  try {
    for (let pageNumber = 1; pageNumber <= source.numPages; pageNumber++) {
      setStatus(`Przetwarzanie strony ${pageNumber} / ${source.numPages}`);

      const page = await source.getPage(pageNumber);

      const viewport = page.getViewport({
        scale: quality,
      });

      const canvas = document.createElement('canvas');

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      const ctx = canvas.getContext('2d', {
        alpha: false,
      });

      if (!ctx) {
        throw new Error('Nie udało się utworzyć kontekstu canvas.');
      }

      // Odtworzenie oryginalnej strony.
      await page.render({
        canvasContext: ctx,
        viewport,
      }).promise;

      // Pobranie tekstu.
      const content = await page.getTextContent();

      // Przygotowanie listy poprawek.
      const replacements = collectTextReplacements(
        content,
        viewport,
        rules,
        quality,
      );

      // ETAP 1: zakrywanie starych tekstów.
      coverOldText(ctx, replacements);

      // ETAP 2: rysowanie nowych tekstów.
      drawCorrectedText(ctx, replacements);

      changedItems += replacements.length;

      // Konwersja strony do PNG.
      const image = await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Nie udało się wygenerować obrazu strony.'));
          }
        }, 'image/png');
      });

      const imageBytes = await image.arrayBuffer();

      const embedded = await output.embedPng(imageBytes);

      const pdfPage = output.addPage([
        viewport.width / quality,
        viewport.height / quality,
      ]);

      pdfPage.drawImage(embedded, {
        x: 0,
        y: 0,
        width: viewport.width / quality,
        height: viewport.height / quality,
      });

      // Zwolnienie pamięci Canvas.
      canvas.width = 0;
      canvas.height = 0;
    }

    setStatus('Zapisywanie poprawionego PDF...');

    const result = await output.save();

    return {
      blob: new Blob([result], {
        type: 'application/pdf',
      }),
      changedItems,
    };
  } finally {
    await source.destroy();
  }
}

/**
 * Obsługa przycisku.
 */
processButton.addEventListener('click', async () => {
  const file = fileInput.files[0];

  if (!file) {
    setStatus('Najpierw wybierz PDF.');
    return;
  }

  try {
    const rules = JSON.parse(rulesInput.value || '{}');

    if (!rules || Array.isArray(rules) || typeof rules !== 'object') {
      throw new Error('Reguły muszą być obiektem JSON.');
    }

    const quality = 4;

    processButton.disabled = true;

    setStatus('Rozpoczynam naprawianie PDF...');

    const result = await processPDF(file, rules, quality);

    const url = URL.createObjectURL(result.blob);

    const link = document.createElement('a');

    link.href = url;

    link.download = file.name.replace(/\.pdf$/i, '') + '_POPRAWIONY.pdf';

    document.body.appendChild(link);

    link.click();

    link.remove();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 60000);

    setStatus(`Gotowe! Poprawiono ${result.changedItems} fragmentów tekstu.`);
  } catch (error) {
    console.error(error);

    setStatus('Błąd: ' + error.message);
  } finally {
    processButton.disabled = false;
  }
});
