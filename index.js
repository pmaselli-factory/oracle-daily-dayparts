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
  // Click via JS to bypass Oracle JET overlay
  const opened = await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return { found: false };
    el.click();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { found: true };
  }, inputId);
  await sleep(800);

  // Type to filter using keyboard events via JS
  await page.evaluate(({ id, text }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.focus();
    el.value = text.substring(0, 4);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: text[0] }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: text[0] }));
  }, { id: inputId, text: optionText });
  await sleep(2000);

  // Find and click the option
  const clicked = await page.evaluate((text) => {
    // Look in lovDropdown which is the Oracle JET LOV dropdown
    const lovDropdowns = document.querySelectorAll('[id*="lovDropdown"], [class*="oj-listview"], [class*="oj-select-results"]');
    for (const dropdown of lovDropdowns) {
      const opts = Array.from(dropdown.querySelectorAll('li, div, [role="option"]'));
      const opt = opts.find(o => o.innerText?.trim() === text);
      if (opt) { opt.click(); return { clicked: true, method: 'lovDropdown' }; }
    }
    // Fallback: search all visible options
    const allOpts = Array.from(document.querySelectorAll('[role="option"], li'))
      .filter(el => el.getBoundingClientRect().height > 0);
    const opt = allOpts.find(o => o.innerText?.trim() === text);
    if (opt) { opt.click(); return { clicked: true, method: 'fallback', text: opt.innerText?.trim() }; }
    return { clicked: false, available: allOpts.map(o => o.innerText?.trim()).filter(Boolean).slice(0,8) };
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
  // Buscar el link "Avanzado" que está cerca del label "Tipos de orden"
  const advResult = await page.evaluate(() => {
    // Estrategia: buscar el elemento que contiene "Tipos de orden" y luego
    // encontrar el link "Avanzado" más cercano
    const allEls = Array.from(document.querySelectorAll('*'));
    const tiposOrdenLabel = allEls.find(el =>
      el.children.length === 0 &&
      (el.innerText?.trim() === 'Tipos de orden' || el.innerText?.trim() === 'Order Type')
    );

    if (tiposOrdenLabel) {
      // Buscar el Avanzado más cercano después del label
      let current = tiposOrdenLabel;
      for (let i = 0; i < 10; i++) {
        current = current.nextElementSibling || current.parentElement?.nextElementSibling;
        if (!current) break;
        const advLink = current.querySelector?.('a, button, span') ||
          (current.innerText?.trim() === 'Avanzado' ? current : null);
        const links = Array.from(current.querySelectorAll?.('a, span, button') || [])
          .filter(l => l.innerText?.trim() === 'Avanzado');
        if (links.length > 0) { links[0].click(); return { clicked: true, method: 'sibling' }; }
      }
    }

    // Fallback: buscar todos los Avanzado y loggear su contexto para debug
    const links = Array.from(document.querySelectorAll('a, button, span')).filter(el =>
      el.innerText?.trim() === 'Avanzado' && el.getBoundingClientRect().width > 0
    );
    const contexts = links.map((l, i) => {
      const parent = l.closest('[class*="param"], [class*="filter"], div');
      return { i, parentText: parent?.innerText?.trim().substring(0, 60) };
    });
    // Click el que tiene "Tipos de orden" en su contexto
    const tiposIdx = contexts.findIndex(c => c.parentText?.includes('Tipos de orden') || c.parentText?.includes('Order Type'));
    if (tiposIdx >= 0) { links[tiposIdx].click(); return { clicked: true, method: 'context', idx: tiposIdx }; }
    // Último recurso: el índice 3 (0-based)
    if (links[3]) { links[3].click(); return { clicked: true, method: 'index3', total: links.length, contexts }; }
    return { clicked: false, contexts };
  });
  console.log('🔍 Click Avanzado tipos orden:', JSON.stringify(advResult));
  await sleep(3000);

  // Hacer el segundo modal (de tipos de orden) visible
  await page.evaluate(() => {
    document.querySelectorAll('[id*="dialog"], [class*="dialog"], [role="dialog"]').forEach(d => {
      d.style.display = 'block'; d.style.visibility = 'visible'; d.style.opacity = '1';
      d.style.position = 'fixed'; d.style.top = '0'; d.style.left = '0';
      d.style.zIndex = '99999'; d.style.transform = 'none'; d.style.overflow = 'visible';
    });
  });
  await sleep(500);

  // Ver qué hay en el modal de tipos de orden ahora
  const modalContent = await page.evaluate(() => {
    // Buscar el dropdown/listbox del modal de tipos de orden
    // Oracle usa oj-listbox con class oj-listbox-result-label con aria-label
    const items = Array.from(document.querySelectorAll('[id*="oj-listbox-result-label"]'));
    if (items.length > 0) {
      return { type: 'listbox', items: items.map(el => ({ id: el.id, label: el.getAttribute('aria-label'), text: el.innerText?.trim() })) };
    }
    // Si no hay listbox abierto, buscar el input que abre el dropdown de tipos de orden
    const inputs = Array.from(document.querySelectorAll('input[role="combobox"], .oj-listbox-input'))
      .filter(el => el.getBoundingClientRect().width > 0);
    return { type: 'inputs', items: inputs.map(el => ({ id: el.id, class: el.className.substring(0,60) })) };
  });
  console.log('🔍 Contenido modal tipos orden:', JSON.stringify(modalContent));

  // El modal de tipos de orden tiene un searchselect — necesitamos abrirlo y seleccionar
  // Usamos el mismo patrón del otro reporte: abrir dropdown y clickear por aria-label
  // Log what's visible in the order type modal now
  const modalDebug = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[role="combobox"]'))
      .filter(el => el.getBoundingClientRect().width > 0)
      .map(el => ({ id: el.id, w: Math.round(el.getBoundingClientRect().width) }));
    const visible = Array.from(document.querySelectorAll('[aria-label]'))
      .filter(el => el.getBoundingClientRect().width > 0)
      .map(el => el.getAttribute('aria-label')).filter(Boolean).slice(0, 15);
    return { inputs, visible };
  });
  console.log('🔍 Modal estado actual:', JSON.stringify(modalDebug));

  for (const ot of ORDER_TYPES) {
    // El modal de tipos de orden avanzado tiene un oj-listbox con las opciones
    // Primero hacer click en el input del modal para abrir el dropdown
    await page.evaluate(() => {
      // Buscar el input más ancho que no sea el de la página principal
      const inputs = Array.from(document.querySelectorAll('input[role="combobox"]'))
        .filter(el => el.getBoundingClientRect().width > 150);
      // Ordenar por z-index / posición en pantalla — el del modal estará al frente
      const last = inputs[inputs.length - 1];
      if (last) last.click();
    });
    await sleep(1000);

    // Clickear la opción en el dropdown abierto
    const result = await page.evaluate((target) => {
      // Buscar en el listbox de Oracle JET por aria-label
      const byLabel = Array.from(document.querySelectorAll('[aria-label]'))
        .find(el => el.getAttribute('aria-label') === target && el.getBoundingClientRect().width > 0);
      if (byLabel) { byLabel.click(); return { clicked: true, method: 'aria-label' }; }

      // Buscar por texto exacto
      const byText = Array.from(document.querySelectorAll('li, div'))
        .find(el => el.innerText?.trim() === target && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
      if (byText) { byText.click(); return { clicked: true, method: 'text', tag: byText.tagName }; }

      // Debug: qué hay disponible
      const available = Array.from(document.querySelectorAll('[aria-label]'))
        .filter(el => el.getBoundingClientRect().width > 0)
        .map(el => el.getAttribute('aria-label')).filter(Boolean);
      return { clicked: false, available: available.slice(0, 10) };
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
