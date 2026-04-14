const { chromium } = require('playwright');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

// ── CONFIG ────────────────────────────────────────────────────
const ORACLE_URL   = 'https://ors-idm.mtu3.oraclerestaurants.com/oidc-ui/';
const REPORT_URL   = 'https://simphony-home.mtu3.oraclerestaurants.com/portal/?ojr=reports%2FmyReports%2F315';
const ORACLE_USER  = process.env.ORACLE_USER;
const ORACLE_PASS  = process.env.ORACLE_PASSWORD;
const ORACLE_ENT   = process.env.ORACLE_ENTERPRISE;
const GMAIL_PASS   = process.env.GMAIL_APP_PASSWORD;
const MAIL_FROM    = 'pmaselli@factorynine.cl';
const MAIL_TO      = 'pmaselli@factorynine.cl';
const DOWNLOAD_DIR = path.join(__dirname, 'downloads_dayparts');

// Centros de venta — "Todos" primero, luego cada tienda
const CENTROS = [
  'Todos',
  'Lc Chicureo',
  'Lc La Florida',
  'Lc La Reina',
  'Lc Lastarria',
  'Lc Los Militares',
  'Lc Luis Pasteur',
  'Lc Maipu',
  'Lc Ñuñoa',
  'Lc Peñalolen',
  'Lc Pocuro',
  'Lc Providencia',
  'Lc San Miguel',
  'Lc Tabancura',
];

// Tipos de orden a seleccionar (todos menos Good Meal)
const ORDER_TYPES_TO_SELECT = [
  'CornerShop',
  'Local',
  'OT17578',
  'OT17579',
  'OT17580',
];

// ── HELPERS ───────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getChileDate() {
  const now = new Date();
  const chileOffset = -4 * 60;
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + chileOffset * 60000);
}

function getWeekLabel() {
  const today = getChileDate();
  const dd = String(today.getDate()).padStart(2, '0');
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const yyyy = today.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// ── LOGIN ─────────────────────────────────────────────────────
async function login(page) {
  console.log('🔐 Navegando a Oracle...');
  await page.goto(ORACLE_URL, { waitUntil: 'networkidle' });
  await sleep(3000);

  const allInputs = page.locator('input');
  await allInputs.nth(0).fill(ORACLE_USER);
  await allInputs.nth(1).fill(ORACLE_ENT);
  await allInputs.nth(2).fill(ORACLE_PASS);

  await page.locator('button:has-text("Sign In"), input[type="submit"]').first().click();
  await page.waitForLoadState('networkidle');
  await sleep(2000);
  console.log('✅ Login completado');
}

// ── ABRIR REPORTE ─────────────────────────────────────────────
async function openReport(page) {
  console.log('📂 Abriendo reporte dayparts...');
  await page.goto(REPORT_URL, { waitUntil: 'networkidle' });
  await sleep(4000);
  console.log('✅ Reporte abierto');
}

// ── CONFIGURAR TIPOS DE ORDEN (solo la primera vez) ───────────
async function configurarTiposDeOrden(page) {
  console.log('⚙️  Configurando tipos de orden...');

  // Cerrar overlays
  await page.evaluate(() => {
    document.querySelectorAll('.oj-dialog-layer, .oj-component-overlay').forEach(el => {
      el.style.display = 'none';
    });
  });
  await sleep(500);

  // Click en "Editar parámetros"
  const editBtn = page.locator('[aria-label="Editar parámetros"], [aria-label="Edit parameters"]').first();
  await editBtn.waitFor({ timeout: 10000 });
  await editBtn.evaluate(el => el.click());
  await sleep(2000);
  console.log('✅ Parámetros abiertos');

  // Click en "Avanzado" de Tipos de orden (el 4to link Avanzado)
  await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const advLinks = links.filter(l =>
      l.innerText?.trim() === 'Avanzado' || l.innerText?.trim() === 'Advanced'
    );
    // El de Tipos de orden es el último
    const target = advLinks[advLinks.length - 1];
    if (target) {
      target.removeAttribute('hidden');
      target.style.display = '';
      target.style.visibility = 'visible';
      target.click();
    }
  });
  await sleep(2000);
  console.log('✅ Modal Tipos de orden abierto');

  // Hacer dialogs visibles
  await page.evaluate(() => {
    document.querySelectorAll('[id*="dialog"], [class*="dialog"], [role="dialog"]').forEach(d => {
      d.style.display = 'block';
      d.style.visibility = 'visible';
      d.style.opacity = '1';
      d.style.position = 'fixed';
      d.style.top = '0';
      d.style.left = '0';
      d.style.zIndex = '99999';
      d.style.transform = 'none';
      d.style.overflow = 'visible';
    });
  });
  await sleep(500);

  // Seleccionar cada tipo de orden uno por uno
  for (const orderType of ORDER_TYPES_TO_SELECT) {
    // Abrir el desplegable
    const dropdownOpened = await page.evaluate(() => {
      // Buscar el botón/input que abre el desplegable de tipos de orden
      const triggers = Array.from(document.querySelectorAll('.oj-listbox-choice, [aria-label*="Seleccionar"], .oj-select-choice'));
      const trigger = triggers.find(t => {
        const rect = t.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (trigger) { trigger.click(); return true; }
      // Fallback: buscar por placeholder
      const inputs = Array.from(document.querySelectorAll('input[placeholder], .oj-listbox-input'));
      const inp = inputs.find(i => i.getBoundingClientRect().width > 0);
      if (inp) { inp.click(); return true; }
      return false;
    });
    await sleep(1000);

    // Clickear la opción correcta por aria-label
    const clicked = await page.evaluate((target) => {
      const divs = Array.from(document.querySelectorAll('[aria-label]'));
      const opt = divs.find(d => d.getAttribute('aria-label') === target && d.getBoundingClientRect().width > 0);
      if (opt) {
        opt.click();
        return { clicked: true, label: opt.getAttribute('aria-label') };
      }
      // Fallback: buscar por texto
      const lis = Array.from(document.querySelectorAll('.oj-listbox-result-selectable'));
      const li = lis.find(l => l.innerText?.trim() === target);
      if (li) { li.click(); return { clicked: true, text: li.innerText?.trim() }; }
      return { clicked: false, target };
    }, orderType);
    console.log(`  📌 Seleccionado: ${orderType} →`, clicked);
    await sleep(800);
  }

  // Click en "Aplicar"
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const apply = btns.find(b => b.innerText?.trim() === 'Aplicar' || b.innerText?.trim() === 'Apply');
    if (apply) apply.click();
  });
  await sleep(2000);
  console.log('✅ Tipos de orden configurados y aplicados');
}

// ── SELECCIONAR CENTRO DE VENTA ───────────────────────────────
async function seleccionarCentro(page, centro) {
  console.log(`🏪 Seleccionando centro: ${centro}`);

  // Cerrar overlays
  await page.evaluate(() => {
    document.querySelectorAll('.oj-dialog-layer, .oj-component-overlay').forEach(el => {
      el.style.display = 'none';
    });
  });
  await sleep(500);

  // Click en "Editar parámetros"
  const editBtn = page.locator('[aria-label="Editar parámetros"], [aria-label="Edit parameters"]').first();
  await editBtn.waitFor({ timeout: 10000 });
  await editBtn.evaluate(el => el.click());
  await sleep(2000);

  // Seleccionar el centro de venta en el dropdown
  const centroSet = await page.evaluate((targetCentro) => {
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const opts = Array.from(sel.options).map(o => o.text.trim());
      if (opts.some(o => o === targetCentro || o.includes('Chicureo') || o.includes('Militares'))) {
        const opt = Array.from(sel.options).find(o => o.text.trim() === targetCentro);
        if (opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          return { found: true, value: opt.value, text: opt.text };
        }
      }
    }
    return { found: false };
  }, centro);
  console.log(`  Centro set:`, centroSet);
  await sleep(1000);

  // Click en "Ejecutar"
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const run = btns.find(b =>
      b.innerText?.trim() === 'Ejecutar' ||
      b.innerText?.trim() === 'Execute' ||
      b.innerText?.trim() === 'Run'
    );
    if (run) run.click();
  });
  await page.waitForLoadState('networkidle');
  await sleep(5000);
  console.log(`✅ Reporte ejecutado para: ${centro}`);
}

// ── DESCARGAR EXCEL ───────────────────────────────────────────
async function downloadExcel(page, fileName) {
  console.log(`⬇️  Descargando ${fileName}...`);

  const downloadBtn = page.locator('[title="Descargar"], [title="Download"]').first();
  await downloadBtn.waitFor({ timeout: 15000 });
  await downloadBtn.evaluate(el => {
    const inner = el.querySelector('button') || el.querySelector('a') || el;
    inner.click();
  });
  await sleep(1500);

  const excelOption = page.locator('[role="menuitem"]:has-text("Excel"), li:has-text("Excel"), a:has-text("Excel")').first();
  await excelOption.waitFor({ timeout: 10000 });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    excelOption.evaluate(el => el.click()),
  ]);

  const filePath = path.join(DOWNLOAD_DIR, fileName);
  await download.saveAs(filePath);
  console.log(`✅ Guardado: ${fileName}`);
  return filePath;
}

// ── ENVÍO DE MAIL ─────────────────────────────────────────────
async function sendMail(files, weekLabel) {
  console.log('📧 Enviando mail...');

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: MAIL_FROM, pass: GMAIL_PASS },
  });

  await transporter.sendMail({
    from: `"Factory Nine · Reportes" <${MAIL_FROM}>`,
    to: MAIL_TO,
    subject: `Dayparts semana ${weekLabel} · ${files.length} reportes`,
    text: `Hola,\n\nAdjunto los reportes de "Cantidad de artículos de menú vendida por día hábil" correspondientes a la semana del ${weekLabel}.\n\n• ${files.length} archivos adjuntos (consolidado + ${files.length - 1} tiendas)\n\nEste reporte se genera automáticamente todos los domingos.\n\nFactory Nine`,
    attachments: files.map(({ filePath, name }) => ({
      filename: name,
      path: filePath,
    })),
  });

  console.log(`✅ Mail enviado con ${files.length} adjuntos`);
}

// ── MAIN ──────────────────────────────────────────────────────
async function run() {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

  const weekLabel = getWeekLabel();
  console.log(`📅 Semana: ${weekLabel}`);
  console.log(`🏪 Centros a procesar: ${CENTROS.length}`);

  console.log('🚀 Iniciando browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const downloadedFiles = [];

  try {
    await login(page);
    await openReport(page);

    // Configurar tipos de orden UNA SOLA VEZ (excluir Good Meal)
    await configurarTiposDeOrden(page);

    // Descargar un reporte por cada centro de venta
    for (const centro of CENTROS) {
      console.log(`\n━━━ ${centro} ━━━`);

      await seleccionarCentro(page, centro);

      const safeName = centro.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
      const fileName = `dayparts_${safeName}_${weekLabel}.xlsx`;
      const filePath = await downloadExcel(page, fileName);
      downloadedFiles.push({ filePath, name: fileName });
    }

    // Enviar todo por mail
    await sendMail(downloadedFiles, weekLabel);

    // Limpiar archivos temporales
    for (const f of downloadedFiles) {
      try { if (fs.existsSync(f.filePath)) fs.unlinkSync(f.filePath); } catch(e) {}
    }

  } catch (err) {
    console.error('❌ Error:', err.message);
    await page.screenshot({ path: 'error-screenshot.png', fullPage: true });
    console.log('📸 Screenshot guardado');
    throw err;
  } finally {
    await browser.close();
  }
}

// ── RUN ───────────────────────────────────────────────────────
run().catch(err => {
  console.error('❌ Script terminó con error:', err.message);
  process.exit(1);
});
