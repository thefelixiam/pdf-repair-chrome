pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  'vendor/pdf.worker.min.js',
);

const fileInput = document.getElementById('pdfFile');
const rulesInput = document.getElementById('rules');
const status = document.getElementById('status');
const processButton = document.getElementById('process');

function setStatus(message) {
  status.textContent = message;
}

function fixText(text, rules) {
  let result = text;

  for (const [wrong, correct] of Object.entries(rules)) {
    result = result.split(wrong).join(correct);
  }

  return result;
}

async function processPDF(file, rules, quality) {
  const bytes = await file.arrayBuffer();

  const source = await pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
  }).promise;

  const output = await PDFLib.PDFDocument.create();

  for (let pageNumber = 1; pageNumber <= source.numPages; pageNumber++) {
    setStatus('Przetwarzanie strony ' + pageNumber + ' / ' + source.numPages);

    const page = await source.getPage(pageNumber);

    const viewport = page.getViewport({
      scale: quality,
    });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    const ctx = canvas.getContext('2d');

    await page.render({
      canvasContext: ctx,
      viewport: viewport,
    }).promise;

    const content = await page.getTextContent();

    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;

      const corrected = fixText(item.str, rules);

      if (corrected === item.str) continue;

      const transform = item.transform;

      const point = viewport.convertToViewportPoint(transform[4], transform[5]);

      const x = point[0];
      const y = point[1];

      const fontHeight = Math.max(8, item.height * quality);

      const originalWidth = item.width * quality;

      // Zakrycie błędnego tekstu
      ctx.fillStyle = '#ffffff';

      ctx.fillRect(x - 1, y - fontHeight, originalWidth + 4, fontHeight + 3);

      // Odtworzenie poprawnego tekstu
      ctx.fillStyle = '#000000';
      ctx.textBaseline = 'alphabetic';
      ctx.font = fontHeight + 'px Arial';

      let fontSize = fontHeight;

      const measured = ctx.measureText(corrected).width;

      if (measured > originalWidth && originalWidth > 0) {
        fontSize = fontHeight * (originalWidth / measured);

        ctx.font = fontSize + 'px Arial';
      }

      ctx.fillText(corrected, x, y - fontHeight * 0.05);
    }

    // Zapis strony jako obrazu
    const image = await new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });

    if (!image) {
      throw new Error('Nie udało się wygenerować obrazu strony.');
    }

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
  }

  const result = await output.save();

  return new Blob([result], {
    type: 'application/pdf',
  });
}

processButton.addEventListener('click', async () => {
  const file = fileInput.files[0];

  if (!file) {
    setStatus('Najpierw wybierz PDF.');
    return;
  }

  try {
    const rules = JSON.parse(rulesInput.value);

    if (!rules || Array.isArray(rules) || typeof rules !== 'object') {
      throw new Error('Reguły muszą być obiektem JSON.');
    }

    const quality = Number(document.getElementById('quality').value);

    processButton.disabled = true;

    const result = await processPDF(file, rules, quality);

    const url = URL.createObjectURL(result);

    const link = document.createElement('a');

    link.href = url;
    link.download = file.name.replace(/\.pdf$/i, '') + '_POPRAWIONY.pdf';

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 60000);

    setStatus('Gotowe! Poprawiony PDF został zapisany.');
  } catch (error) {
    console.error(error);
    setStatus('Błąd: ' + error.message);
  } finally {
    processButton.disabled = false;
  }
});
