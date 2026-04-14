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
const ORDER_TYPES = ['CornerShop', 'Local', 'OT17578', 'OT17579', 'OT17580'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getChileDate() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + (-4 * 60) * 60000);
}

function getWeekLabel() {
  const d = getChileDate();
  return `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;
}

function safeName(str) {
  return str
    .replace(/Ñ/g,'N').replace(/ñ/g,'n')
    .replace(/é/g,'e').replace(/ó/g,'o').replace(/á/g,'a').replace(/í/g,'i').replace(/ú/g,'u')
    .replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
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

// ── SELECCIONAR OPCIÓN EN SEARCHSELECT ────────────────────────
// Oracle JET oj-searchselect: click input → escribir → esperar dropdown → click opción
async function selectSearchOption(page, inputId, optionText) {
  // Use attribute selector to avoid CSS.escape issues
  const input = page.locator(`[id="${inputId}"]`);
  await input.waitFor({ timeout: 8000 });

  // Click para abrir el dropdown
  await input.click();
  await sleep(800);

  // Limpiar y escribir el texto para filtrar
  await input.fill('');
  await input.type(optionText.substring(0, 4), { delay: 100 });
  await sleep(1500);

  // Buscar y clickear la opción en el dropdown
  const clicked = await page.evaluate((text) => {
    const opts = Array.from(document.querySelectorAll(
      '[role="option"], .oj-listbox-result-selectable, .oj-searchselect-option, [class*="oj-listview-item"]'
    ));
    const opt = opts.find(o =>
      o.innerText?.trim() === text ||
      o.getAttribute('aria-label') === text
    );
    if (opt) { opt.click(); return { clicked: true, text: opt.innerText?.trim() }; }

    // Fallback: buscar por aria-label visible
    const divs = Array.from(document.querySelectorAll('[aria-label]'));
    const d = divs.find(el =>
      el.getAttribute('aria-label') === text &&
      el.getBoundingClientRect().width > 0
    );
    if (d) { d.click(); return { clicked: true, byLabel: true }; }

    // Debug: mostrar opciones disponibles
    return { clicked: false, available: opts.map(o => o.innerText?.trim() || o.getAttribute('aria-label')).filter(Boolean).slice(0,10) };
  }, optionText);

  await sleep(500);
  return clicked;
}

// ── ABRIR MODAL DE PARÁMETROS ─────────────────────────────────
async function abrirParametros(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.oj-dialog-layer, .oj-component-overlay').forEach(el => {
      el.style.display = 'none';
    });
  });
  await sleep(500);

  const editBtn = page.locator('[aria-label="Editar parámetros"], [aria-label="Edit parameters"]').first();
  await editBtn.waitFor({ timeout: 10000 });
  await editBtn.evaluate(el => el.click());
  await sleep(2000);
}

// ── CONFIGURAR TIPOS DE ORDEN (solo primera vez) ──────────────
async function configurarTiposDeOrden(page) {
  console.log('⚙️  Configurando tipos de orden (excluir Good Meal)...');

  await abrirParametros(page);

  // Click en "Avanzado" de Tipos de orden
  // Es el 4to link "Avanzado" del modal
  await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a, button, span')).filter(el =>
      (el.innerText?.trim() === 'Avanzado' || el.innerText?.trim() === 'Advanced') &&
      el.getBoundingClientRect().width > 0
    );
    // El de Tipos de orden es el 4to (índice 3)
    // Orden: Fechas negocio, Ubicaciones, Centros venta, Tipos orden
    const target = links[3];
    if (target) target.click();
  });
  await sleep(2000);
  console.log('✅ Modal Tipos de orden abierto');

  // Hacer dialogs visibles
  await page.evaluate(() => {
    document.querySelectorAll('[id*="dialog"], [class*="dialog"], [role="dialog"]').forEach(d => {
      d.style.display = 'block'; d.style.visibility = 'visible'; d.style.opacity = '1';
      d.style.position = 'fixed'; d.style.top = '0'; d.style.left = '0';
      d.style.zIndex = '99999'; d.style.transform = 'none'; d.style.overflow = 'visible';
    });
  });
  await sleep(500);

  // Seleccionar cada tipo de orden en el modal avanzado
  // El modal avanzado tiene un oj-select-many o listbox
  // Primero ver qué hay disponible
  const availableTypes = await page.evaluate(() => {
    const allEls = Array.from(document.querySelectorAll('[aria-label], .oj-listbox-result-selectable, [role="option"], li'));
    return allEls
      .filter(el => el.getBoundingClientRect().width > 0)
      .map(el => ({ tag: el.tagName, label: el.getAttribute('aria-label'), text: el.innerText?.trim().substring(0,40) }))
      .filter(el => el.label || el.text)
      .slice(0, 20);
  });
  console.log('🔍 Elementos disponibles en modal:', JSON.stringify(availableTypes));

  for (const ot of ORDER_TYPES) {
    // Buscar el elemento con el nombre del tipo de orden y clickearlo
    const result = await page.evaluate((target) => {
      // Intentar por aria-label
      const byLabel = Array.from(document.querySelectorAll('[aria-label]'))
        .find(el => el.getAttribute('aria-label') === target && el.getBoundingClientRect().width > 0);
      if (byLabel) { byLabel.click(); return { clicked: true, method: 'aria-label' }; }

      // Intentar por texto exacto en li/div/span visibles
      const byText = Array.from(document.querySelectorAll('li, div, span, td'))
        .find(el => el.innerText?.trim() === target && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
      if (byText) { byText.click(); return { clicked: true, method: 'text', tag: byText.tagName }; }

      return { clicked: false };
    }, ot);
    console.log(`  📌 ${ot}:`, result);
    await sleep(800);
  }

  // Click en "Aplicar"
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const apply = btns.find(b => b.innerText?.trim() === 'Aplicar' || b.innerText?.trim() === 'Apply');
    if (apply) apply.click();
  });
  await sleep(2000);
  console.log('✅ Tipos de orden configurados');

  // Ejecutar para que el filtro quede aplicado
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const run = btns.find(b => b.innerText?.trim() === 'Ejecutar');
    if (run) run.click();
  });
  await page.waitForLoadState('networkidle');
  await sleep(4000);
}

// ── SELECCIONAR CENTRO Y EJECUTAR ─────────────────────────────
async function seleccionarCentroYEjecutar(page, centro) {
  console.log(`🏪 Centro: ${centro}`);

  await abrirParametros(page);

  // Usar el searchselect de Centros de venta: id="search_rvc_select|input"
  const result = await selectSearchOption(page, 'search_rvc_select|input', centro);
  console.log(`  RVC set:`, result);

  // Ejecutar
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const run = btns.find(b => b.innerText?.trim() === 'Ejecutar');
    if (run) run.click();
  });
  await page.waitForLoadState('networkidle');
  await sleep(5000);
  console.log(`  ✅ Ejecutado`);
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
  console.log(`  ✅ Guardado: ${fileName}`);
  return filePath;
}

// ── ENVÍO DE MAIL ─────────────────────────────────────────────
async function sendMail(files, weekLabel) {
  console.log('📧 Enviando mail...');
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: MAIL_FROM, pass: GMAIL_PASS },
  });
  await transporter.sendMail({
    from: `"Factory Nine · Reportes" <${MAIL_FROM}>`,
    to: MAIL_TO,
    subject: `Dayparts semana ${weekLabel} · ${files.length} archivos`,
    text: `Hola,\n\nAdjunto los reportes de dayparts de la semana del ${weekLabel}.\n\n${files.length} archivos adjuntos (consolidado + tiendas)\n\nFactory Nine`,
    attachments: files.map(f => ({ filename: f.name, path: f.filePath })),
  });
  console.log(`✅ Mail enviado con ${files.length} adjuntos`);
}

// ── MAIN ──────────────────────────────────────────────────────
async function run() {
  if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

  const weekLabel = getWeekLabel();
  console.log(`📅 Semana: ${weekLabel} · ${CENTROS.length} centros`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const downloadedFiles = [];

  try {
    await login(page);

    // Abrir reporte
    await page.goto(REPORT_URL, { waitUntil: 'networkidle' });
    await sleep(4000);
    console.log('✅ Reporte abierto');

    // Configurar tipos de orden UNA VEZ
    await configurarTiposDeOrden(page);

    // Iterar centros de venta
    for (const centro of CENTROS) {
      console.log(`\n━━━ ${centro} ━━━`);
      await seleccionarCentroYEjecutar(page, centro);
      const fileName = `dayparts_${safeName(centro)}_${weekLabel}.xlsx`;
      const filePath = await downloadExcel(page, fileName);
      downloadedFiles.push({ filePath, name: fileName });
    }

    await sendMail(downloadedFiles, weekLabel);

    for (const f of downloadedFiles) {
      try { if (fs.existsSync(f.filePath)) fs.unlinkSync(f.filePath); } catch(e) {}
    }

  } catch (err) {
    console.error('❌ Error:', err.message);
    await page.screenshot({ path: 'error-screenshot.png', fullPage: true });
    throw err;
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('❌ Script terminó con error:', err.message);
  process.exit(1);
});
