// ── Cerebro shared nav ──
// Call initNav('dashboard'|'tasks'|'calendar'|'notes'|'saves') once per page

export function initNav(activePage) {
  // Update date
  const dateEl = document.getElementById('nav-date');
  if (dateEl) {
    const now = new Date();
    dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  // Mark active desktop nav link
  document.querySelectorAll('.nav-links a').forEach(a => {
    a.classList.toggle('active', a.dataset.page === activePage);
  });

  // Mark active mobile nav link
  document.querySelectorAll('#mobile-bottom-nav a').forEach(a => {
    a.classList.toggle('active', a.dataset.page === activePage);
  });

  // Hamburger toggle
  const menuBtn = document.getElementById('mobile-menu-btn');
  const nav     = document.getElementById('app-nav');
  if (menuBtn && nav) {
    menuBtn.addEventListener('click', () => nav.classList.toggle('nav-open'));
    // Close when a link is tapped
    nav.querySelectorAll('.nav-links a').forEach(a => {
      a.addEventListener('click', () => nav.classList.remove('nav-open'));
    });
    // Close when tapping outside
    document.addEventListener('click', e => {
      if (!nav.contains(e.target)) nav.classList.remove('nav-open');
    });
  }
}
