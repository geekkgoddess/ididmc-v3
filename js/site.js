// ================================================================
//  Shared site JS — theme toggle, nav, footer injection
// ================================================================

// ── Theme ────────────────────────────────────────────────────────
const THEME_KEY = 'idmc-theme';

function applyTheme(theme) {
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  localStorage.setItem(THEME_KEY, theme);
  updateThemeIcon(theme);
}

function updateThemeIcon(theme) {
  const btn = document.getElementById('theme-toggle-btn');
  if (!btn) return;
  const icons = { dark: '☀️', light: '🌙', auto: '⚙️' };
  btn.textContent = icons[theme] || '☀️';
  btn.title = `Theme: ${theme} — click to toggle`;
}

function cycleTheme() {
  const current = localStorage.getItem(THEME_KEY) || 'auto';
  const order   = ['auto', 'dark', 'light'];
  const next    = order[(order.indexOf(current) + 1) % order.length];
  applyTheme(next);
}

// Apply saved theme immediately
(function() {
  const saved = localStorage.getItem(THEME_KEY) || 'auto';
  applyTheme(saved);
})();

// ── Nav injection ────────────────────────────────────────────────
function injectNav() {
  const root = document.getElementById('site-root') ? '' : '/';
  const isRoot = window.location.pathname === '/' ||
                 window.location.pathname.endsWith('index.html');

  const navHtml = `
  <nav class="site-nav" id="site-nav">
    <div class="nav-inner">
      <a href="${isRoot ? '#' : '/'}" class="nav-logo">🧹 I Did My <span>Chores</span></a>
      <ul class="nav-links">
        <li><a href="${isRoot ? '#features' : '/#features'}">Features</a></li>
        <li><a href="${isRoot ? '#pricing' : '/#pricing'}">Pricing</a></li>
        <li><a href="/pages/about.html">About</a></li>
        <li><a href="/pages/help.html">Help & SOPs</a></li>
        <li><a href="/pages/known-issues.html">Beta Updates</a></li>
        <li><a href="/pages/contact.html">Contact</a></li>
      </ul>
      <div class="nav-right">
        <button class="theme-toggle" id="theme-toggle-btn" onclick="cycleTheme()" title="Toggle theme">☀️</button>
        <a href="/login.html" class="btn btn-secondary btn-sm">Log In</a>
        <a href="/login.html?signup=true" class="btn btn-primary btn-sm">Get Started</a>
      </div>
      <button class="nav-hamburger" onclick="toggleMobileNav()" aria-label="Menu">☰</button>
    </div>
    <div id="mobile-nav" style="display:none;padding:12px 24px 20px;border-top:1px solid var(--border)">
      <a href="${isRoot ? '#features' : '/#features'}" style="display:block;padding:10px 0;font-weight:600;color:var(--text2)">Features</a>
      <a href="${isRoot ? '#pricing' : '/#pricing'}" style="display:block;padding:10px 0;font-weight:600;color:var(--text2)">Pricing</a>
      <a href="/pages/about.html" style="display:block;padding:10px 0;font-weight:600;color:var(--text2)">About</a>
      <a href="/pages/help.html" style="display:block;padding:10px 0;font-weight:600;color:var(--text2)">Help & SOPs</a>
      <a href="/pages/known-issues.html" style="display:block;padding:10px 0;font-weight:600;color:var(--text2)">Beta Updates</a>
      <a href="/pages/contact.html" style="display:block;padding:10px 0;font-weight:600;color:var(--text2)">Contact</a>
      <div style="display:flex;gap:8px;margin-top:12px">
        <a href="/login.html" class="btn btn-secondary btn-sm" style="flex:1;justify-content:center">Log In</a>
        <a href="/login.html?signup=true" class="btn btn-primary btn-sm" style="flex:1;justify-content:center">Get Started</a>
      </div>
    </div>
  </nav>`;

  document.body.insertAdjacentHTML('afterbegin', navHtml);
  updateThemeIcon(localStorage.getItem(THEME_KEY) || 'auto');
}

function toggleMobileNav() {
  const mn = document.getElementById('mobile-nav');
  if (mn) mn.style.display = mn.style.display === 'none' ? 'block' : 'none';
}

// ── Footer injection ─────────────────────────────────────────────
function injectFooter() {
  const footerHtml = `
  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-brand">
        <div class="footer-brand-name">I Did My <span>Chores</span></div>
        <p class="footer-tagline">Real money. Real accountability. Real life skills — starting at home.</p>
        <div class="footer-social" style="margin-top:16px">
          <a href="https://www.facebook.com" target="_blank" class="social-btn" title="Facebook">📘</a>
          <a href="https://www.etsy.com/shop/ShegotSheets" target="_blank" class="social-btn" title="Etsy Shop">🛍️</a>
        </div>
      </div>
      <div class="footer-links">
        <h4>Product</h4>
        <ul>
          <li><a href="/#features">Features</a></li>
          <li><a href="/#pricing">Pricing</a></li>
          <li><a href="/#how-it-works">How It Works</a></li>
          <li><a href="/pages/help.html">Help & SOPs</a></li>
          <li><a href="/pages/known-issues.html">Beta Updates</a></li>
          <li><a href="/login.html?signup=true">Get Started</a></li>
        </ul>
      </div>
      <div class="footer-links">
        <h4>Company</h4>
        <ul>
          <li><a href="/pages/about.html">About</a></li>
          <li><a href="/pages/help.html">Help & SOPs</a></li>
          <li><a href="/pages/contact.html">Contact</a></li>
          <li><a href="/pages/privacy.html">Privacy Policy</a></li>
          <li><a href="/pages/terms.html">Terms of Service</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span class="footer-copy">© ${new Date().getFullYear()} I Did My Chores · A She Got Sheets product by Joanna Hodge</span>
      <span class="footer-copy">Made with ❤️ in Jacksonville, FL</span>
    </div>
  </footer>`;
  document.body.insertAdjacentHTML('beforeend', footerHtml);
}

// Auto-run on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  injectNav();
  injectFooter();
});
