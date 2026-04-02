// ── Cerebro shared nav ──
// Call initNav('dashboard'|'tasks'|'calendar'|'notes') once per page

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
}
