// The build replaces this token with the unchanged crest from assets/repton/.
const reptonCrestDataUrl = '__REPTON_CREST_DATA_URL__';

export function initReptonBranding(root = document) {
  const doc = root.ownerDocument || root;
  const shell = root.matches?.('.jc-shell') ? root : root.querySelector('.jc-shell');
  if (!shell || shell.dataset.reptonBranding === 'true') return;
  shell.dataset.reptonBranding = 'true';

  const crest = className => {
    const img = doc.createElement('img');
    img.src = reptonCrestDataUrl;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.className = 'jr-repton-crest ' + className;
    img.width = 32; img.height = 47;
    img.decoding = 'async';
    return img;
  };
  const privateBrand = shell.querySelector('.bw-brand');
  if (privateBrand) {
    privateBrand.setAttribute('aria-label', 'Jarvis · Repton Dubai · Fry House');
    const slot = privateBrand.querySelector('.bw-mark');
    if (slot) { slot.classList.add('jr-header-crest'); slot.replaceChildren(crest('')); }
  }
  const publicBrand = shell.querySelector('.jl-public-brand');
  if (publicBrand) {
    publicBrand.setAttribute('aria-label', 'Jarvis home · Repton Dubai · Fry House');
    const slot = publicBrand.querySelector('.jl-brand-dot');
    if (slot) { slot.classList.add('jr-header-crest'); slot.replaceChildren(crest('')); }
  }
  const heroLabel = shell.querySelector('.jc-core-caption, .jl-public-intro > .jl-eyebrow');
  if (heroLabel) {
    heroLabel.classList.add('jr-identity-line');
    heroLabel.prepend(crest('jr-identity-crest'));
  }
  const screens = ['calendar', 'goals', 'academic', 'pastoral', 'study', 'house', 'wellbeing', 'programme'];
  for (const name of screens) {
    const screen = shell.querySelector('[data-screen="' + name + '"]');
    if (!screen) continue;
    const identity = doc.createElement('div');
    identity.className = 'jr-section-brand';
    const label = doc.createElement('span');
    label.textContent = 'Repton Dubai · Fry House';
    identity.append(crest('jr-section-crest'), label);
    screen.prepend(identity);
  }
  const privateFooter = shell.querySelector('.bw-footer');
  if (privateFooter) {
    const signature = doc.createElement('span');
    signature.className = 'jr-footer-brand';
    const label = doc.createElement('span');
    label.textContent = 'Repton Dubai · Fry House';
    signature.append(crest('jr-footer-crest'), label);
    privateFooter.append(signature);
  }
  const publicFooter = shell.querySelector('.jl-public-footer > span');
  if (publicFooter) {
    publicFooter.classList.add('jr-footer-brand');
    publicFooter.prepend(crest('jr-footer-crest'));
  }
}
