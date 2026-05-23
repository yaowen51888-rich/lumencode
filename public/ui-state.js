import { ID } from './config.js';

export function showSkeleton() {
  document.querySelectorAll('.card-value').forEach(el => {
    if (!el.classList.contains('skeleton')) {
      el._origText = el.textContent;
      el.textContent = '';
      el.classList.add('skeleton');
    }
  });

  document.querySelectorAll('.chart-wrap').forEach(el => {
    if (!el.querySelector('.chart-skeleton')) {
      const overlay = document.createElement('div');
      overlay.className = 'chart-skeleton';
      overlay.innerHTML = '<div class="chart-skeleton-bar"></div><div class="chart-skeleton-bar"></div><div class="chart-skeleton-bar"></div><div class="chart-skeleton-bar"></div><div class="chart-skeleton-bar"></div>';
      el.appendChild(overlay);
    }
  });

  const gitSection = document.getElementById(ID.GIT_SECTION);
  if (gitSection && gitSection.style.display !== 'none') {
    const gitStatsEl = document.getElementById(ID.GIT_STATS);
    if (gitStatsEl) {
      gitStatsEl.innerHTML = `
        <div class="git-skeleton-grid">
          <div><div class="skeleton" style="height:28px;width:60px;margin:0 auto 6px;border-radius:6px;"></div><div class="skeleton" style="height:14px;width:48px;margin:0 auto;border-radius:4px;"></div></div>
          <div><div class="skeleton" style="height:28px;width:60px;margin:0 auto 6px;border-radius:6px;"></div><div class="skeleton" style="height:14px;width:48px;margin:0 auto;border-radius:4px;"></div></div>
          <div><div class="skeleton" style="height:28px;width:60px;margin:0 auto 6px;border-radius:6px;"></div><div class="skeleton" style="height:14px;width:48px;margin:0 auto;border-radius:4px;"></div></div>
          <div><div class="skeleton" style="height:28px;width:60px;margin:0 auto 6px;border-radius:6px;"></div><div class="skeleton" style="height:14px;width:48px;margin:0 auto;border-radius:4px;"></div></div>
        </div>`;
    }
    const gitAiStats = document.getElementById(ID.GIT_AI_STATS);
    if (gitAiStats) {
      gitAiStats.innerHTML = `
        <div class="git-skeleton-grid" style="grid-template-columns:repeat(3,1fr);padding-top:14px;margin-top:14px;border-top:1px dashed var(--hairline);">
          <div><div class="skeleton" style="height:28px;width:50px;margin:0 auto 6px;border-radius:6px;"></div><div class="skeleton" style="height:14px;width:80px;margin:0 auto;border-radius:4px;"></div></div>
          <div><div class="skeleton" style="height:28px;width:50px;margin:0 auto 6px;border-radius:6px;"></div><div class="skeleton" style="height:14px;width:80px;margin:0 auto;border-radius:4px;"></div></div>
          <div><div class="skeleton" style="height:28px;width:50px;margin:0 auto 6px;border-radius:6px;"></div><div class="skeleton" style="height:14px;width:80px;margin:0 auto;border-radius:4px;"></div></div>
        </div>`;
    }
    const gitInsightsRow = document.getElementById(ID.GIT_INSIGHTS_ROW);
    if (gitInsightsRow) gitInsightsRow.style.display = 'none';
  }
}

export function hideSkeleton() {
  document.querySelectorAll('.card-value.skeleton').forEach(el => el.classList.remove('skeleton'));
  document.querySelectorAll('.chart-skeleton').forEach(el => el.remove());
}

export function showError(msg) {
  const toast = document.getElementById(ID.TOAST);
  if (!toast) return;
  toast.textContent = msg;
  toast.style.display = 'block';
  toast.style.opacity = '1';
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => { toast.style.display = 'none'; }, 300);
  }, 3000);
}

export function hideError() {
  const toast = document.getElementById(ID.TOAST);
  if (toast) toast.style.display = 'none';
}

export function showEmpty() {
  document.querySelectorAll('.card-value').forEach(el => el.textContent = '-');
  document.getElementById(ID.STATS_GRID).style.display = 'none';
  document.getElementById(ID.ANALYTICS_SECTION).style.display = 'none';
  document.getElementById(ID.TREND_SECTION).style.display = 'none';
  document.getElementById(ID.GIT_SECTION).style.display = 'none';
  const wp = document.getElementById(ID.WELCOME_PAGE);
  if (wp) wp.style.display = 'flex';
  [ID.EXPORT_CSV_BTN, ID.PRINT_BTN, ID.WORK_REPORT_BTN].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

export function hideEmpty() {
  const wp = document.getElementById(ID.WELCOME_PAGE);
  if (wp) wp.style.display = 'none';
  document.getElementById(ID.STATS_GRID).style.display = 'grid';
  document.getElementById(ID.ANALYTICS_SECTION).style.display = 'block';
  [ID.EXPORT_CSV_BTN, ID.PRINT_BTN, ID.WORK_REPORT_BTN].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  });
}

export function clearReportUI(destroyChart) {
  document.querySelectorAll('.card-value').forEach(el => el.textContent = '-');
  document.querySelectorAll('.card-trend').forEach(el => el.textContent = '');
  document.getElementById(ID.ANALYTICS_SECTION).style.display = 'block';
  document.getElementById(ID.NO_DATA_HINT).style.display = 'block';
  document.getElementById(ID.CHARTS_DASHBOARD).style.display = 'none';
  document.getElementById(ID.TREND_SECTION).style.display = 'none';
  document.getElementById(ID.GIT_SECTION).style.display = 'none';
  [ID.SCENARIO_CHART, ID.MODEL_CHART, ID.PROJECT_CHART, ID.TOOL_CHART].forEach(destroyChart);
}
