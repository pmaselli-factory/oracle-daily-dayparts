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
const ORDER_TYPES = ['Local', 'OT17578', 'OT17579', 'OT17580'];

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
  // Step 1: click input via JS to open dropdown (bypasses Oracle JET overlay)
  await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.focus();
    el.click();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, inputId);
  await sleep(1500);

  // Step 2: click the LI option in the lovDropdown
  const clicked = await page.evaluate((text) => {
    // The dropdown is lovDropdown_search_rvc_select
    const lis = Array.from(document.querySelectorAll('.oj-listview-item-element, li'))
      .filter(el => el.getBoundingClientRect().height > 0 && el.innerText?.trim() === text);
    if (lis.length > 0) {
      lis[0].click();
      return { clicked: true, method: 'oj-listview-item-element' };
    }
    // Fallback: any visible li with matching text
    const allLis = Array.from(document.querySelectorAll('li'))
      .filter(el => el.getBoundingClientRect().height > 0);
    const opt = allLis.find(el => el.innerText?.trim() === text);
    if (opt) { opt.click(); return { clicked: true, method: 'li-fallback' }; }
    return { clicked: false, available: allLis.map(el => el.innerText?.trim()).filter(Boolean).slice(0, 10) };
  }, optionText);

  await sleep(800);
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

  // Click en "Avanzado" de Tipos de orden — es el índice 6 (grandparent: 'Tipos de orden\nAvanzado')
  const advResult = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a, button, span')).filter(el =>
      el.innerText?.trim() === 'Avanzado' && el.getBoundingClientRect().width > 0
    );
    // Buscar por grandparent que contenga "Tipos de orden"
    const byContext = links.find(el => {
      const gp = el.parentElement?.parentElement?.innerText?.trim() || '';
      return gp.includes('Tipos de orden') || gp.includes('Order Type');
    });
    if (byContext) { byContext.click(); return { clicked: true, method: 'grandparent' }; }
    // Fallback: índice 6
    if (links[6]) { links[6].click(); return { clicked: true, method: 'index6' }; }
    return { clicked: false, total: links.length };
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
  // El oj-select-many tiene un ul.oj-select-choices que al clickearse abre el dropdown
  // El dropdown es oj-listbox-drop con un oj-listbox-input para buscar
  // y los resultados son LI con aria-label
  for (const ot of ORDER_TYPES) {
    // 1. Click en el ul.oj-select-choices para abrir el dropdown
    await page.evaluate(() => {
      const ul = document.querySelector('#order_type_advance_selectMany_report-filter-order-type .oj-select-choices');
      if (ul) {
        ul.click();
        ul.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        ul.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }
    });
    await sleep(1200);

    // 2. Escribir en el oj-listbox-input para filtrar
    await page.evaluate((target) => {
      const input = document.querySelector('.oj-listbox-drop:not([style*="display: none"]) .oj-listbox-input, .oj-listbox-input');
      if (!input) return;
      input.focus();
      input.value = '';
      for (const ch of target) {
        input.value += ch;
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ch }));
        input.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: ch }));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ch }));
      }
    }, ot);
    await sleep(1200);

    // 3. Clickear la opción filtrada
    const result = await page.evaluate((target) => {
      // Buscar en el dropdown abierto por aria-label
      const byLabel = Array.from(document.querySelectorAll('[aria-label]'))
        .find(el => el.getAttribute('aria-label') === target && el.getBoundingClientRect().width > 0);
      if (byLabel) {
        const li = byLabel.closest('li') || byLabel;
        li.click();
        byLabel.click();
        return { clicked: true, method: 'aria-label' };
      }
      // Buscar LI visible con texto exacto
      const lis = Array.from(document.querySelectorAll('li'))
        .filter(el => el.getBoundingClientRect().height > 0 && el.innerText?.trim() === target);
      if (lis.length > 0) { lis[0].click(); return { clicked: true, method: 'li-text' }; }
      // Debug
      const available = Array.from(document.querySelectorAll('li'))
        .filter(el => el.getBoundingClientRect().height > 0)
        .map(el => el.innerText?.trim()).filter(Boolean).slice(0, 10);
      return { clicked: false, available };
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

// ── SELECCIONAR TIPOS DE ORDEN EN PARAMETROS ─────────────────
// Solo se llama UNA VEZ — con parámetros ya abiertos
async function seleccionarTiposDeOrden(page) {
  const VALID_ORDER_TYPES = new Set(['Local', 'OT17578', 'OT17579', 'OT17580']);

  // 1. Click en "Avanzado" de Tipos de orden
  const advCoords = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a, button, span'))
      .filter(el => el.innerText?.trim() === 'Avanzado' && el.getBoundingClientRect().width > 0);
    const byContext = links.find(el => {
      const gp = el.parentElement?.parentElement?.innerText?.trim() || '';
      return gp.includes('Tipos de orden') || gp.includes('Order Type');
    });
    const target = byContext || links[6];
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  });
  if (!advCoords) { console.log('  ⚠️ No encontró Avanzado tipos orden'); return; }
  await page.mouse.click(advCoords.x, advCoords.y);
  await sleep(2000);

  // 2. Click en ul.oj-select-choices para abrir el dropdown
  const ulCoords = await page.evaluate(() => {
    const ul = document.querySelector('#order_type_advance_selectMany_report-filter-order-type .oj-select-choices');
    if (!ul) return null;
    const r = ul.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  });
  if (!ulCoords) { console.log('  ⚠️ No encontró oj-select-choices'); return; }
  await page.mouse.click(ulCoords.x, ulCoords.y);
  await sleep(1500);

  // 3. Abrir dropdown y mapear TODAS las opciones de una vez
  // Luego clickear las que necesitamos (sin cerrar/reabrir entre cada una)
  
  // Abrir dropdown y esperar a que se renderice
  await page.mouse.click(ulCoords.x, ulCoords.y);
  await sleep(2000);

  // Verificar que el dropdown está abierto
  const dropdownOpen = await page.evaluate(() => {
    const d = document.querySelector('.oj-listbox-drop');
    return d ? d.style.display !== 'none' : false;
  });
  console.log(`  🔍 Dropdown abierto: ${dropdownOpen}`);

  // Log todos los LI visibles para debug
  const allLis = await page.evaluate(() => {
    const dropdown = document.querySelector('.oj-listbox-drop');
    if (!dropdown) return [];
    return Array.from(dropdown.querySelectorAll('li'))
      .filter(el => el.getBoundingClientRect().height > 0)
      .map(el => ({ text: el.innerText?.trim().substring(0,20), h: Math.round(el.getBoundingClientRect().height) }))
      .slice(0, 8);
  });
  console.log(`  🔍 LIs visibles:`, JSON.stringify(allLis));

  // Buscar Local
  const localCoords = await page.evaluate(() => {
    const dropdown = document.querySelector('.oj-listbox-drop');
    if (!dropdown) return null;
    const lis = Array.from(dropdown.querySelectorAll('li'));
    const li = lis.find(el => el.innerText?.trim() === 'Local' && el.getBoundingClientRect().height > 0);
    if (!li) return null;
    const r = li.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  });

  if (localCoords) {
    await page.mouse.click(localCoords.x, localCoords.y);
    console.log(`  📌 Local: (${localCoords.x}, ${localCoords.y})`);
    await sleep(800);
  } else {
    console.log(`  ⚠️ No encontró Local`);
  }

  // Reabrir dropdown y hacer scroll al fondo para OT*
  for (const ot of ['OT17578', 'OT17579', 'OT17580']) {
    await page.mouse.click(ulCoords.x, ulCoords.y);
    await sleep(800);

    // Scroll al fondo
    await page.evaluate(() => {
      const results = document.querySelector('.oj-listbox-drop .oj-listbox-results');
      if (results) results.scrollTop = 99999;
    });
    await sleep(500);

    // Buscar y clickear la última coincidencia visible
    const optCoords = await page.evaluate((target) => {
      const dropdown = document.querySelector('.oj-listbox-drop');
      if (!dropdown) return null;
      const lis = Array.from(dropdown.querySelectorAll('li'))
        .filter(el => el.innerText?.trim() === target && el.getBoundingClientRect().height > 20);
      if (lis.length === 0) return null;
      const opt = lis[lis.length - 1];
      const r = opt.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), count: lis.length };
    }, ot);

    if (optCoords) {
      await page.mouse.click(optCoords.x, optCoords.y);
      console.log(`  📌 ${ot}: (${optCoords.x}, ${optCoords.y}) [${optCoords.count}]`);
      await sleep(800);
    } else {
      console.log(`  ⚠️ No encontró ${ot}`);
    }
  }

  // 4. Cerrar dropdown presionando Escape
  await page.keyboard.press('Escape');
  await sleep(500);

  // 5. Click "Aplicar"
  const applyCoords = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const apply = btns.find(b => b.innerText?.trim() === 'Aplicar' || b.innerText?.trim() === 'Apply');
    if (!apply) return null;
    const r = apply.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  });
  if (applyCoords) {
    await page.mouse.click(applyCoords.x, applyCoords.y);
    await sleep(1500);
    console.log('  ✅ Tipos de orden aplicados');
  }
}

// ── SELECCIONAR CENTRO Y EJECUTAR ─────────────────────────────
async function seleccionarCentroYEjecutar(page, centro, configurarOrden) {
  console.log(`🏪 Centro: ${centro}`);

  await abrirParametros(page);

  // 1. Seleccionar centro de venta
  const result = await selectSearchOption(page, 'search_rvc_select|input', centro);
  console.log(`  RVC set:`, result);

  // 2. Configurar tipos de orden solo la primera vez
  if (configurarOrden) {
    await seleccionarTiposDeOrden(page);
  }

  // 3. Ejecutar
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

    // Iterar centros de venta (tipos de orden se configuran en cada iteración)
    for (let i = 0; i < CENTROS.length; i++) {
      const centro = CENTROS[i];
      console.log(`\n━━━ ${centro} ━━━`);
      await seleccionarCentroYEjecutar(page, centro, i === 0); // tipos de orden solo en primera iteración
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
