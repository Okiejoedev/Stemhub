(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  if (!window.THREE) { $('loading').textContent = 'The 3D library could not load. Check your connection and reload the page.'; return; }
  const hasPdf = !!(window.pdfjsLib && window.pdfjsLib.getDocument);
  if (hasPdf) { try { pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js'; } catch (e) {} }

  // ================= State =================
  const cap = { checked: false };
  const S = { mode: null, role: 'student', course: COURSES[0], code: null, cls: null, unsubs: [], hand: false, handAt: 0, act: '', log: [], sim: null, lastInput: Date.now(), attendTimer: 0, lecturerId: null };
  const liveOK = () => !!(window.BE && BE.configured && BE.signedIn);
  const isTeacherView = () => S.mode === 'sim' || (S.mode === 'live' && S.role === 'teacher');
  const canControlBoard = () => S.mode !== 'live' || S.role === 'teacher';

  // ================= Small UI helpers =================
  let toastTimer = 0;
  function toast(msg, ms) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3500); }
  function logMine(text) {
    S.log.unshift({ t: new Date(), text }); if (S.log.length > 40) S.log.pop(); scheduleMonitor();
  }
  function setAct(text) { S.act = text; logMine(text); pub({ act: text }); }
  const fmtTime = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function ago(ms) { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return 'just now'; const m = Math.round(s / 60); return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; }

  // ================= 3D engine =================
  const stage = $('stage');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  stage.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1B2630');
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 200);
  camera.rotation.order = 'YXZ';
  scene.add(new THREE.HemisphereLight(0xFFF6E8, 0x40372E, 0.85));
  const sun = new THREE.DirectionalLight(0xFFFFFF, 0.55); sun.position.set(10, 20, 12); scene.add(sun);
  let world = new THREE.Group(); scene.add(world);
  const avatarsGroup = new THREE.Group(); scene.add(avatarsGroup);
  const W = { clickables: [], boardTex: null, wbTex: null, model: null, modelLabels: [], labelsOn: false, packet: null, packetT: -1, spin: false };

  const ROOMW = 16, DEPTH = 14, HGT = 4, DOOR = 1.4, DOORH = 2.6;
  const mat = (c, o) => new THREE.MeshLambertMaterial(Object.assign({ color: c }, o || {}));
  function box(w, h, d, color, x, y, z, parent) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), typeof color === 'object' ? color : mat(color));
    m.position.set(x, y, z); (parent || world).add(m); return m;
  }
  function cyl(rt, rb, h, color, x, y, z, seg, parent) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 20), typeof color === 'object' ? color : mat(color));
    m.position.set(x, y, z); (parent || world).add(m); return m;
  }
  function sph(r, color, x, y, z, parent) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), typeof color === 'object' ? color : mat(color));
    m.position.set(x, y, z); (parent || world).add(m); return m;
  }
  function stick(a, b, r, color, parent) {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    const len = va.distanceTo(vb);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), typeof color === 'object' ? color : mat(color));
    m.position.copy(va).add(vb).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
    (parent || world).add(m); return m;
  }
  function canvasTex(w, h, draw) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); if (draw) draw(g, w, h);
    const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
    return { canvas: c, ctx: g, tex: t };
  }
  function fitFont(g, text, maxW, size, weight, family) {
    let fs = size; do { g.font = `${weight} ${fs}px ${family}`; fs -= 2; } while (g.measureText(text).width > maxW && fs > 14);
  }
  function wallText(text, x, y, z, w, opts) {
    opts = opts || {};
    const ct = canvasTex(1024, 192, (g, Wd, H) => {
      g.fillStyle = opts.bg || '#22303A'; g.fillRect(0, 0, Wd, H);
      g.fillStyle = opts.fg || '#F4B740';
      fitFont(g, text, Wd - 60, 92, 700, '"Bricolage Grotesque", "Segoe UI", sans-serif');
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, Wd / 2, H / 2 + 4);
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 192 / 1024), new THREE.MeshBasicMaterial({ map: ct.tex }));
    m.position.set(x, y, z); world.add(m); return m;
  }
  function makeLabel(text, scale, parent, bg) {
    const ct = canvasTex(512, 128, (g, Wd, H) => {
      g.fillStyle = bg || 'rgba(14,20,26,0.85)';
      const r = 40; g.beginPath(); g.moveTo(r, 8); g.arcTo(Wd - 8, 8, Wd - 8, H - 8, r); g.arcTo(Wd - 8, H - 8, 8, H - 8, r); g.arcTo(8, H - 8, 8, 8, r); g.arcTo(8, 8, Wd - 8, 8, r); g.fill();
      g.fillStyle = '#FFFFFF'; fitFont(g, text, Wd - 50, 50, 700, '"Atkinson Hyperlegible", "Segoe UI", sans-serif');
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, Wd / 2, H / 2 + 2);
    });
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: ct.tex, depthTest: false }));
    s.scale.set((scale || 1) * 1.6, (scale || 1) * 0.4, 1); s.renderOrder = 10; (parent || world).add(s); return s;
  }
  function disposeTree(obj) {
    obj.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of ms) { if (m.map) m.map.dispose(); m.dispose(); }
    });
  }

  // ---------- Board canvas (lecture hall) ----------
  const boardCanvas = document.createElement('canvas'); boardCanvas.width = 1280; boardCanvas.height = 720;
  const bctx = boardCanvas.getContext('2d');
  const B = { kind: 'course', page: 0, pages: 4, name: 'Course slides', pdf: null, images: [], key: 'course', loadingKey: null, renderToken: 0, shared: false };

  function drawCourseSlide(g, course, idx) {
    const Wd = 1280, H = 720, s = course.slides[idx];
    g.fillStyle = '#FBFAF6'; g.fillRect(0, 0, Wd, H);
    g.fillStyle = course.accent; g.fillRect(0, 0, Wd, 20);
    g.fillStyle = '#7A8A94'; g.font = '700 26px "Atkinson Hyperlegible", sans-serif'; g.textBaseline = 'top'; g.fillText(`${course.code} · ${course.title}`, 70, 60);
    g.fillStyle = '#16232D'; fitFont(g, s.h, 760, 64, 700, '"Bricolage Grotesque", "Segoe UI", sans-serif'); g.fillText(s.h, 70, 110);
    g.font = '400 36px "Atkinson Hyperlegible", "Segoe UI", sans-serif'; g.fillStyle = '#33444F';
    s.l.forEach((t, i) => { g.fillStyle = course.accent; g.beginPath(); g.arc(84, 262 + i * 76 + 20, 8, 0, Math.PI * 2); g.fill(); g.fillStyle = '#33444F'; wrapText(g, t, 108, 262 + i * 76, 700, 40); });
    drawGlyph(g, course, 1040, 400);
  }
  function wrapText(g, text, x, y, maxW, lh) {
    const words = text.split(' '); let line = '', yy = y;
    for (const w of words) { const test = line ? line + ' ' + w : w; if (g.measureText(test).width > maxW && line) { g.fillText(line, x, yy); line = w; yy += lh; } else line = test; }
    g.fillText(line, x, yy);
  }
  function drawGlyph(g, course, cx, cy) {
    g.save(); g.lineWidth = 6;
    if (course.id === 'geo') {
      g.fillStyle = '#2F8FCF'; g.fillRect(cx - 170, cy + 120, 340, 60);
      g.fillStyle = '#6AA84F'; g.beginPath(); g.moveTo(cx - 170, cy + 120); g.lineTo(cx - 60, cy + 30); g.lineTo(cx + 40, cy + 120); g.fill();
      g.fillStyle = '#F4B740'; g.beginPath(); g.arc(cx + 120, cy - 120, 40, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#C9D3DA'; for (const [x, y, r] of [[-40, -90, 40], [0, -104, 48], [46, -86, 36]]) { g.beginPath(); g.arc(cx + x, cy + y, r, 0, Math.PI * 2); g.fill(); }
      g.strokeStyle = '#2F8FCF'; g.setLineDash([10, 12]); for (let k = 0; k < 4; k++) { g.beginPath(); g.moveTo(cx - 40 + k * 26, cy - 50); g.lineTo(cx - 56 + k * 26, cy + 40); g.stroke(); } g.setLineDash([]);
    } else if (course.id === 'chm') {
      const at = (x, y, r, c) => { g.fillStyle = c; g.beginPath(); g.arc(cx + x, cy + y, r, 0, Math.PI * 2); g.fill(); };
      g.strokeStyle = '#9AA3A9'; g.beginPath(); g.moveTo(cx - 70, cy + 60); g.lineTo(cx, cy); g.lineTo(cx + 70, cy + 60); g.stroke();
      at(0, 0, 54, '#D9463E'); at(-70, 60, 34, '#D8DDE0'); at(70, 60, 34, '#D8DDE0');
      g.fillStyle = '#16232D'; g.font = '700 28px "Atkinson Hyperlegible", sans-serif'; g.textAlign = 'center'; g.fillText('104.5°', cx, cy + 110);
    } else if (course.id === 'bio') {
      g.fillStyle = 'rgba(232,140,160,0.35)'; g.strokeStyle = '#C96A80'; g.beginPath(); g.ellipse(cx, cy, 180, 140, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#7B5EA7'; g.beginPath(); g.arc(cx + 20, cy, 50, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#E8913A'; for (const [x, y, a] of [[-100, -50, .4], [-80, 70, -.3], [110, 60, .8]]) { g.beginPath(); g.ellipse(cx + x, cy + y, 34, 14, a, 0, Math.PI * 2); g.fill(); }
    } else {
      const pts = [[-150, -90], [150, -90], [-170, 80], [170, 80], [0, 150]];
      g.strokeStyle = '#9AA3A9'; for (const [x, y] of pts) { g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + x, cy + y); g.stroke(); }
      g.fillStyle = '#6B4FBB'; g.fillRect(cx - 50, cy - 24, 100, 48);
      g.fillStyle = '#33444F'; for (const [x, y] of pts) g.fillRect(cx + x - 30, cy + y - 22, 60, 44);
    }
    g.restore();
  }
  async function renderBoard() {
    const token = ++B.renderToken;
    const g = bctx;
    if (B.kind === 'course') drawCourseSlide(g, S.course, Math.min(B.page, S.course.slides.length - 1));
    else {
      g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, 1280, 720);
      try {
        if (B.kind === 'pdf' && B.pdf) {
          const page = await B.pdf.getPage(B.page + 1);
          const v1 = page.getViewport({ scale: 1 });
          const sc = Math.min(1280 / v1.width, 720 / v1.height);
          const vp = page.getViewport({ scale: sc });
          const tmp = document.createElement('canvas'); tmp.width = Math.floor(vp.width); tmp.height = Math.floor(vp.height);
          await page.render({ canvasContext: tmp.getContext('2d'), viewport: vp }).promise;
          if (token !== B.renderToken) return;
          g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, 1280, 720);
          g.drawImage(tmp, (1280 - tmp.width) / 2, (720 - tmp.height) / 2);
        } else if (B.kind === 'images' && B.images[B.page]) {
          const im = B.images[B.page];
          const sc = Math.min(1280 / im.width, 720 / im.height);
          const w = im.width * sc, h = im.height * sc;
          g.drawImage(im, (1280 - w) / 2, (720 - h) / 2, w, h);
        } else {
          g.fillStyle = '#5A6873'; g.font = '700 40px "Atkinson Hyperlegible", sans-serif'; g.textAlign = 'center'; g.fillText('Loading the lecturer’s material…', 640, 360); g.textAlign = 'left';
        }
      } catch (e) {
        g.fillStyle = '#5A6873'; g.font = '700 36px "Atkinson Hyperlegible", sans-serif'; g.textAlign = 'center'; g.fillText('This page could not be shown.', 640, 360); g.textAlign = 'left';
      }
    }
    if (token !== B.renderToken) return;
    // page tag
    g.fillStyle = 'rgba(22,35,45,0.75)'; g.fillRect(1280 - 150, 720 - 46, 150, 46);
    g.fillStyle = '#FFFFFF'; g.font = '700 22px "Atkinson Hyperlegible", sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'center'; g.fillText(`${B.page + 1} / ${B.pages}`, 1280 - 75, 720 - 23); g.textAlign = 'left'; g.textBaseline = 'top';
    if (W.boardTex) W.boardTex.needsUpdate = true;
    if (!$('bvSheet').hidden) paintBoardView();
    updateRoomPanel(true);
  }
  function paintBoardView() {
    const c = $('bvCanvas'); c.getContext('2d').drawImage(boardCanvas, 0, 0);
    $('bvTitle').textContent = B.kind === 'course' ? `${S.course.code}: course slides` : B.name;
    $('bvPage').textContent = `Slide ${B.page + 1} of ${B.pages}`;
    const ctr = $('bvCtrls'); ctr.textContent = '';
    if (canControlBoard()) {
      const p = el('button', 'btn alt', '◀ Previous'); p.type = 'button'; p.onclick = () => setPage(B.page - 1);
      const n = el('button', 'btn', 'Next ▶'); n.type = 'button'; n.onclick = () => setPage(B.page + 1);
      ctr.append(p, n);
    } else ctr.append(el('span', 'muted', 'Your board follows the lecturer’s slides.'));
    const c2 = el('button', 'btn alt', 'Close'); c2.type = 'button'; c2.onclick = closeSheet; ctr.append(c2);
  }

  // ---------- Whiteboard layers ----------
  const myStrokes = document.createElement('canvas'); myStrokes.width = 1024; myStrokes.height = 512;
  let teacherLayer = null; let wbKey = null;
  function paintWhiteboardTo(g) {
    g.fillStyle = '#F7F7F2'; g.fillRect(0, 0, 1024, 512);
    g.fillStyle = S.course.accent; fitFont(g, 'Discuss: ' + S.course.prompt, 960, 36, 700, '"Bricolage Grotesque", sans-serif'); g.textBaseline = 'top'; g.fillText('Discuss: ' + S.course.prompt, 30, 28);
    if (teacherLayer) g.drawImage(teacherLayer, 0, 0, 1024, 512);
    g.drawImage(myStrokes, 0, 0);
  }
  function paintBoardWB() { if (!W.wbTex) return; paintWhiteboardTo(W.wbTex.image.getContext('2d')); W.wbTex.needsUpdate = true; }

  // ---------- World build ----------
  const ROOMS = () => [
    { key: 'lecture', name: 'Lecture hall', spawn: [0, 5.6, 0] },
    { key: 'lab', name: S.course.labName, spawn: [16, 5.0, 0] },
    { key: 'library', name: 'Library', spawn: [32, 4.6, 0] },
    { key: 'discussion', name: 'Discussion room', spawn: [48, 5.2, 0] },
  ];
  function buildWorld(course) {
    scene.remove(world); disposeTree(world);
    world = new THREE.Group(); scene.add(world);
    W.clickables = []; W.modelLabels = []; W.labelsOn = false; W.packet = null; W.packetT = -1;
    const rooms = ROOMS();
    rooms.forEach((r, i) => {
      const cx = i * ROOMW;
      const floors = ['#8A6748', '#AEB9BE', '#6E403A', '#6F7E62'];
      box(ROOMW, 0.1, DEPTH, floors[i], cx, -0.05, 0);
      box(ROOMW, 0.1, DEPTH, '#F1EEE8', cx, HGT + 0.05, 0);
      const wm = mat(course.walls[i]);
      box(ROOMW, HGT, 0.2, wm, cx, HGT / 2, -DEPTH / 2);
      box(ROOMW, HGT, 0.2, wm, cx, HGT / 2, DEPTH / 2);
      for (const lx of [-4, 4]) box(2.4, 0.06, 0.5, new THREE.MeshBasicMaterial({ color: 0xFFFBEF }), cx + lx, HGT - 0.02, 0);
      wallText(r.name, cx, 3.62, -DEPTH / 2 + 0.12, 2.6);
      box(ROOMW, 0.12, 0.05, course.accent, cx, 3.2 - 0.02, DEPTH / 2 - 0.12); // accent stripe on back wall
    });
    box(0.2, HGT, DEPTH, course.walls[0], -ROOMW / 2, HGT / 2, 0);
    box(0.2, HGT, DEPTH, course.walls[3], 3 * ROOMW + ROOMW / 2, HGT / 2, 0);
    for (let i = 0; i < 3; i++) {
      const wx = i * ROOMW + ROOMW / 2, segD = DEPTH / 2 - DOOR, wm = mat('#D8D1C4');
      box(0.2, HGT, segD, wm, wx, HGT / 2, -(DOOR + segD / 2));
      box(0.2, HGT, segD, wm, wx, HGT / 2, DOOR + segD / 2);
      box(0.2, HGT - DOORH, DOOR * 2, wm, wx, DOORH + (HGT - DOORH) / 2, 0);
      box(0.26, 0.12, DOOR * 2 + 0.2, '#5B4636', wx, DOORH, 0);
    }
    // Lecture hall
    box(5.9, 3.4, 0.12, '#20262B', 0, 1.85, -DEPTH / 2 + 0.16);
    const bt = new THREE.CanvasTexture(boardCanvas); bt.encoding = THREE.sRGBEncoding; bt.anisotropy = 4; W.boardTex = bt;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 3.15), new THREE.MeshBasicMaterial({ map: bt }));
    screen.position.set(0, 1.85, -DEPTH / 2 + 0.24); world.add(screen);
    screen.userData.action = () => openBoardView(); W.clickables.push(screen);
    box(0.9, 1.15, 0.6, '#5B4636', -4.6, 0.575, -5.2); box(1.0, 0.06, 0.7, '#6E5643', -4.6, 1.2, -5.2);
    for (const z of [-1.6, 0.8, 3.2]) for (const x of [-4.8, -1.6, 1.6, 4.8]) {
      box(1.5, 0.06, 0.7, '#B88A5A', x, 0.76, z);
      for (const [dx, dz] of [[-0.68, -0.28], [0.68, -0.28], [-0.68, 0.28], [0.68, 0.28]]) box(0.06, 0.74, 0.06, '#3B3F44', x + dx, 0.37, z + dz);
      box(0.5, 0.05, 0.5, '#2F5D7C', x, 0.46, z + 0.7); box(0.5, 0.55, 0.05, '#2F5D7C', x, 0.74, z + 0.95); box(0.05, 0.45, 0.05, '#3B3F44', x, 0.22, z + 0.7);
    }
    // Lab
    const L = ROOMW;
    for (const bx of [L - 5.6, L + 5.6]) {
      box(1.3, 0.9, 7, '#E9ECEE', bx, 0.45, 0.5); box(1.4, 0.06, 7.1, '#2B3A44', bx, 0.93, 0.5);
      for (let k = 0; k < 4; k++) benchItem(course.bench, bx, 0.96, -2 + k * 1.6);
    }
    box(2.8, 0.9, 1.9, '#2B3A44', L, 0.45, -1.8); box(2.9, 0.05, 2.0, '#3A4A55', L, 0.92, -1.8);
    const model = new THREE.Group(); model.position.set(L, 0.95, -1.8); world.add(model); W.model = model;
    buildModel(course, model);
    model.traverse(o => { if (o.isMesh) { o.userData.action = () => toggleLabels(); W.clickables.push(o); } });
    wallText('Goggles on · No food · Report spills', L - 4.8, 2.5, -DEPTH / 2 + 0.12, 4.2, { bg: '#F4F1E8', fg: '#A23A2B' });
    // Library
    const BL = 2 * ROOMW;
    const spines = canvasTex(512, 256, (g, Wd) => {
      g.fillStyle = '#3B2A20'; g.fillRect(0, 0, Wd, 256);
      const cols = ['#8E3B2F', '#2F5D7C', '#C79A3B', '#4C6B3A', '#6B4C7A', '#B65A32', '#2E4A55', '#D7C7A4'];
      for (let row = 0; row < 4; row++) { let x = 6, k = row * 3; while (x < Wd - 10) { const w = 14 + ((k * 37) % 18), h = 46 + ((k * 13) % 12); g.fillStyle = cols[k % cols.length]; g.fillRect(x, row * 64 + (60 - h), w, h); x += w + 2; k++; } g.fillStyle = '#2A1D16'; g.fillRect(0, row * 64 + 60, Wd, 4); }
    });
    for (const x of [-5.4, -1.8, 1.8, 5.4]) {
      box(3.4, 2.8, 0.5, mat('#4A3426'), BL + x, 1.4, -DEPTH / 2 + 0.4);
      const f = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.6), new THREE.MeshLambertMaterial({ map: spines.tex })); f.position.set(BL + x, 1.4, -DEPTH / 2 + 0.66); world.add(f);
    }
    for (const side of [-1, 1]) for (const z of [-4.2, 4.2]) {
      box(0.5, 2.6, 3.2, mat('#4A3426'), BL + side * (ROOMW / 2 - 0.45), 1.3, z);
      const f = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 2.4), new THREE.MeshLambertMaterial({ map: spines.tex })); f.position.set(BL + side * (ROOMW / 2 - 0.71), 1.3, z); f.rotation.y = -side * Math.PI / 2; world.add(f);
    }
    box(1.2, 1.1, 0.7, '#22303A', BL, 0.55, -2.6);
    const ks = canvasTex(512, 320, (g, Wd, H) => {
      g.fillStyle = '#0F2433'; g.fillRect(0, 0, Wd, H); g.fillStyle = '#F4B740'; g.font = '700 48px "Bricolage Grotesque", sans-serif'; g.textAlign = 'center'; g.fillText('Ask the library', Wd / 2, 120);
      g.fillStyle = '#CFE3EE'; g.font = '400 30px "Atkinson Hyperlegible", sans-serif'; g.fillText(course.code + ' notes', Wd / 2, 200);
    });
    const km = mat('#22303A');
    const kiosk = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.85, 0.08), [km, km, km, km, new THREE.MeshBasicMaterial({ map: ks.tex }), km]);
    kiosk.position.set(BL, 1.55, -2.62); kiosk.rotation.x = -0.25; world.add(kiosk);
    kiosk.userData.action = () => openSheet('searchSheet'); W.clickables.push(kiosk);
    for (const x of [-3.6, 3.6]) { box(2.6, 0.06, 1.2, '#B88A5A', BL + x, 0.76, 2.4); cyl(0.06, 0.06, 0.74, '#3B3F44', BL + x, 0.37, 2.4, 8); }
    // Discussion
    const D = 3 * ROOMW;
    cyl(1.6, 1.6, 0.08, '#B88A5A', D, 0.76, 1.2, 40); cyl(0.12, 0.3, 0.74, '#3B3F44', D, 0.37, 1.2, 12);
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * Math.PI * 2, x = D + Math.cos(a) * 2.3, z = 1.2 + Math.sin(a) * 2.3;
      const c = box(0.5, 0.05, 0.5, '#C2553A', x, 0.46, z); c.rotation.y = -a;
      const bk = box(0.5, 0.5, 0.05, '#C2553A', x + Math.cos(a) * 0.25, 0.72, z + Math.sin(a) * 0.25); bk.rotation.y = -a + Math.PI / 2;
    }
    const wbc = document.createElement('canvas'); wbc.width = 1024; wbc.height = 512;
    const wt = new THREE.CanvasTexture(wbc); wt.encoding = THREE.sRGBEncoding; wt.anisotropy = 4; W.wbTex = wt;
    box(5.4, 2.7, 0.1, '#9AA3A9', D, 1.8, -DEPTH / 2 + 0.16);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 2.5), new THREE.MeshBasicMaterial({ map: wt }));
    board.position.set(D, 1.8, -DEPTH / 2 + 0.23); world.add(board);
    board.userData.action = () => openSheet('wbSheet'); W.clickables.push(board);
    paintBoardWB();
  }
  function benchItem(kind, x, y, z) {
    if (kind === 'beaker') { cyl(0.12, 0.12, 0.3, mat('#9FD3EE', { transparent: true, opacity: 0.55 }), x, y + 0.15, z); cyl(0.1, 0.1, 0.12, '#3D8FD1', x, y + 0.06, z); }
    else if (kind === 'globe') { cyl(0.08, 0.12, 0.06, '#5B4636', x, y + 0.03, z); stick([x, y + 0.05, z], [x, y + 0.2, z], 0.015, '#5B4636'); sph(0.17, '#3A7FB8', x, y + 0.36, z); }
    else if (kind === 'microscope') { box(0.26, 0.04, 0.3, '#2B2F33', x, y + 0.02, z); box(0.06, 0.34, 0.06, '#2B2F33', x, y + 0.19, z - 0.1); cyl(0.04, 0.05, 0.22, '#E9ECEE', x, y + 0.32, z - 0.02); box(0.18, 0.02, 0.16, '#AEB9BE', x, y + 0.14, z + 0.02); }
    else { box(0.5, 0.32, 0.04, '#1B2227', x, y + 0.3, z); const scr = box(0.46, 0.27, 0.01, new THREE.MeshBasicMaterial({ color: 0x2E5B87 }), x + 0.0, y + 0.3, z + 0.025); scr.rotation.y = 0; box(0.06, 0.14, 0.06, '#1B2227', x, y + 0.07, z); }
  }
  function addLabel(model, text, x, y, z, scale) { const s = makeLabel(text, scale || 0.7, model); s.position.set(x, y, z); s.visible = false; W.modelLabels.push(s); return s; }
  function buildModel(course, g) {
    W.spin = false;
    if (course.model === 'diorama') {
      box(1.3, 0.2, 1.4, '#6AA84F', -0.6, 0.1, 0, g); box(1.2, 0.16, 1.4, mat('#2F8FCF', { transparent: true, opacity: 0.9 }), 0.65, 0.08, 0, g);
      const mtn = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.8, 18), mat('#7C6A55')); mtn.position.set(-0.7, 0.6, -0.1); g.add(mtn);
      const cap2 = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.3, 18), mat('#FFFFFF')); cap2.position.set(-0.7, 0.86, -0.1); g.add(cap2);
      for (const [x, y, r] of [[-0.25, 1.5, 0.2], [0, 1.58, 0.26], [0.26, 1.5, 0.19]]) sph(r, '#E8EDF0', x, y, 0, g);
      sph(0.18, new THREE.MeshBasicMaterial({ color: 0xF4B740 }), 0.95, 1.85, -0.3, g);
      for (let k = 0; k < 6; k++) stick([-0.35 + k * 0.1, 1.3, 0.05], [-0.42 + k * 0.1, 0.95, 0.05], 0.012, '#3D8FD1', g);
      for (let k = 0; k < 3; k++) { const s = sph(0.035, '#9FD3EE', 0.55 + k * 0.12, 0.45 + k * 0.25, 0.1, g); s.userData.vapour = k; }
      addLabel(g, 'Sea', 0.75, 0.35, 0.5); addLabel(g, 'Mountain', -0.75, 1.15, 0.2); addLabel(g, 'Cloud', 0, 1.95, 0.1);
      addLabel(g, 'Sun', 0.95, 2.18, -0.3, 0.55); addLabel(g, 'Evaporation ↑', 0.95, 0.9, 0.3); addLabel(g, 'Rain ↓', -0.4, 0.75, 0.4, 0.6);
    } else if (course.model === 'molecules') {
      const w = new THREE.Group(); w.position.set(-0.7, 0.85, 0); g.add(w);
      sph(0.3, '#D9463E', 0, 0, 0, w);
      const ang = 104.5 * Math.PI / 180, bl = 0.55;
      for (const sgn of [-1, 1]) { const a = -Math.PI / 2 + sgn * ang / 2; const p = [Math.cos(a) * bl, Math.sin(a) * bl, 0]; sph(0.19, '#F2F2F2', p[0], p[1], 0, w); stick([0, 0, 0], p, 0.045, '#BFC7CC', w); }
      const c = new THREE.Group(); c.position.set(0.75, 0.85, 0); g.add(c);
      sph(0.26, '#3B4045', 0, 0, 0, c); sph(0.28, '#D9463E', -0.6, 0, 0, c); sph(0.28, '#D9463E', 0.6, 0, 0, c);
      for (const dy of [-0.06, 0.06]) { stick([-0.6, dy, 0], [0, dy, 0], 0.035, '#BFC7CC', c); stick([0, dy, 0], [0.6, dy, 0], 0.035, '#BFC7CC', c); }
      W.spinTargets = [w, c]; W.spin = true;
      addLabel(g, 'Water (H₂O): bent, 104.5°', -0.7, 1.45, 0, 0.8); addLabel(g, 'Carbon dioxide (CO₂): straight, 180°', 0.75, 1.45, 0, 0.9);
      addLabel(g, 'Oxygen', -0.7, 0.35, 0.3, 0.55); addLabel(g, 'Carbon', 0.75, 0.35, 0.3, 0.55);
    } else if (course.model === 'cell') {
      const cell = new THREE.Group(); cell.position.set(0, 1.0, 0); g.add(cell);
      const mem = sph(0.85, new THREE.MeshLambertMaterial({ color: 0xE88CA0, transparent: true, opacity: 0.28, depthWrite: false }), 0, 0, 0, cell); mem.scale.set(1.15, 0.85, 0.95);
      sph(0.3, '#7B5EA7', 0.1, 0.05, 0, cell); sph(0.1, '#4A3470', 0.16, 0.1, 0.18, cell);
      for (const [x, y, z, rz] of [[-0.55, 0.2, 0.1, 0.5], [-0.35, -0.4, 0.2, -0.4], [0.55, -0.25, -0.1, 1.2]]) {
        const m = new THREE.Group(); m.position.set(x, y, z); m.rotation.z = rz; cell.add(m);
        cyl(0.07, 0.07, 0.22, '#E8913A', 0, 0, 0, 12, m); sph(0.07, '#E8913A', 0, 0.11, 0, m); sph(0.07, '#E8913A', 0, -0.11, 0, m);
      }
      for (let k = 0; k < 26; k++) { const a = k * 2.399, r = 0.45 + (k % 5) * 0.06; sph(0.025, '#2E4A7A', Math.cos(a) * r * 1.1, Math.sin(a * 1.7) * 0.4, Math.sin(a) * r * 0.6, cell); }
      W.spinTargets = [cell]; W.spin = true;
      addLabel(g, 'Cell membrane', 0, 1.95, 0, 0.75); addLabel(g, 'Nucleus', 0.15, 1.35, 0.5, 0.6); addLabel(g, 'Mitochondrion', -0.75, 1.45, 0.5, 0.7);
      addLabel(g, 'Ribosomes', 0.75, 0.75, 0.5, 0.6); addLabel(g, 'Cytoplasm', -0.6, 0.55, 0.6, 0.6);
    } else {
      const sw = box(0.6, 0.12, 0.35, '#3B2F6B', 0, 0.06, 0.15, g);
      const rt = box(0.5, 0.12, 0.3, '#22303A', 0, 0.06, -0.7, g);
      stick([0, 0.03, 0.0], [0, 0.03, -0.55], 0.018, '#5A6873', g);
      const pcs = [];
      for (let k = 0; k < 5; k++) {
        const a = Math.PI * 0.1 + k * Math.PI * 0.2, x = Math.cos(a) * 1.15, z = 0.15 + Math.sin(a) * 0.6;
        const pc = new THREE.Group(); pc.position.set(x, 0, z); g.add(pc); g.updateMatrixWorld(true); pc.lookAt(g.localToWorld(new THREE.Vector3(0, 0, 0.15)));
        box(0.34, 0.24, 0.03, '#1B2227', 0, 0.26, 0, pc); box(0.3, 0.2, 0.005, new THREE.MeshBasicMaterial({ color: 0x2E5B87 }), 0, 0.26, -0.018, pc); box(0.05, 0.12, 0.05, '#1B2227', 0, 0.08, 0, pc);
        stick([x, 0.02, z], [0, 0.02, 0.15], 0.012, '#5A6873', g);
        pcs.push([x, 0.06, z]);
      }
      W.pcs = pcs;
      const packet = sph(0.06, new THREE.MeshBasicMaterial({ color: 0xF4B740 }), 0, 0.1, 0, g); packet.visible = false; W.packet = packet;
      addLabel(g, 'Switch', 0, 0.45, 0.2, 0.55); addLabel(g, 'Router (to the internet)', 0, 0.42, -0.85, 0.8);
      addLabel(g, 'Computer', pcs[0][0], 0.62, pcs[0][2], 0.6); addLabel(g, 'Cable', pcs[3][0] * 0.5, 0.2, (pcs[3][2] + 0.15) / 2 + 0.05, 0.5);
    }
  }
  function toggleLabels() {
    W.labelsOn = !W.labelsOn; W.modelLabels.forEach(s => { s.visible = W.labelsOn; });
    setAct(W.labelsOn ? 'Labelling the ' + S.course.labName.toLowerCase() + ' model' : 'Looking at the lab model');
  }
  function sendPacket() { if (!W.packet) return; W.packetT = 0; W.packet.visible = true; setAct('Sending a packet across the network'); }

  // ================= Movement =================
  const pos = new THREE.Vector3(0, 1.6, 5.6);
  let yaw = 0, pitch = -0.05;
  const keys = {}, pad = {};
  const MINX = -ROOMW / 2 + 0.5, MAXX = 3 * ROOMW + ROOMW / 2 - 0.5, MINZ = -DEPTH / 2 + 0.5, MAXZ = DEPTH / 2 - 0.5;
  function clampMove(p, dx, dz) {
    let nx = Math.min(MAXX, Math.max(MINX, p.x + dx));
    const nz = Math.min(MAXZ, Math.max(MINZ, p.z + dz));
    for (let i = 0; i < 3; i++) {
      const wx = i * ROOMW + ROOMW / 2;
      const crossing = (p.x - wx) * (nx - wx) <= 0 || Math.abs(nx - wx) < 0.35;
      if (crossing && Math.abs(nz) > DOOR - 0.35) nx = p.x < wx ? Math.min(nx, wx - 0.35) : Math.max(nx, wx + 0.35);
    }
    p.x = nx; p.z = nz;
  }
  const roomOf = x => Math.min(3, Math.max(0, Math.floor((x + ROOMW / 2) / ROOMW)));
  function goRoom(i) { const r = ROOMS()[i]; pos.set(r.spawn[0], 1.6, r.spawn[1]); yaw = r.spawn[2]; pitch = -0.05; }
  const uiBlocked = () => !$('lobby').hidden || !!openId;
  addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('input, textarea')) return;
    if (uiBlocked()) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { keys[k] = true; e.preventDefault(); }
  });
  addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
  for (const b of $('pad').querySelectorAll('button')) {
    const k = b.dataset.k;
    b.addEventListener('pointerdown', e => { e.preventDefault(); pad[k] = true; b.setPointerCapture(e.pointerId); });
    const up = () => { pad[k] = false; };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
  }
  const cv = renderer.domElement;
  let drag = null;
  cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, moved: 0 }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    yaw -= dx * 0.005; pitch = Math.max(-1.2, Math.min(1.2, pitch - dy * 0.004));
  });
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  cv.addEventListener('pointerup', e => {
    const d = drag; drag = null; if (!d || d.moved > 8 || uiBlocked()) return;
    const r = cv.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(W.clickables, false)[0];
    if (hit && hit.distance < 12 && hit.object.userData.action) hit.object.userData.action();
  });
  cv.addEventListener('pointercancel', () => { drag = null; });
  // input activity (for "idle" in the lecturer's view)
  let lastInputPub = 0;
  function noteInput() { S.lastInput = Date.now(); if (S.lastInput - lastInputPub > 15000) { lastInputPub = S.lastInput; pub({ lastInput: S.lastInput }); } }
  addEventListener('pointerdown', noteInput, true); addEventListener('keydown', noteInput, true);
  function focusState() { return document.visibilityState === 'visible' && document.hasFocus(); }
  const pubFocus = () => pub({ focus: focusState() });
  document.addEventListener('visibilitychange', pubFocus); addEventListener('focus', pubFocus); addEventListener('blur', pubFocus);

  // ================= Sheets =================
  let openId = null;
  function openSheet(id) {
    closeSheet(); openId = id; $(id).hidden = false; for (const k in keys) keys[k] = false;
    const f = $(id).querySelector('input[type=text], button'); if (f) f.focus();
    if (id === 'searchSheet') { setAct('Using Ask the library'); renderSearchChips(); }
    if (id === 'wbSheet') { setAct('Drawing on the whiteboard'); resetDrawCanvas(); $('wbNote').textContent = wbNoteText(); }
  }
  function closeSheet() { if (openId) $(openId).hidden = true; openId = null; }
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheet));
  document.querySelectorAll('.sheet').forEach(s => s.addEventListener('click', e => { if (e.target === s) closeSheet(); }));
  addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
  $('aboutBtn').addEventListener('click', () => openSheet('aboutSheet'));
  $('aboutBtn2').addEventListener('click', () => openSheet('aboutSheet'));
  function openBoardView() { openSheet('bvSheet'); paintBoardView(); setAct(`Viewing slide ${B.page + 1} on the board`); }

  // ================= Board control =================
  let boardWriting = false, boardPending = null;
  async function writeBoard(patch) {
    if (!(S.mode === 'live' && S.role === 'teacher' && S.code)) return;
    boardPending = Object.assign(boardPending || {}, patch);
    if (boardWriting) return;
    boardWriting = true;
    try {
      while (boardPending) {
        const p = boardPending; boardPending = null;
        await BE.setBoard(S.code, 'lecture', Object.assign(boardDocBody(), p));
      }
    } catch (e) { toast('The board could not be updated for students. Check your connection.'); }
    boardWriting = false;
  }
  function boardDocBody() { return { kind: B.kind, filePaths: B.assetIds || [], name: B.name, page: B.page, pages: B.pages }; }
  function setPage(n) {
    n = Math.max(0, Math.min(B.pages - 1, n)); if (n === B.page) return;
    B.page = n; renderBoard(); writeBoard({ page: n }); setAct(`Showing slide ${n + 1} on the board`);
  }
  function useCourseSlides(share) {
    B.kind = 'course'; B.pdf = null; B.images = []; B.assetIds = []; B.key = 'course'; B.name = 'Course slides'; B.page = 0; B.pages = S.course.slides.length;
    renderBoard();
    if (share) writeBoard({ kind: 'course', filePaths: [], name: 'Course slides', page: 0, pages: B.pages });
  }
  async function loadPdfData(buf) { return pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise; }
  function loadImageURL(url) { return new Promise((res, rej) => { const im = new Image(); if (!/^blob:/.test(url)) im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = rej; im.src = url; }); }
  async function handleFiles(files) {
    const st = $('upStatus');
    files = Array.from(files || []); if (!files.length) return;
    const pdf = files.find(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const imgs = files.filter(f => /^image\/(png|jpeg|webp)$/.test(f.type)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).slice(0, 40);
    if (!pdf && !imgs.length) { st.textContent = 'That file type isn’t supported. Choose a PDF, or PNG or JPG images. For PowerPoint, save as PDF first.'; return; }
    if (pdf && !hasPdf) { st.textContent = 'The PDF viewer could not load in this browser. Try slide images instead.'; return; }
    const tooBig = (pdf ? [pdf] : imgs).find(f => f.size > 20 * 1024 * 1024);
    if (tooBig) { st.textContent = `${tooBig.name} is larger than 20 MB. Compress it or split it, then try again.`; return; }
    const share = S.mode === 'live' && S.role === 'teacher';
    try {
      if (pdf) {
        st.textContent = 'Opening the PDF…';
        const buf = await pdf.arrayBuffer();
        const doc = await loadPdfData(buf.slice(0));
        let ids = [];
        if (share) { st.textContent = 'Uploading for your students…'; ids = [await BE.uploadFile(S.code, pdf)]; }
        Object.assign(B, { kind: 'pdf', pdf: doc, images: [], assetIds: ids, key: 'pdf:' + (ids[0] || pdf.name + pdf.size), name: pdf.name.replace(/\.pdf$/i, ''), page: 0, pages: doc.numPages });
      } else {
        st.textContent = `Opening ${imgs.length} image${imgs.length > 1 ? 's' : ''}…`;
        const ims = [], ids = [];
        for (let i = 0; i < imgs.length; i++) {
          const url = URL.createObjectURL(imgs[i]); ims.push(await loadImageURL(url));
          if (share) { st.textContent = `Uploading slide ${i + 1} of ${imgs.length}…`; ids.push(await BE.uploadFile(S.code, imgs[i])); }
        }
        Object.assign(B, { kind: 'images', pdf: null, images: ims, assetIds: ids, key: 'img:' + (ids.join(',') || imgs.map(f => f.name).join(',')), name: imgs.length === 1 ? imgs[0].name : `${imgs.length} slides`, page: 0, pages: ims.length });
      }
      await renderBoard();
      if (share) await writeBoard(boardDocBody());
      st.textContent = '';
      closeSheet();
      toast(share ? 'On the board for everyone in the class.' : (S.mode === 'live' ? 'Shown on your screen only.' : 'On the board. In explore mode it stays on your screen.'));
      setAct(`Put “${B.name}” on the board`);
    } catch (e) {
      const code = e && e.code;
      st.textContent = code === 'quota_or_state' ? 'Storage for this page is full. Remove old material or use a smaller file.'
        : code === 'too_large' ? 'That file is too large. Keep it under 20 MB.'
        : code === 'rate_limited' ? 'Too many uploads at once. Wait a moment and try again.'
        : (e && e.name === 'PasswordException') ? 'That PDF is password-protected. Save an unprotected copy and try again.'
        : 'That file could not be opened. Check that it is a PDF or an image and try again.';
    }
  }
  $('fileIn').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
  $('useCourseSlides').addEventListener('click', () => { const share = S.mode === 'live' && S.role === 'teacher'; useCourseSlides(share); closeSheet(); toast('Showing the course slides.'); setAct('Switched the board to the course slides'); });
  function openUpload() {
    $('upStatus').textContent = '';
    $('upScope').textContent = S.mode === 'live' && S.role === 'teacher'
      ? 'Everyone in this class will see it, and their boards follow your page.'
      : 'In explore mode, the file stays on your screen and is not uploaded anywhere.';
    openSheet('uploadSheet');
  }
  async function applyBoardDoc(d) {
    if (!d) return;
    const paths = d.filePaths || [];
    const key = d.kind === 'course' ? 'course' : (d.kind === 'pdf' ? 'pdf:' : 'img:') + paths.join(d.kind === 'pdf' ? '' : ',');
    if (key !== B.key) {
      if (d.kind === 'course') { useCourseSlides(false); }
      else if (B.loadingKey !== key) {
        B.loadingKey = key; Object.assign(B, { kind: d.kind, pdf: null, images: [], assetIds: paths, key, name: d.name || 'Lecture material', pages: d.pages || 1 });
        renderBoard();
        try {
          if (d.kind === 'pdf') { const r = await fetch(await BE.fileUrl(paths[0])); if (!r.ok) throw new Error('fetch'); const doc = await loadPdfData(await r.arrayBuffer()); if (B.key === key) { B.pdf = doc; B.pages = doc.numPages; } }
          else { const ims = await Promise.all(paths.map(async p => loadImageURL(await BE.fileUrl(p)))); if (B.key === key) { B.images = ims; B.pages = ims.length; } }
        } catch (e) { if (S.role !== 'teacher') toast('The lecturer’s material could not be loaded on your screen.'); }
        B.loadingKey = null;
      }
    }
    B.page = Math.max(0, Math.min((B.pages || 1) - 1, Number(d.page) || 0));
    renderBoard();
  }

  // ================= Library search =================
  const STOP = new Set('the a an of to in is are and or what how why where when does do did i my your it its from for on with which who about can'.split(' '));
  const stem = w => w.replace(/(ing|ed|es|s)$/, '');
  function matchNotes(q) {
    const notes = S.course.notes;
    const words = q.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)).map(stem);
    return notes.map((n, i) => {
      const hay = (n.t + ' ' + n.b).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).map(stem);
      let s = 0; for (const w of words) { if (hay.includes(w)) s += 1; if (n.t.toLowerCase().includes(w)) s += 2; }
      return { i, s };
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 2);
  }
  function showResult(text, srcs, how) {
    const out = $('searchOut'); out.textContent = '';
    const bx = el('div', 'result'); const p = el('p', null, text); bx.append(p);
    if (srcs.length) { const s = el('div', 'src'); s.append('From the notes: '); srcs.forEach((n, k) => { s.append(el('b', null, n)); if (k < srcs.length - 1) s.append(', '); }); bx.append(s); }
    bx.append(el('div', 'src', how)); out.append(bx); return p;
  }
  let searchCtl = null;
  async function search(q) {
    setAct(`Asked the library: “${q.slice(0, 60)}”`);
    const notes = S.course.notes;
    const hits = matchNotes(q);
    if (!hits.length) { showResult('The course notes don’t cover that. Try one of the example questions.', [], 'Matched from the course notes'); return; }
    showResult(hits.map(h => notes[h.i].b).join(' '), hits.map(h => notes[h.i].t), 'Matched from the course notes by keyword');
  }
  function renderSearchChips() {
    const c = $('searchChips'); c.textContent = '';
    $('searchQ').placeholder = 'e.g. ' + S.course.examples[0];
    $('searchMode').textContent = 'Answers are matched from this course’s notes, and each answer names the notes it used.';
    for (const q of S.course.examples) { const b = el('button', 'btn alt', q); b.type = 'button'; b.onclick = () => { $('searchQ').value = q; search(q); }; c.append(b); }
  }
  $('searchForm').addEventListener('submit', e => { e.preventDefault(); const q = $('searchQ').value.trim(); if (q) search(q); });

  // ================= Whiteboard =================
  const wbc = $('wbCanvas'), wg = wbc.getContext('2d'), sg = myStrokes.getContext('2d');
  let pen = '#1B2A33';
  function resetDrawCanvas() { paintWhiteboardTo(wg); }
  for (const [c, n] of [['#1B2A33', 'Black'], ['#1E6FA8', 'Blue'], ['#C0392B', 'Red'], ['#2E8B57', 'Green']]) {
    const b = el('button', 'swatch'); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', n + ' pen'); b.setAttribute('aria-pressed', String(c === pen));
    b.addEventListener('click', () => { pen = c; for (const s of $('wbTools').children) s.setAttribute('aria-pressed', String(s === b)); }); $('wbTools').append(b);
  }
  let drawing = null;
  const pt = e => { const r = wbc.getBoundingClientRect(); return [(e.clientX - r.left) * 1024 / r.width, (e.clientY - r.top) * 512 / r.height]; };
  wbc.addEventListener('pointerdown', e => { drawing = pt(e); wbc.setPointerCapture(e.pointerId); });
  wbc.addEventListener('pointermove', e => {
    if (!drawing) return; const p = pt(e);
    for (const g of [wg, sg]) { g.strokeStyle = pen; g.lineWidth = 6; g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath(); g.moveTo(drawing[0], drawing[1]); g.lineTo(p[0], p[1]); g.stroke(); }
    drawing = p;
  });
  const endDraw = () => { drawing = null; };
  wbc.addEventListener('pointerup', endDraw); wbc.addEventListener('pointercancel', endDraw);
  $('wbClear').addEventListener('click', () => { sg.clearRect(0, 0, 1024, 512); resetDrawCanvas(); });
  function wbNoteText() {
    if (S.mode === 'live' && S.role === 'teacher') return 'Draw or write on the board. Put on board shows it to everyone in the class.';
    if (S.mode === 'live') return 'Draw or write your answer. Only you see your drawing; your lecturer’s drawing appears for everyone.';
    return 'Draw or write your answer, then put it on the board. In explore mode it stays on your screen.';
  }
  $('wbDone').addEventListener('click', async () => {
    if (S.mode === 'live' && S.role === 'teacher') {
      try {
        const merged = document.createElement('canvas'); merged.width = 1024; merged.height = 512; const mg = merged.getContext('2d');
        if (teacherLayer) mg.drawImage(teacherLayer, 0, 0, 1024, 512); mg.drawImage(myStrokes, 0, 0);
        const blob = await new Promise(r => merged.toBlob(r, 'image/png'));
        const path = await BE.uploadFile(S.code, blob, 'whiteboard.png');
        await BE.setBoard(S.code, 'discussion', { kind: 'image', filePaths: [path], name: 'Whiteboard', page: 0, pages: 1 });
        teacherLayer = merged; sg.clearRect(0, 0, 1024, 512);
        toast('On the whiteboard for everyone.');
      } catch (e) { toast('The whiteboard could not be shared. It shows on your screen only.'); }
    }
    paintBoardWB(); closeSheet(); setAct('Added an answer to the whiteboard');
  });
  async function applyWbDoc(d) {
    const p = d && d.filePaths && d.filePaths[0];
    if (!p || p === wbKey) return;
    wbKey = p;
    try { teacherLayer = await loadImageURL(await BE.fileUrl(p)); paintBoardWB(); } catch (e) {}
  }

  // ================= Presence & live class =================
  let lastPosPub = 0, lastPub = { x: 0, z: 0, yaw: 0, room: '' };
  function pub(patch) { if (S.cls) S.cls.presence(patch).catch(() => {}); }
  function pubPosition(now, force) {
    if (!S.cls) return;
    const room = ROOM_KEYS[roomOf(pos.x)];
    const moved = Math.abs(pos.x - lastPub.x) + Math.abs(pos.z - lastPub.z) > 0.05 || Math.abs(yaw - lastPub.yaw) > 0.05 || room !== lastPub.room;
    if (!force && (!moved || now - lastPosPub < 250)) return;
    lastPosPub = now; lastPub = { x: pos.x, z: pos.z, yaw, room };
    pub({ x: Math.round(pos.x * 100) / 100, z: Math.round(pos.z * 100) / 100, yaw: Math.round(yaw * 100) / 100, room });
  }
  function genCode() { const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }
  async function startLiveClass(course) {
    if (!liveOK() || !BE.isLecturer) return;
    const code = genCode();
    try {
      await BE.createClass(code, course.id);
      await enterLive(code, { course: course.id, lecturerId: BE.user.id });
      toast(`Class started. Students join with code ${code}.`, 6000);
    } catch (e) { toast('The class could not be started: ' + e.message); }
  }
  async function endLiveClass(code) {
    if (S.cls && S.code === code) await S.cls.emit('ended', {}).catch(() => {});
    try { await BE.endClass(code); } catch (e) { toast('The class could not be ended: ' + e.message); }
  }
  async function joinByCode(code) {
    code = (code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) { toast('Class codes have 6 letters and numbers.'); return; }
    if (!liveOK()) { toast('Sign in first to join a live class.'); return; }
    try {
      const c = await BE.getClass(code);
      if (!c || !c.live) { toast('There’s no live class with that code. Check it with your lecturer.'); return; }
      await enterLive(code, { course: c.course, lecturerId: c.lecturer_id });
    } catch (e) { toast('Could not join that class: ' + e.message); }
  }
  async function enterLive(code, data) {
    const course = COURSES.find(c => c.id === data.course) || COURSES[0];
    S.mode = 'live'; S.role = BE.isLecturer ? 'teacher' : 'student'; S.code = code; S.hand = false; S.lecturerId = data.lecturerId || null;
    setCourse(course);
    const fromLecturer = p => S.role === 'student' && p && (!S.lecturerId || p.from === S.lecturerId);
    S.cls = BE.joinChannel(code, {
      onPeers: () => scheduleMonitor(),
      onJoin: (key, meta) => { if (S.role === 'student' && meta && meta.role === 'teacher' && key !== BE.user.id) toast('Your lecturer has joined.'); },
      onGather: p => { if (fromLecturer(p) && ROOM_KEYS.includes(p.room)) { const i = ROOM_KEYS.indexOf(p.room); goRoom(i); toast('Your lecturer brought everyone to the ' + ROOMS()[i].name.toLowerCase() + '.'); } },
      onLower: p => { if (fromLecturer(p) && S.hand && (!p.peer || p.peer === BE.user.id)) { setHand(false); toast('Your lecturer lowered your hand.'); } },
      onEnded: async () => { if (S.role !== 'student') return; try { const c = await BE.getClass(code); if (c && c.live) return; } catch (e) {} if (S.code === code) { toast('The lecturer ended the class.', 5000); leaveSession(); } },
      onStatus: ok => { if (!ok) toast('Connection to the class dropped. It will reconnect automatically.'); },
    });
    S.unsubs.push(BE.watchClass(code, row => { if (row && row.live === false && S.role === 'student' && S.code === code) { toast('The lecturer ended the class.', 5000); leaveSession(); } }));
    S.unsubs.push(BE.watchBoard(code, 'lecture', d => applyBoardDoc(d)));
    S.unsubs.push(BE.watchBoard(code, 'discussion', d => applyWbDoc(d)));
    if (S.role === 'student') { BE.markAttendance(code); S.attendTimer = setInterval(() => BE.markAttendance(code), 60000); }
    S.cls.presence({ role: S.role, name: BE.user.name, course: course.id, focus: focusState(), lastInput: Date.now(), hand: false, handAt: 0, act: 'Joined the class' });
    lastPub.room = ''; pubPosition(performance.now(), true);
    showHud(); logMine(S.role === 'teacher' ? `Started teaching ${course.code}` : `Joined ${course.code}`);
  }
  function setHand(v) { S.hand = v; S.handAt = Date.now(); pub({ hand: v, handAt: S.handAt }); logMine(v ? 'Raised hand' : 'Lowered hand'); scheduleMonitor(); }
  async function openAttendance() {
    openSheet('attSheet');
    const body = $('attBody'); body.textContent = '';
    $('attNote').textContent = `Class ${S.code}. Each student is recorded when they join and every minute while they stay.`;
    try {
      const rows = await BE.listAttendance(S.code);
      if (!rows.length) { const tr = el('tr'); const td = el('td', 'muted', 'No students have joined yet.'); td.colSpan = 3; tr.append(td); body.append(tr); }
      for (const v of rows) { const tr = el('tr'); tr.append(el('td', null, v.name), el('td', null, v.firstSeen ? fmtTime(new Date(v.firstSeen)) : '—'), el('td', null, v.lastSeen ? fmtTime(new Date(v.lastSeen)) : '—')); body.append(tr); }
    } catch (e) { const tr = el('tr'); const td = el('td', 'muted', 'Attendance could not be loaded.'); td.colSpan = 3; tr.append(td); body.append(tr); }
  }

  // ================= Simulated class =================
  const SIM_NAMES = ['Amaka', 'Tunde', 'Zainab', 'Chidi', 'Funmi', 'Ibrahim', 'Ngozi'];
  const SIM_COLORS = ['#E07A5F', '#81B29A', '#F2CC8F', '#6D9DC5', '#C77DFF', '#F28482', '#84A59D'];
  function startSim(course) {
    S.mode = 'sim'; S.role = 'teacher'; S.code = null; S.cls = null;
    setCourse(course);
    const now = Date.now();
    S.sim = { bots: SIM_NAMES.map((n, i) => {
      const room = i < 4 ? 0 : (i % 4);
      const spot = randSpot(room);
      return { key: 'sim' + i, name: n, color: SIM_COLORS[i], role: 'student', x: spot[0], z: spot[1], yaw: 0, path: [], roomIdx: room, act: room === 0 ? 'Watching the board' : 'Exploring the ' + ROOMS()[room].name.toLowerCase(), focus: true, awayUntil: 0, lastInput: now, hand: i === 2, handAt: now - 40000, next: now + 2000 + i * 900, updatedAt: now, sim: true };
    }) };
    showHud(); logMine(`Opened a simulated ${course.code} class`);
    toast('Simulated class: these students are made up, to preview the lecturer’s view.', 6000);
  }
  function randSpot(room) { const cx = room * ROOMW; return [cx + (Math.random() * 10 - 5), Math.random() * 7 - 2.5]; }
  function routeTo(b, room) {
    const path = []; let cur = roomOf(b.x);
    while (cur !== room) { const step = room > cur ? 1 : -1; const wx = cur * ROOMW + (step > 0 ? ROOMW / 2 : -ROOMW / 2); path.push([wx - step * 0.8, 0], [wx + step * 0.8, 0]); cur += step; }
    path.push(randSpot(room)); b.path = path; b.roomIdx = room;
  }
  function simActFor(b) {
    const r = b.roomIdx, c = S.course;
    const opts = r === 0 ? [`Viewing slide ${B.page + 1} on the board`, 'Watching the board', 'Taking notes']
      : r === 1 ? ['Labelling the lab model', 'Looking at the lab model']
      : r === 2 ? c.examples.map(q => `Asked the library: “${q}”`)
      : ['Drawing on the whiteboard', 'Reading the discussion question'];
    return opts[Math.floor(Math.random() * opts.length)];
  }
  function simTick(dt, now) {
    if (!S.sim) return;
    let changed = false;
    for (const b of S.sim.bots) {
      if (b.path.length) {
        const [tx, tz] = b.path[0]; const dx = tx - b.x, dz = tz - b.z, d = Math.hypot(dx, dz), sp = 1.5 * dt;
        if (d < sp) { b.x = tx; b.z = tz; b.path.shift(); } else { b.x += dx / d * sp; b.z += dz / d * sp; b.yaw = Math.atan2(-dx, -dz); }
      }
      if (b.awayUntil && now > b.awayUntil) { b.awayUntil = 0; b.focus = true; b.lastInput = now; b.updatedAt = now; changed = true; }
      if (now > b.next) {
        b.next = now + 4000 + Math.random() * 7000;
        const r = Math.random();
        if (r < 0.22) { routeTo(b, Math.floor(Math.random() * 4)); b.act = 'Walking to the ' + ROOMS()[b.roomIdx].name.toLowerCase(); }
        else if (r < 0.32 && !b.awayUntil) { b.focus = false; b.awayUntil = now + 15000 + Math.random() * 20000; }
        else if (r < 0.38) { b.hand = !b.hand; b.handAt = now; }
        else if (r < 0.48) { /* idle: no input */ }
        else { b.act = simActFor(b); b.lastInput = now; if (b.path.length === 0 && Math.random() < 0.5) b.path.push(randSpot(b.roomIdx)); }
        b.updatedAt = now; changed = true;
      }
    }
    if (changed) scheduleMonitor();
  }

  // ================= Roster & monitor =================
  function roster() {
    if (S.mode === 'sim' && S.sim) return S.sim.bots.map(b => ({ key: b.key, id: null, me: false, sim: true, name: b.name, color: b.color, role: 'student', room: ROOM_KEYS[roomOf(b.x)], x: b.x, z: b.z, yaw: b.yaw, act: b.act, focus: b.focus, lastInput: b.lastInput, hand: b.hand, handAt: b.handAt, updatedAt: b.updatedAt }));
    if (S.mode === 'live' && S.cls) return S.cls.peers().map(p => ({ key: p.key, id: p.id, me: p.me, name: typeof p.name === 'string' ? p.name.slice(0, 60) : '', role: p.role === 'teacher' ? 'teacher' : 'student', room: ROOM_KEYS.includes(p.room) ? p.room : null,
      x: Number(p.x), z: Number(p.z), yaw: Number(p.yaw) || 0, act: typeof p.act === 'string' ? p.act.slice(0, 120) : '', focus: p.focus !== false, lastInput: Number(p.lastInput) || p.updatedAt, hand: p.hand === true, handAt: Number(p.handAt) || 0, updatedAt: p.updatedAt }));
    return [];
  }
  const PALETTE = ['#E07A5F', '#81B29A', '#F2CC8F', '#6D9DC5', '#C77DFF', '#F28482', '#84A59D', '#9DB4C0', '#E9C46A', '#8AB17D'];
  const hashColor = s => { let h = 0; for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) | 0; return PALETTE[Math.abs(h) % PALETTE.length]; };
  const nameOf = r => r.name || (r.role === 'teacher' ? 'Lecturer' : 'Student');
  const colorOf = r => r.sim ? r.color : hashColor(r.id || r.key);
  function statusOf(r, now) {
    if (r.hand) return ['hand', 'Hand up'];
    if (!r.focus) return ['away', 'Away from class tab'];
    const idle = now - (r.lastInput || now);
    if (idle > 120000) return ['idle', `Idle ${Math.round(idle / 60000)} min`];
    return ['on', 'Active'];
  }
  let monScheduled = false;
  function scheduleMonitor() { if (monScheduled) return; monScheduled = true; requestAnimationFrame(() => { monScheduled = false; renderMonitor(); }); }
  setInterval(() => { if (S.mode) scheduleMonitor(); }, 5000);
  function renderMonitor() {
    if (!S.mode) return;
    const list = roster();
    updateAvatars(list);
    const now = Date.now();
    $('monTitle').textContent = isTeacherView() ? 'Class monitor' : S.mode === 'live' ? 'Your class' : 'Explore mode';
    for (const target of [$('sideBody'), $('monBody')]) { target.textContent = ''; buildPanel(target, list, now); }
    const dup = $('monBody').querySelector('h2'); if (dup && dup.textContent === $('monTitle').textContent) dup.remove();
    const students = list.filter(r => r.role === 'student' && !r.me);
    $('monBtn').textContent = isTeacherView() ? `Class monitor (${students.length})` : S.mode === 'live' ? 'Your class' : 'Your activity';
  }
  function buildPanel(t, list, now) {
    if (isTeacherView()) {
      const students = list.filter(r => r.role === 'student' && !r.me);
      const head = el('div', 'row'); head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap';
      head.append(el('h2', null, 'Class monitor'), el('span', S.mode === 'sim' ? 'chip sim' : 'chip live', S.mode === 'sim' ? 'Simulated students' : 'Live · ' + S.code));
      t.append(head);
      const stats = el('div', 'stats');
      const away = students.filter(r => !r.focus).length, hands = students.filter(r => r.hand).length;
      for (const [n, l] of [[students.length, 'Present'], [away, 'Away'], [hands, 'Hands up']]) { const s = el('div', 'stat'); s.append(el('b', null, String(n)), el('span', null, l)); stats.append(s); }
      t.append(stats);
      const ctr = el('div', 'ctrls');
      const here = roomOf(pos.x);
      const g = el('button', 'btn', 'Bring everyone here'); g.type = 'button'; g.title = 'Moves every student to the room you are in'; g.onclick = () => gatherAll(here);
      const lo = el('button', 'btn alt', 'Lower all hands'); lo.type = 'button'; lo.onclick = lowerAll; lo.disabled = !hands;
      ctr.append(g, lo);
      if (S.mode === 'live') {
        const at = el('button', 'btn alt', 'Attendance'); at.type = 'button'; at.onclick = openAttendance;
        const cp = el('button', 'btn alt', 'Copy code ' + S.code); cp.type = 'button'; cp.onclick = () => { try { navigator.clipboard.writeText(S.code).then(() => toast('Class code copied.'), () => toast('Class code: ' + S.code)); } catch (e) { toast('Class code: ' + S.code); } };
        const en = el('button', 'btn danger', 'End class'); en.type = 'button'; en.onclick = async () => { await endLiveClass(S.code); leaveSession(); toast('Class ended.'); };
        ctr.append(at, cp, en);
      }
      t.append(ctr);
      if (!students.length) t.append(el('p', 'note', S.mode === 'live' ? `No students yet. Share this page with your students (Share menu), then give them the code ${S.code}.` : 'No students.'));
      const order = r => (r.hand ? 0 : !r.focus ? 1 : 2);
      const ul = el('ul', 'roster');
      for (const r of students.sort((a, b) => order(a) - order(b) || nameOf(a).localeCompare(nameOf(b)))) ul.append(rosterRow(r, now));
      t.append(ul);
      t.append(el('p', 'note', S.mode === 'sim' ? 'These students are simulated to preview the lecturer’s view. In a live class, students see a notice saying what you can see.' : 'Students see a notice saying you can see their room, activity in this class, whether the class tab is open and raised hands.'));
    } else if (S.mode === 'live') {
      t.append(el('h2', null, 'Your class'));
      const teacher = list.find(r => r.role === 'teacher' && !r.me);
      const classmates = list.filter(r => r.role === 'student' && !r.me).length;
      t.append(el('p', 'note', teacher ? `Your lecturer is here${teacher.room ? ' (' + roomName(teacher.room) + ')' : ''}.` : 'Your lecturer hasn’t joined yet.'));
      t.append(el('p', 'note', `${classmates} classmate${classmates === 1 ? '' : 's'} in the class · code ${S.code}`));
      const h = el('button', S.hand ? 'btn' : 'btn alt', S.hand ? 'Lower my hand' : 'Raise my hand'); h.type = 'button'; h.onclick = () => setHand(!S.hand);
      t.append(h);
      const priv = el('p', 'note', 'Your lecturer can see which room you are in, what you do in this class, whether this tab is open, and if your hand is up. Nothing outside this page is shared.');
      priv.style.cssText = 'padding:8px 10px;border-radius:10px;background:rgba(242,185,94,0.12);color:var(--warn)';
      t.append(priv);
      appendMyLog(t);
    } else {
      t.append(el('h2', null, 'Explore mode'));
      t.append(el('p', 'note', 'You are exploring on your own. Uploads and drawings stay on your screen.'));
      appendMyLog(t);
    }
  }
  function rosterRow(r, now) {
    const li = el('li');
    const d = el('span', 'av'); d.style.background = colorOf(r); li.append(d);
    const who = el('div', 'who');
    who.append(el('span', 'nm', nameOf(r) + (r.sim ? ' (simulated)' : '')));
    who.append(el('span', 'act', [r.room ? roomName(r.room) : 'Joining…', r.act].filter(Boolean).join(' · ')));
    li.append(who);
    const [k, txt] = statusOf(r, now); const st = el('span', 'st ' + k, txt);
    if (k === 'hand') { st.title = 'Raised ' + ago(now - r.handAt); st.style.cursor = 'pointer'; st.onclick = () => lowerOne(r); }
    li.append(st);
    return li;
  }
  function appendMyLog(t) {
    t.append(el('h2', null, 'Your activity'));
    const ol = el('ol', 'mylog');
    for (const e of S.log.slice(0, 20)) { const li = el('li'); li.append(el('time', null, fmtTime(e.t)), el('span', null, e.text)); ol.append(li); }
    t.append(ol);
  }
  const roomName = key => ROOMS()[ROOM_KEYS.indexOf(key)] ? ROOMS()[ROOM_KEYS.indexOf(key)].name : key;
  function gatherAll(roomIdx) {
    const key = ROOM_KEYS[roomIdx];
    if (S.mode === 'sim') { for (const b of S.sim.bots) { routeTo(b, roomIdx); b.act = 'Walking to the ' + ROOMS()[roomIdx].name.toLowerCase(); } }
    else if (S.cls) S.cls.emit('gather', { room: key }).catch(() => toast('Could not reach the students. Try again.'));
    toast('Bringing everyone to the ' + ROOMS()[roomIdx].name.toLowerCase() + '.'); logMine('Brought everyone to the ' + ROOMS()[roomIdx].name.toLowerCase());
  }
  function lowerAll() {
    if (S.mode === 'sim') S.sim.bots.forEach(b => { b.hand = false; });
    else if (S.cls) S.cls.emit('lower', {}).catch(() => {});
    logMine('Lowered all hands'); scheduleMonitor();
  }
  function lowerOne(r) {
    if (S.mode === 'sim') { const b = S.sim.bots.find(x => x.key === r.key); if (b) b.hand = false; }
    else if (S.cls) S.cls.emit('lower', { peer: r.key }).catch(() => {});
    scheduleMonitor();
  }

  // ================= Avatars =================
  const avatars = new Map();
  function makeNameSprite(text, color) { const s = makeLabel(text, 0.55, avatarsGroup, color ? hexA(color, 0.9) : null); return s; }
  function hexA(hex, a) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return null; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
  function updateAvatars(list) {
    const seen = new Set();
    for (const r of list) {
      if (r.me || !Number.isFinite(r.x) || !Number.isFinite(r.z)) continue;
      seen.add(r.key);
      let a = avatars.get(r.key);
      const label = nameOf(r) + (r.role === 'teacher' ? ' (lecturer)' : '') + (r.hand ? ' ✋' : '');
      const color = colorOf(r);
      if (!a) {
        const g = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 1.1, 16), mat(color)); body.position.y = 0.55; g.add(body);
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 20, 14), mat('#C99A76')); head.position.y = 1.35; g.add(head);
        if (r.role === 'teacher') { const ring = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.035, 8, 24), mat('#F4B740')); ring.rotation.x = Math.PI / 2; ring.position.y = 1.0; g.add(ring); }
        avatarsGroup.add(g);
        a = { g, body, cur: { x: r.x, z: r.z, yaw: r.yaw }, tgt: {}, label: null, labelText: '', color };
        g.position.set(r.x, 0, r.z);
        avatars.set(r.key, a);
      }
      a.tgt = { x: r.x, z: r.z, yaw: r.yaw };
      if (a.color !== color) { a.body.material.color.set(color); a.color = color; }
      if (a.labelText !== label) { if (a.label) { avatarsGroup.remove(a.label); a.label.material.map.dispose(); a.label.material.dispose(); } a.label = makeNameSprite(label); a.labelText = label; }
      a.g.visible = true; a.label.visible = true;
    }
    for (const [k, a] of avatars) if (!seen.has(k)) { avatarsGroup.remove(a.g); disposeTree(a.g); if (a.label) { avatarsGroup.remove(a.label); a.label.material.map.dispose(); a.label.material.dispose(); } avatars.delete(k); }
  }
  function clearAvatars() { for (const [k, a] of avatars) { avatarsGroup.remove(a.g); disposeTree(a.g); if (a.label) { avatarsGroup.remove(a.label); a.label.material.dispose(); } } avatars.clear(); }
  function stepAvatars(dt) {
    if (S.mode === 'sim' && S.sim) for (const b of S.sim.bots) { const a = avatars.get(b.key); if (a) a.tgt = { x: b.x, z: b.z, yaw: b.yaw }; }
    const k = Math.min(1, dt * 8);
    for (const a of avatars.values()) {
      if (!Number.isFinite(a.tgt.x)) continue;
      a.cur.x += (a.tgt.x - a.cur.x) * k; a.cur.z += (a.tgt.z - a.cur.z) * k;
      a.g.position.set(a.cur.x, 0, a.cur.z); a.g.rotation.y = a.tgt.yaw || 0;
      if (a.label) a.label.position.set(a.cur.x, 1.85, a.cur.z);
    }
  }

  // ================= HUD =================
  let curRoom = -1;
  function setCourse(course) {
    S.course = course; W.labelsOn = false;
    B.kind = 'course'; B.pdf = null; B.images = []; B.assetIds = []; B.key = 'course'; B.name = 'Course slides'; B.page = 0; B.pages = course.slides.length;
    teacherLayer = null; wbKey = null; sg.clearRect(0, 0, 1024, 512);
    clearAvatars();
    buildWorld(course); renderBoard(); goRoom(0); curRoom = -1;
    $('hCode').textContent = course.code; $('hTitle').textContent = course.title + ': ' + course.topic;
    const nav = $('rooms'); nav.textContent = '';
    ROOMS().forEach((r, i) => { const b = el('button', null, r.name); b.type = 'button'; b.dataset.i = i; b.onclick = () => goRoom(i); nav.append(b); });
  }
  function showHud() {
    $('lobby').hidden = true;
    for (const id of ['hudTop', 'actions', 'pad', 'side']) $(id).hidden = false;
    const chips = $('hChips'); chips.textContent = '';
    if (S.mode === 'live') { chips.append(el('span', 'chip live', 'Live · ' + S.code), el('span', 'chip', S.role === 'teacher' ? 'Lecturer' : 'Student')); }
    else if (S.mode === 'sim') chips.append(el('span', 'chip sim', 'Simulated class'), el('span', 'chip', 'Lecturer view'));
    else chips.append(el('span', 'chip', 'Explore mode'));
    $('leaveBtn').textContent = S.mode === 'live' ? 'Leave class' : 'Back to courses';
    curRoom = -1; scheduleMonitor();
  }
  function leaveSession() {
    for (const u of S.unsubs) { try { u(); } catch (e) {} } S.unsubs = [];
    if (S.cls) { Promise.resolve(S.cls.leave()).catch(() => {}); S.cls = null; }
    clearInterval(S.attendTimer); S.attendTimer = 0;
    S.mode = null; S.sim = null; S.code = null; S.log = []; clearAvatars(); closeSheet();
    for (const id of ['hudTop', 'actions', 'pad', 'side']) $(id).hidden = true;
    $('lobby').hidden = false; renderLobby();
  }
  $('leaveBtn').addEventListener('click', leaveSession);
  $('monBtn').addEventListener('click', () => { openSheet('monSheet'); renderMonitor(); });
  function updateRoomPanel(force) {
    if (!S.mode) return;
    const i = roomOf(pos.x); if (i === curRoom && !force) return;
    const entered = i !== curRoom; curRoom = i;
    for (const b of $('rooms').children) b.setAttribute('aria-current', String(Number(b.dataset.i) === i));
    const r = ROOMS()[i];
    $('roomName').textContent = r.name;
    const desc = [
      B.kind === 'course' ? `Board: ${S.course.code} course slides, slide ${B.page + 1} of ${B.pages}.` : `Board: ${B.name}, slide ${B.page + 1} of ${B.pages}.`,
      'Click the model to label its parts.',
      `Ask a question about ${S.course.topic.toLowerCase()}. Answers come from the course notes.`,
      'Discuss: ' + S.course.prompt,
    ][i];
    $('roomDesc').textContent = desc;
    const row = $('roomBtns'); row.textContent = '';
    const add = (t, fn, alt) => { const b = el('button', alt ? 'btn alt' : 'btn', t); b.type = 'button'; b.onclick = fn; row.append(b); };
    if (i === 0) {
      add('View board', openBoardView, !canControlBoard());
      if (canControlBoard()) { add('◀', () => setPage(B.page - 1), true); add('▶', () => setPage(B.page + 1), true); add('Upload PDF or slides', openUpload, true); }
      else row.append(el('span', 'help', 'Your board follows the lecturer.'));
    }
    if (i === 1) { add(W.labelsOn ? 'Hide labels' : 'Label the model', () => { toggleLabels(); updateRoomPanel(true); }); if (S.course.model === 'network') add('Send a packet', sendPacket, true); }
    if (i === 2) add('Ask the library', () => openSheet('searchSheet'));
    if (i === 3) add('Open the whiteboard', () => openSheet('wbSheet'));
    if (entered) { const msg = 'Entered the ' + r.name.toLowerCase(); S.act = msg; logMine(msg); pub({ act: msg }); }
  }

  // ================= Lobby =================
  let lobbyUnsub = null, liveClasses = [];
  function renderAuth() {
    const box = $('authBox'); box.textContent = '';
    if (!BE.configured) { box.hidden = true; return; }
    box.hidden = false;
    if (!BE.signedIn) {
      box.append(el('h2', null, 'Sign in for live classes'));
      const f = el('form', 'authform'); f.noValidate = true;
      f.innerHTML = '<label>Email<input id="auEmail" type="email" autocomplete="email" required></label><label>Password<input id="auPass" type="password" autocomplete="current-password" minlength="6" required></label><label>Your name (new accounts)<input id="auName" type="text" autocomplete="name" maxlength="60"></label><div class="row"><button class="btn" type="submit" id="auIn">Sign in</button><button class="btn alt" type="button" id="auUp">Create account</button></div><p class="muted" id="auMsg" role="status"></p>';
      box.append(f);
      const msg = () => $('auMsg');
      f.addEventListener('submit', async e => {
        e.preventDefault(); msg().textContent = 'Signing in…';
        try { await BE.signIn($('auEmail').value.trim(), $('auPass').value); msg().textContent = ''; }
        catch (err) { msg().textContent = err.message === 'Invalid login credentials' ? 'That email and password don’t match an account.' : err.message; }
      });
      $('auUp').addEventListener('click', async () => {
        const email = $('auEmail').value.trim(), pass = $('auPass').value, name = $('auName').value.trim();
        if (!email || pass.length < 6 || !name) { msg().textContent = 'Enter your email, a password of at least 6 characters, and your name.'; return; }
        msg().textContent = 'Creating your account…';
        try { const r = await BE.signUp(email, pass, name); msg().textContent = r.needsConfirmation ? 'Check your email to confirm your account, then sign in.' : ''; }
        catch (err) { msg().textContent = err.message; }
      });
    } else {
      const row = el('div', 'row');
      row.append(el('span', null, 'Signed in as '), el('b', null, BE.user.name), el('span', 'chip', BE.isLecturer ? 'Lecturer' : 'Student'));
      const out = el('button', 'btn alt', 'Sign out'); out.type = 'button'; out.onclick = () => BE.signOut(); row.append(out);
      const ren = el('button', 'linkbtn', 'Change my name'); ren.type = 'button';
      ren.onclick = async () => {
        const f = el('form', 'row'); const inp = el('input'); inp.type = 'text'; inp.value = BE.user.name; inp.maxLength = 60; inp.setAttribute('aria-label', 'Your name');
        const sv = el('button', 'btn', 'Save'); sv.type = 'submit'; f.append(inp, sv); ren.replaceWith(f); inp.focus();
        f.addEventListener('submit', async e => { e.preventDefault(); const v = inp.value.trim(); if (!v) return; try { await BE.setName(v); renderLobby(); } catch (err) { toast(err.message); } });
      };
      row.append(ren);
      box.append(row);
    }
  }
  function renderLobby() {
    renderAuth();
    const st = $('status'); st.textContent = '';
    if (!cap.checked) st.append('Loading…');
    else if (!BE.configured) st.append(el('b', null, 'Demo mode. '), 'Explore every course and preview the lecturer’s monitoring view with a simulated class. Live classes turn on when this site is connected to Supabase (see the README).');
    else if (!BE.signedIn) st.append(el('b', null, 'Live classes need an account. '), 'Sign in above, or explore the courses and the simulated class without one.');
    else if (BE.isLecturer) st.append(el('b', null, 'You’re a lecturer. '), 'Start a live class from a course below, then give your students the class code.');
    else st.append(el('b', null, 'You’re joining as a student. '), 'Pick a live class or enter the code from your lecturer. In a live class your lecturer can see which room you are in, what you do in the class, whether the class tab is open, and if your hand is up.');
    const cl = $('classList'); cl.textContent = '';
    $('liveSection').hidden = !BE.configured;
    $('joinForm').hidden = !liveOK();
    if (BE.configured) {
      if (!liveOK()) cl.append(el('div', 'empty', 'Sign in to see live classes.'));
      else if (!liveClasses.length) cl.append(el('div', 'empty', BE.isLecturer ? 'No live classes right now. Start one from a course below.' : 'No live classes right now. Ask your lecturer for a class code.'));
      else for (const c of liveClasses) {
        const course = COURSES.find(x => x.id === c.course) || COURSES[0];
        const row = el('div', 'cls'); const info = el('div', 'info');
        info.append(el('span', 'code-big', c.code), el('span', null, `${course.code} · ${course.title}`), el('span', 'muted', 'Started ' + (c.startedAt ? ago(Date.now() - c.startedAt) : '')));
        row.append(el('span', 'chip live', 'Live'), info);
        const j = el('button', 'btn', BE.isLecturer ? 'Teach this class' : 'Join class'); j.type = 'button'; j.onclick = () => enterLive(c.code, c); row.append(j);
        if (BE.isLecturer && c.lecturerId === BE.user.id) { const e = el('button', 'btn danger', 'End'); e.type = 'button'; e.onclick = () => endLiveClass(c.code); row.append(e); }
        cl.append(row);
      }
    }
    const grid = $('courseGrid'); grid.textContent = '';
    for (const c of COURSES) {
      const card = el('article', 'course'); card.style.setProperty('--c', c.accent);
      card.append(el('span', 'code', c.code), el('h3', null, c.title), el('p', null, 'Topic: ' + c.topic), el('span', 'rooms-l', `Lecture hall · ${c.labName} · Library · Discussion room`));
      const row = el('div', 'row');
      const ex = el('button', 'btn alt', 'Explore'); ex.type = 'button'; ex.onclick = () => { S.mode = 'solo'; S.role = 'student'; setCourse(c); showHud(); logMine('Started exploring ' + c.code); }; row.append(ex);
      if (liveOK() && BE.isLecturer) { const s = el('button', 'btn', 'Start live class'); s.type = 'button'; s.onclick = () => startLiveClass(c); row.append(s); }
      if (!liveOK() || BE.isLecturer) { const p = el('button', 'btn alt', 'Preview with simulated class'); p.type = 'button'; p.onclick = () => startSim(c); row.append(p); }
      card.append(row); grid.append(card);
    }
  }
  $('joinForm').addEventListener('submit', e => { e.preventDefault(); joinByCode($('joinCode').value); });

  // ================= Backend start-up =================
  function watchLobby() {
    if (lobbyUnsub) { lobbyUnsub(); lobbyUnsub = null; }
    liveClasses = [];
    if (liveOK()) lobbyUnsub = BE.watchLiveClasses(list => { liveClasses = list; if (!$('lobby').hidden) renderLobby(); });
  }
  async function initBackend() {
    try { await BE.init(); } catch (e) {}
    cap.checked = true; watchLobby(); renderLobby();
    BE.onAuth(() => { if (S.mode === 'live' && !BE.signedIn) leaveSession(); watchLobby(); if (!$('lobby').hidden) renderLobby(); });
  }

  // ================= Loop =================
  function resize() { const w = stage.clientWidth || innerWidth, h = stage.clientHeight || innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  addEventListener('resize', resize); resize();
  let last = performance.now();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (S.mode && !uiBlocked()) {
      const turn = (keys['arrowleft'] || pad.l ? 1 : 0) - (keys['arrowright'] || pad.r ? 1 : 0);
      yaw += turn * 1.8 * dt;
      const fwd = (keys['w'] || keys['arrowup'] || pad.f ? 1 : 0) - (keys['s'] || keys['arrowdown'] || pad.b ? 1 : 0);
      const strafe = (keys['d'] ? 1 : 0) - (keys['a'] ? 1 : 0);
      if (fwd || strafe) { const sp = 3.2 * dt, fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw); clampMove(pos, (fx * fwd + rx * strafe) * sp, (fz * fwd + rz * strafe) * sp); }
    } else if (!S.mode && !reduce) { yaw += dt * 0.06; }
    camera.position.copy(pos); camera.rotation.set(pitch, yaw, 0);
    if (W.spin && !reduce && W.spinTargets) for (const t of W.spinTargets) t.rotation.y = W.labelsOn ? t.rotation.y * 0.9 : t.rotation.y + dt * 0.5;
    if (W.packet && W.packetT >= 0) {
      W.packetT += dt / 2.4; const t = W.packetT;
      const a = W.pcs[0], b = W.pcs[3], mid = [0, 0.1, 0.15];
      const p = t < 0.5 ? a.map((v, i) => v + (mid[i] - v) * (t / 0.5)) : mid.map((v, i) => v + (b[i] - v) * ((t - 0.5) / 0.5));
      W.packet.position.set(p[0], 0.1, p[2]);
      if (t >= 1) { W.packetT = -1; W.packet.visible = false; }
    }
    if (S.mode) { updateRoomPanel(false); pubPosition(now, false); }
    simTick(dt, Date.now());
    stepAvatars(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  // boot
  setCourse(COURSES[0]);
  pos.set(0, 1.6, 5.6);
  renderLobby();
  $('loading').remove();
  requestAnimationFrame(frame);
  initBackend();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { renderBoard(); paintBoardWB(); });
})();
