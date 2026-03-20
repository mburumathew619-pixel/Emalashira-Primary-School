// Navbar scroll effect + back-to-top visibility
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 60);
  document.getElementById('backToTop').classList.toggle('visible', window.scrollY > 400);
});

// Mobile hamburger menu
const hamburger = document.getElementById('hamburger');
const mobileMenu = document.getElementById('mobileMenu');
hamburger.addEventListener('click', () => {
  hamburger.classList.toggle('open');
  mobileMenu.classList.toggle('open');
});
mobileMenu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
  hamburger.classList.remove('open');
  mobileMenu.classList.remove('open');
}));

// Animated count-up for stats
function animateCount(el) {
  const target = +el.dataset.target, dur = 2000, t0 = performance.now();
  const tick = now => {
    const p = Math.min((now - t0) / dur, 1), e = 1 - Math.pow(1 - p, 4);
    el.textContent = Math.floor(e * target);
    if (p < 1) requestAnimationFrame(tick); else el.textContent = target;
  };
  requestAnimationFrame(tick);
}
const cObs = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { animateCount(e.target); cObs.unobserve(e.target); } });
}, { threshold: 0.5 });
document.querySelectorAll('.count-up').forEach(el => cObs.observe(el));

// Scroll fade-in for cards and elements
const fObs = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in-view'); fObs.unobserve(e.target); } });
}, { threshold: 0.08 });
document.querySelectorAll('.why-card, .prog-card, .testi-card, .lg-item, .adm-step, .ci-item, .stat-card, .club-chip, .award-item, .about-values .value-chip').forEach((el, i) => {
  el.style.transitionDelay = (i % 5) * 0.07 + 's';
  el.classList.add('fade-item');
  fObs.observe(el);
});

// Contact form submission
function submitContact(e) {
  e.preventDefault();
  const s = document.getElementById('cfSuccess');
  s.style.display = 'flex';
  e.target.reset();
  setTimeout(() => s.style.display = 'none', 6000);
}