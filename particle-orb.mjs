// An original procedural particle form. The visual is decorative; loading text
// remains the accessible, authoritative request status elsewhere in the page.
const jarvisOrbControllers = new WeakMap();

export function initJarvisOrbs(root = document) {
  const previous = jarvisOrbControllers.get(root);
  if (previous) { previous.refresh(); return previous; }
  const doc = root.ownerDocument || root;
  const view = doc.defaultView || window;
  const media = view.matchMedia('(prefers-reduced-motion: reduce)');
  const states = new Map();
  let frame = null, lastFrame = 0, pending = 0, disposed = false;

  // Fixed seed keeps reloads and a reduced-motion frame visually consistent.
  let seed = 1931;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const particles = Array.from({ length: 680 }, (_, index) => {
    const around = index * Math.PI * (3 - Math.sqrt(5));
    const section = random() * Math.PI * 2;
    const tube = .18 + random() * .1;
    const ring = .54 + tube * Math.cos(section);
    return {
      x: Math.cos(around) * ring,
      y: Math.sin(section) * tube,
      z: Math.sin(around) * ring,
      size: .7 + random() * 1.4,
      tone: random(), phase: random() * Math.PI * 2
    };
  });

  function paint(state) {
    const { canvas, context, width, height, angle } = state;
    if (!width || !height) return;
    const dpr = Math.min(view.devicePixelRatio || 1, 1.75);
    const targetWidth = Math.max(1, Math.round(width * dpr));
    const targetHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth; canvas.height = targetHeight;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const centreX = width / 2, centreY = height / 2;
    const scale = Math.min(width, height) * .49;
    const glow = context.createRadialGradient(centreX, centreY, scale * .08, centreX, centreY, scale);
    glow.addColorStop(0, pending ? 'rgba(180,139,91,.13)' : 'rgba(155,117,77,.07)');
    glow.addColorStop(.6, 'rgba(137,98,65,.035)');
    glow.addColorStop(1, 'rgba(120,83,50,0)');
    context.fillStyle = glow; context.fillRect(0, 0, width, height);

    const turn = angle, tilt = .55 + Math.sin(angle * .53) * .45;
    const ca = Math.cos(turn), sa = Math.sin(turn), ct = Math.cos(tilt), st = Math.sin(tilt);
    const roll = -.55 + Math.sin(angle * .31) * .18, cr = Math.cos(roll), sr = Math.sin(roll);
    const projected = [];
    const stride = width < 90 ? 3 : 1;
    for (let index = 0; index < particles.length; index += stride) {
      const point = particles[index];
      const breathing = 1 + Math.sin(angle * .7 + point.phase) * .022;
      const x = (point.x * ca + point.z * sa) * breathing;
      const z = -point.x * sa + point.z * ca;
      const y = point.y * ct - z * st;
      const depth = point.y * st + z * ct;
      const perspective = 2.8 / (2.8 - depth);
      projected.push({ x: centreX + (x * cr - y * sr) * scale * perspective,
        y: centreY + (x * sr + y * cr) * scale * perspective,
        depth, size: point.size * perspective * Math.max(.6, Math.min(width / 300, 1.4)), tone: point.tone });
    }
    projected.sort((a, b) => a.depth - b.depth);
    for (const point of projected) {
      const front = Math.max(0, Math.min(1, (point.depth + .8) / 1.6));
      const light = .45 + front * .55;
      const red = Math.round(126 + light * 115);
      const green = Math.round(98 + light * 125);
      const blue = Math.round(74 + light * 121);
      context.fillStyle = 'rgba(' + red + ',' + green + ',' + blue + ',' + ((.22 + front * .78) * (.8 + point.tone * .2)).toFixed(3) + ')';
      context.beginPath(); context.arc(point.x, point.y, point.size * (.8 + front * .4), 0, Math.PI * 2); context.fill();
    }
    canvas.dataset.orbPainted = 'true';
  }

  function remove(canvas) {
    const state = states.get(canvas);
    if (!state) return;
    state.resize?.disconnect(); observer?.unobserve(canvas);
    canvas.dataset.orbRunning = 'false'; states.delete(canvas);
  }
  function isActive(state) {
    return state.canvas.isConnected && state.visible && state.width > 0 && state.height > 0 && !doc.hidden && !media.matches;
  }
  function reconcile() {
    if (disposed) return;
    let running = false;
    for (const [canvas, state] of states) {
      if (!canvas.isConnected) { remove(canvas); continue; }
      const active = isActive(state);
      canvas.dataset.orbRunning = String(active);
      canvas.dataset.orbBusy = String(pending > 0);
      running ||= active;
    }
    if (running && frame === null) { lastFrame = 0; frame = view.requestAnimationFrame(tick); }
    if (!running && frame !== null) { view.cancelAnimationFrame(frame); frame = null; lastFrame = 0; }
  }
  function tick(now) {
    frame = null;
    if (disposed) return;
    const elapsed = lastFrame ? now - lastFrame : 34;
    if (elapsed >= 32) {
      const delta = Math.min(elapsed, 80) / 1000;
      lastFrame = now;
      for (const state of states.values()) if (isActive(state)) {
        state.angle += delta * (pending ? .65 : .19);
        paint(state);
      }
    }
    let active = false;
    for (const [canvas, state] of states) {
      if (!canvas.isConnected) { remove(canvas); continue; }
      const running = isActive(state); canvas.dataset.orbRunning = String(running); active ||= running;
    }
    if (active) frame = view.requestAnimationFrame(tick);
  }
  const observer = typeof view.IntersectionObserver === 'function' ? new view.IntersectionObserver(entries => {
    for (const entry of entries) {
      const state = states.get(entry.target);
      if (state) state.visible = entry.isIntersecting;
    }
    reconcile();
  }, { threshold: 0 }) : null;

  function add(canvas) {
    if (states.has(canvas)) return;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return;
    canvas.setAttribute('aria-hidden', 'true');
    const state = { canvas, context, width: 0, height: 0, angle: .45, visible: true, resize: null };
    states.set(canvas, state);
    const resize = () => {
      if (!canvas.isConnected) { remove(canvas); reconcile(); return; }
      const bounds = canvas.getBoundingClientRect();
      state.width = bounds.width; state.height = bounds.height;
      if (!observer) state.visible = bounds.bottom > 0 && bounds.top < view.innerHeight && bounds.right > 0 && bounds.left < view.innerWidth;
      paint(state); reconcile();
    };
    if (typeof view.ResizeObserver === 'function') {
      state.resize = new view.ResizeObserver(resize); state.resize.observe(canvas);
    }
    resize(); observer?.observe(canvas);
  }
  function refresh() {
    if (disposed) return;
    if (root.matches?.('canvas[data-jarvis-orb]')) add(root);
    for (const canvas of root.querySelectorAll('canvas[data-jarvis-orb]')) add(canvas);
    reconcile();
  }
  function lifecycleChanged() {
    for (const state of states.values()) paint(state);
    reconcile();
  }
  function requestChanged(event) {
    if (!['start', 'end'].includes(event.detail?.stage)) return;
    pending = Math.max(0, pending + (event.detail.stage === 'start' ? 1 : -1));
    for (const state of states.values()) paint(state);
    reconcile();
  }
  const mutations = new view.MutationObserver(records => {
    let changed = false;
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (added.nodeType !== 1) continue;
        if (added.matches?.('canvas[data-jarvis-orb]') || added.querySelector?.('canvas[data-jarvis-orb]')) changed = true;
      }
    }
    for (const [canvas] of states) if (!canvas.isConnected) { remove(canvas); changed = true; }
    if (changed) refresh();
  });
  mutations.observe(doc.documentElement, { childList: true, subtree: true });
  doc.addEventListener('visibilitychange', lifecycleChanged);
  media.addEventListener('change', lifecycleChanged);
  view.addEventListener('jarvis:request', requestChanged);
  view.addEventListener('resize', lifecycleChanged);
  const api = { refresh, destroy() {
    if (disposed) return;
    disposed = true;
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    for (const canvas of [...states.keys()]) remove(canvas);
    observer?.disconnect(); mutations.disconnect();
    doc.removeEventListener('visibilitychange', lifecycleChanged);
    media.removeEventListener('change', lifecycleChanged);
    view.removeEventListener('jarvis:request', requestChanged);
    view.removeEventListener('resize', lifecycleChanged);
    jarvisOrbControllers.delete(root);
  } };
  jarvisOrbControllers.set(root, api); refresh();
  return api;
}
